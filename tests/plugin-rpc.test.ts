import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaSnapshot } from "../src/core/types.js";
import {
  messageDocument,
  type ReportDocument,
  renderPlainTextReport,
} from "../src/lib/report-document.js";
import type { DEFAULT_CONFIG } from "../src/lib/types.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

// Unique per run: other checkouts run this file at the same time.
const TEST_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "opencode-quota-plugin-rpc-"));
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
  reconcileDetectedProvidersInGlobalConfig: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);
vi.mock("../src/lib/opencode-config-providers.js", () => ({
  reconcileDetectedProvidersInGlobalConfig: mocks.reconcileDetectedProvidersInGlobalConfig,
}));

type Handler = (input: unknown, context: unknown) => Promise<unknown>;
type RegisteredCommand = {
  name: string;
  execute: (invocation: { sessionID: string; prompt: { text: string } }) => Promise<void>;
};

const callContext = {
  signal: new AbortController().signal,
  error: (type: string, message: string, data?: unknown) => ({ type, message, data }),
};

function useConfig(overrides: Partial<typeof DEFAULT_CONFIG>): void {
  mocks.loadConfig.mockResolvedValue(
    makeQuotaToastTestConfig({
      enabled: true,
      enabledProviders: ["copilot"],
      minIntervalMs: 0,
      showSessionTokens: false,
      maintainerAnnouncements: { enabled: false, home: false },
      ...overrides,
    }),
  );
}

const SNAPSHOT_FILE = `${TEST_RUNTIME_ROOT}/state/opencode-quota/snapshot-v6.json`;

type ServerEvent = { type: string };

async function setupServer(
  sessionGet = vi.fn().mockResolvedValue({}),
  directory = process.cwd(),
  events: AsyncIterable<ServerEvent> = { async *[Symbol.asyncIterator]() {} },
) {
  const { default: server } = await import("../src/plugin.js");
  const emit = vi.fn(async (_name: string, _data: unknown) => {});
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit } }));
  const commands: RegisteredCommand[] = [];
  const ctx = {
    location: { directory },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "copilot" }] }) },
    session: { get: sessionGet, wait: vi.fn(), prompt: vi.fn(), hook: vi.fn() },
    tool: { transform: vi.fn() },
    command: {
      transform: vi.fn(async (callback) => {
        callback({ add: (command: RegisteredCommand) => commands.push(command) });
      }),
    },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => events },
  };
  await server.setup(ctx as never);
  expect(register).toHaveBeenCalledOnce();
  const [definition, handlers] = register.mock.calls[0] as unknown as [
    { id: string; methods: Record<string, unknown> },
    Record<string, Handler>,
  ];
  const call = async (method: string, input: unknown) => {
    const output = await handlers[method](input, callContext);
    // Outputs travel over HTTP to every client; they must never carry login secrets.
    expect(JSON.stringify(output)).not.toMatch(/"(access|refresh|apiKey)"/);
    // OpenCode's RPC route rejects any output that is not a JSON value (HTTP 400), so an
    // undefined field or a non-finite number must never reach it.
    expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)));
    return output;
  };
  return { ctx, definition, handlers, commands, call, emit };
}

describe("server quota RPC", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
          errors: [],
        }),
      },
    ]);
    mocks.reconcileDetectedProvidersInGlobalConfig.mockResolvedValue({ changed: false });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("registers the quota RPC with its four methods during setup", async () => {
    const { QuotaRpc } = await import("../src/rpc.js");
    const { definition, handlers } = await setupServer();

    expect(definition).toBe(QuotaRpc);
    expect(definition.id).toBe("slkiser.opencode-quota");
    expect(Object.keys(definition.methods)).toEqual(["command", "snapshot", "refresh", "notices"]);
    expect(Object.keys(handlers)).toEqual(Object.keys(definition.methods));
  });

  it("asks no provider and reads no snapshot file during setup", async () => {
    useConfig({});
    const fetch = vi.fn();
    mocks.getProviders.mockReturnValue([
      { id: "copilot", isAvailable: vi.fn().mockResolvedValue(true), fetch },
    ]);
    await setupServer();

    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(SNAPSHOT_FILE)).toBe(false);
  });

  it("serves v6 rows from the store, saves them and emits changed", async () => {
    // A long interval: the snapshot call below answers from memory without a new fetch.
    useConfig({ minIntervalMs: 60_000 });
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Copilot Premium Requests",
              group: "Copilot (pro)",
              label: "Quota:",
              right: "60/300",
              percentRemaining: 80,
              resetTimeIso: "2026-11-01T00:00:00.000Z",
            },
          ],
          errors: [],
        }),
      },
    ]);
    const { call, emit } = await setupServer();

    const refreshed = (await call("refresh", { reason: "manual" })) as { snapshot: QuotaSnapshot };
    expect(refreshed.snapshot.providers).toEqual([
      expect.objectContaining({
        providerId: "copilot",
        label: "Copilot",
        refreshing: false,
        rows: [
          {
            id: "copilot.allowance",
            providerId: "copilot",
            account: "pro",
            label: "Premium requests",
            type: "quota",
            method: "remote_api",
            authority: "provider_reported",
            window: "month",
            prominence: "primary",
            percentRemaining: 80,
            used: { decimal: "60", unit: { kind: "count", unit: "unit" } },
            limit: { decimal: "300", unit: { kind: "count", unit: "unit" } },
            resetsAt: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(refreshed.snapshot).not.toHaveProperty("currentModelProviderIds");
    expect(emit).toHaveBeenCalledWith("changed", {
      snapshot: expect.objectContaining({ version: 6 }),
    });

    const saved = JSON.parse(await readFile(SNAPSHOT_FILE, "utf8")) as {
      entries: Record<string, { rows: unknown[] }>;
    };
    expect(Object.values(saved.entries).map((entry) => entry.rows)).toEqual([
      refreshed.snapshot.providers[0]?.rows,
    ]);

    const instant = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(instant.snapshot.providers[0]?.rows).toEqual(refreshed.snapshot.providers[0]?.rows);
  });

  it("names the providers of the session's model in the snapshot", async () => {
    useConfig({ enabledProviders: ["copilot", "openai"] });
    mocks.getProviders.mockReturnValue(
      ["copilot", "openai"].map((id) => ({
        id,
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({ attempted: true, entries: [], errors: [] }),
      })),
    );
    const sessionGet = vi.fn().mockResolvedValue({
      model: { id: "gpt-5", providerID: "openai" },
    });
    const { call } = await setupServer(sessionGet);

    const output = (await call("snapshot", { sessionID: "session-1" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(output.snapshot.providers.map((provider) => provider.providerId)).toEqual([
      "copilot",
      "openai",
    ]);
    expect(output.snapshot.currentModelProviderIds).toEqual(["openai"]);
  });

  it("checks who each provider is signed in as after a login change", async () => {
    useConfig({ minIntervalMs: 60_000 });
    let account = "alice";
    const fetch = vi.fn(async () => ({
      attempted: true,
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Copilot Premium Requests",
          group: `Copilot (${account})`,
          label: "Quota:",
          percentRemaining: 50,
        },
      ],
      errors: [],
    }));
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "resolved-auth", resolveIdentity: async () => account },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch,
      },
    ]);
    let sendLoginChange: () => void = () => {};
    const loginChanged = new Promise<void>((resolve) => {
      sendLoginChange = resolve;
    });
    const events = {
      async *[Symbol.asyncIterator]() {
        await loginChanged;
        yield { type: "credential.switched" };
      },
    };
    const { call, emit } = await setupServer(undefined, process.cwd(), events);
    await call("refresh", { reason: "manual" });
    emit.mockClear();

    account = "bob";
    sendLoginChange();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const last = emit.mock.lastCall?.[1] as { snapshot: QuotaSnapshot };
    expect(last.snapshot.providers[0]?.rows.map((row) => row.account)).toEqual(["bob"]);
    // Nothing is due; this only waits for the snapshot file write before the folder goes.
    await call("refresh", { reason: "poll" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("adds the session's tokens to a session snapshot", async () => {
    useConfig({ sessionTokenScope: "tree" });
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: { models: [], totalInput: 1200, totalCachedInput: 300, totalOutput: 80 },
    });
    const { call } = await setupServer();

    const session = (await call("snapshot", { sessionID: "session-1" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(session.snapshot.sessionTokens).toEqual({ input: 1200, cachedInput: 300, output: 80 });
    expect(mocks.fetchSessionTokensForDisplay).toHaveBeenCalledWith({
      enabled: true,
      sessionID: "session-1",
      scope: "tree",
    });
    const global = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(global.snapshot).not.toHaveProperty("sessionTokens");
  });

  it("serves the Home notice line only when the Home notice is on", async () => {
    const { formatMaintainerAnnouncementHomeCountLine, getMaintainerAnnouncementsSummary } =
      await import("../src/lib/maintainer-announcements.js");
    const expected = formatMaintainerAnnouncementHomeCountLine(
      getMaintainerAnnouncementsSummary({ enabledProviders: ["copilot"] }).activeCount,
    );
    useConfig({ maintainerAnnouncements: { enabled: true, home: true, homeFrequency: "always" } });
    await expect((await setupServer()).call("notices", {})).resolves.toEqual({
      homeLine: expected,
    });

    useConfig({ maintainerAnnouncements: { enabled: true, home: false } });
    await expect((await setupServer()).call("notices", {})).resolves.toEqual({ homeLine: "" });
  });

  it("writes the export file from each new snapshot only when the export is enabled", async () => {
    const exportPath = `${TEST_RUNTIME_ROOT}/quota-export.json`;
    useConfig({ export: { enabled: false, path: exportPath } });
    const disabled = await setupServer();
    await disabled.call("refresh", { reason: "manual" });
    await vi.waitFor(() => expect(disabled.emit).toHaveBeenCalled());
    expect(existsSync(exportPath)).toBe(false);

    useConfig({ export: { enabled: true, path: exportPath } });
    const enabled = await setupServer();
    await enabled.call("refresh", { reason: "manual" });
    await vi.waitFor(() => expect(existsSync(exportPath)).toBe(true));
    const exported = JSON.parse(await readFile(exportPath, "utf8"));
    expect(exported).toMatchObject({
      version: 2,
      fromCache: true,
      providers: { copilot: { status: "ok", entries: [{ name: "Copilot Plan" }] } },
    });
  });

  it("runs palette commands on the server and returns their output", async () => {
    useConfig({});
    const { call } = await setupServer();

    const output = (await call("command", { command: "quota", sessionID: "session-1" })) as {
      output: string;
      document: ReportDocument;
    };
    expect(output).toEqual(
      expect.objectContaining({
        state: "output",
        command: "quota",
        title: "OpenCode Quota",
        dialogSize: "xlarge",
      }),
    );
    expect(output.output).toContain("Copilot");
    expect(renderPlainTextReport(output.document)).toBe(output.output);
  });

  it("never writes detected providers to the global config from the palette", async () => {
    useConfig({ enabledProviders: "auto" });
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockImplementation(async (params) => {
      await params.onDetectedProviderIds?.(["copilot"]);
      return {
        state: "output",
        command: params.command,
        title: "OpenCode Quota Status",
        output: "status",
        document: messageDocument("status"),
        dialogSize: "xlarge",
      };
    });
    const { call, commands } = await setupServer();

    await call("command", { command: "quota_status", sessionID: "session-1" });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).not.toHaveBeenCalled();

    const slash = commands.find((command) => command.name === "quota_status");
    await slash?.execute({ sessionID: "session-1", prompt: { text: "" } });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: process.cwd(),
      detectedProviderIds: ["copilot"],
    });
  });

  it("returns a failed palette command as output instead of an RPC error", async () => {
    useConfig({});
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockRejectedValue(
      new Error("quota \u001b[31mbroke"),
    );
    const { call } = await setupServer();

    await expect(call("command", { command: "quota" })).resolves.toEqual({
      state: "output",
      command: "quota",
      title: "OpenCode Quota",
      output: "quota broke",
      document: messageDocument("quota broke"),
      dialogSize: "xlarge",
    });
  });

  it("treats a session the server cannot find as a session without a model", async () => {
    useConfig({});
    const sessionGet = vi.fn().mockRejectedValue(new Error("Session not found"));
    const { call } = await setupServer(sessionGet);

    const output = (await call("snapshot", { sessionID: "missing" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(output.snapshot).not.toHaveProperty("currentModelProviderIds");
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "missing" });
  });

  it("computes quota for the location's project folder, not the service's working folder", async () => {
    useConfig({});
    const workspaceRoots: string[] = [];
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn(async (ctx: { workspaceRoot: string }) => {
          workspaceRoots.push(ctx.workspaceRoot);
          return {
            attempted: true,
            entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
            errors: [],
          };
        }),
      },
    ]);
    const project = `${TEST_RUNTIME_ROOT}/project`;
    const { call } = await setupServer(undefined, project);

    await call("refresh", { reason: "manual" });
    await call("command", { command: "quota", sessionID: "session-1" });

    expect(workspaceRoots).toHaveLength(2);
    expect(new Set(workspaceRoots)).toEqual(new Set([project]));
    expect(project).not.toBe(process.cwd());
  });

  it("logs why a snapshot or notices RPC failed, without tokens, and still fails it", async () => {
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    mocks.loadConfig.mockRejectedValue(new Error(`config broke ${token}`));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = await setupServer();

    for (const [method, input] of [
      ["snapshot", { sessionID: "session-1" }],
      ["notices", {}],
    ] as const) {
      await expect(handlers[method](input, callContext)).rejects.toThrow("config broke");
      expect(warn).toHaveBeenLastCalledWith(
        `[opencode-quota] ${method} RPC failed: config broke [redacted]`,
      );
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });
});
