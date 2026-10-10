import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
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
import { writeSessionDatabase } from "./helpers/session-database.js";

// A fresh folder per run, so test runs in sibling checkouts never share it.
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
// Price lookups stay real (bundled price list) for the usage report; refreshes are faked.
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  ...createPricingModuleMock(mocks),
}));
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

/** Each server's cleanup; run after every test, before its folder goes. */
const cleanups: Array<() => unknown> = [];

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
  const cleanup = await server.setup(ctx as never);
  if (typeof cleanup === "function") cleanups.push(cleanup);
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
  return { ctx, definition, handlers, commands, call, emit, cleanup };
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
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    // Stops each server's store and waits for its fetches and writes.
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("registers the quota RPC with its seven methods during setup", async () => {
    const { QuotaRpc } = await import("../src/rpc.js");
    const { definition, handlers } = await setupServer();

    expect(definition).toBe(QuotaRpc);
    expect(definition.id).toBe("slkiser.opencode-quota");
    expect(Object.keys(definition.methods)).toEqual([
      "surface",
      "footer",
      "writeExport",
      "command",
      "snapshot",
      "refresh",
      "usage",
    ]);
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

  it("reports usage from OpenCode's history over the usage method", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "opencode-quota-usage-rpc-"));
    onTestFinished(() => rm(databaseDir, { recursive: true, force: true }));
    const databasePath = join(databaseDir, "opencode.db");
    vi.stubEnv("OPENCODE_DB", databasePath);
    const now = Date.now();
    writeSessionDatabase(databasePath, {
      sessions: [
        { id: "ses_root", created: now - 120_000 },
        { id: "ses_subagent", parentID: "ses_root", created: now - 90_000 },
      ],
      messages: [
        {
          id: "msg_1",
          sessionID: "ses_root",
          created: now - 60_000,
          completed: now - 59_000,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          tokens: { input: 1_000 },
        },
        {
          id: "msg_2",
          sessionID: "ses_subagent",
          created: now - 30_000,
          completed: now - 29_000,
          providerID: "acme",
          modelID: "mystery-1",
          tokens: { output: 500 },
        },
      ],
    });
    const { call } = await setupServer();

    const today = (await call("usage", { range: "today" })) as { report: UsageReport };
    expect(today.report.totals).toMatchObject({ sessions: 1, unpricedTokens: 500 });
    expect(today.report.totals.costUsd).toBeGreaterThan(0);
    expect(today.report.models.map((model) => [model.modelID, model.priced])).toEqual([
      ["claude-sonnet-4-5", true],
      ["mystery-1", false],
    ]);

    const session = (await call("usage", { range: "session", sessionID: "ses_root" })) as {
      report: UsageReport;
    };
    expect(session.report.sessionID).toBe("ses_root");
    expect(session.report.totals.tokens.processed).toBe(1_000);
    const tree = (await call("usage", { range: "session_tree", sessionID: "ses_root" })) as {
      report: UsageReport;
    };
    expect(tree.report.totals.tokens.processed).toBe(1_500);
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
            used: { decimal: "60", unit: { kind: "count", unit: "request" } },
            limit: { decimal: "300", unit: { kind: "count", unit: "request" } },
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
      entries: Record<string, { rows: Array<{ login: string; row: unknown }> }>;
    };
    expect(Object.values(saved.entries).map((entry) => entry.rows.map((item) => item.row))).toEqual(
      [refreshed.snapshot.providers[0]?.rows],
    );

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
    // The providers and the model's providers come from one settings read.
    expect(mocks.loadConfig).toHaveBeenCalledOnce();
  });

  it("waits for the store's running fetch and file write when the plugin is cleaned up", async () => {
    useConfig({});
    let answer: (result: unknown) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch,
      },
    ]);
    const { call, cleanup } = await setupServer();
    await call("snapshot", {});
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    let done = false;
    const cleaning = Promise.resolve(cleanup()).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    answer({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 70 }],
      errors: [],
    });
    await cleaning;
    expect(existsSync(SNAPSHOT_FILE)).toBe(true);
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
    await vi.waitFor(() => {
      const last = emit.mock.lastCall?.[1] as { snapshot: QuotaSnapshot };
      expect(last.snapshot.providers[0]?.rows.map((row) => row.account)).toEqual(["bob"]);
    });
  });

  it("serves the sidebar panel and the idle toast", async () => {
    useConfig({ enableToast: true, showOnIdle: true, toastDurationMs: 7000 });
    const { call } = await setupServer();

    const sidebar = (await call("surface", { surface: "sidebar", sessionID: "session-1" })) as {
      quota: { message: string };
    };
    expect(sidebar).toEqual({
      quota: expect.objectContaining({ duration: 7000, activeProviderCount: 1 }),
    });
    expect(sidebar.quota.message).toContain("Copilot");

    const idle = (await call("surface", { surface: "idle", sessionID: "session-1" })) as {
      quota: { message: string };
    };
    expect(idle).toEqual({
      quota: expect.objectContaining({ duration: 7000, activeProviderCount: 1 }),
    });
    expect(idle.quota.message).toContain("Copilot");
  });

  it("returns a null quota when the surface is turned off", async () => {
    useConfig({ enableToast: true, showOnIdle: false });
    const { call } = await setupServer();

    await expect(call("surface", { surface: "idle", sessionID: "session-1" })).resolves.toEqual({
      quota: null,
    });
  });

  it("serves the session prompt line and the Home compact line", async () => {
    useConfig({
      tuiPromptBar: { enabled: true },
      tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: false, maxWidth: 96 },
    });
    const { call } = await setupServer();

    const prompt = (await call("footer", { surface: "prompt", sessionID: "session-1" })) as {
      lines: string[];
    };
    expect(prompt.lines).toHaveLength(1);
    expect(prompt.lines[0]).toContain("Copilot");
    await expect(call("footer", { surface: "prompt" })).resolves.toEqual({ lines: [] });

    const home = (await call("footer", { surface: "home" })) as { lines: string[] };
    expect(home.lines).toHaveLength(1);
    expect(home.lines[0]).toContain("Copilot");
  });

  it("writes the export file only when the export is enabled", async () => {
    const exportPath = `${TEST_RUNTIME_ROOT}/quota-export.json`;
    useConfig({ export: { enabled: false, path: exportPath } });
    const disabled = await setupServer();
    await expect(disabled.call("writeExport", {})).resolves.toEqual({ written: false });
    expect(existsSync(exportPath)).toBe(false);

    useConfig({ export: { enabled: true, path: exportPath } });
    const enabled = await setupServer();
    await expect(enabled.call("writeExport", {})).resolves.toEqual({ written: true });
    expect(existsSync(exportPath)).toBe(true);
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
    useConfig({ onlyCurrentModel: true });
    const input = { surface: "sidebar", sessionID: "missing" };
    const withoutModel = await setupServer(vi.fn().mockResolvedValue({}));
    const expected = await withoutModel.call("surface", input);
    const sessionGet = vi.fn().mockRejectedValue(new Error("Session not found"));
    const missing = await setupServer(sessionGet);

    await expect(missing.call("surface", input)).resolves.toEqual(expected);
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "missing" });
  });

  it("computes quota for the location's project folder, not the service's working folder", async () => {
    useConfig({
      tuiCompactStatus: { enabled: true, homeBottom: true, sessionPrompt: false, maxWidth: 96 },
    });
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

    await call("surface", { surface: "sidebar", sessionID: "session-1" });
    await call("footer", { surface: "home" });
    await call("command", { command: "quota", sessionID: "session-1" });

    expect(workspaceRoots).toHaveLength(3);
    expect(new Set(workspaceRoots)).toEqual(new Set([project]));
    expect(project).not.toBe(process.cwd());
  });

  it("logs why a surface, footer or export RPC failed, without tokens, and still fails it", async () => {
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    mocks.loadConfig.mockRejectedValue(new Error(`config broke ${token}`));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = await setupServer();

    for (const [method, input] of [
      ["surface", { surface: "sidebar", sessionID: "session-1" }],
      ["footer", { surface: "home" }],
      ["writeExport", {}],
    ] as const) {
      await expect(handlers[method](input, callContext)).rejects.toThrow("config broke");
      expect(warn).toHaveBeenLastCalledWith(
        `[opencode-quota] ${method} RPC failed: config broke [redacted]`,
      );
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });
});
