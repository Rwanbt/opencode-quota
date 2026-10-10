import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import { messageDocument, type ReportDocument } from "../src/lib/report-document.js";
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
// Price lookups and the price list choice stay real for the usage report; refreshes are faked.
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>();
  return {
    ...actual,
    ...createPricingModuleMock(mocks),
    setPricingSnapshotAutoRefresh: actual.setPricingSnapshotAutoRefresh,
    setPricingSnapshotSelection: actual.setPricingSnapshotSelection,
  };
});
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
const SETTINGS_FILE = `${TEST_RUNTIME_ROOT}/config/opencode-quota/settings.jsonc`;

/** Writes settings.jsonc, so the server reads it instead of converting the v5 settings. */
async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(`${TEST_RUNTIME_ROOT}/config/opencode-quota`, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify({ version: 6, ...settings }));
}

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
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    // Stops each server's store and waits for its fetches and writes.
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("registers the quota RPC with its seven methods during setup", async () => {
    const { QuotaRpc } = await import("../src/rpc.js");
    const { definition, handlers } = await setupServer();

    expect(definition).toBe(QuotaRpc);
    expect(definition.id).toBe("slkiser.opencode-quota");
    expect(Object.keys(definition.methods)).toEqual([
      "command",
      "snapshot",
      "refresh",
      "notices",
      "noticeList",
      "status",
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
    useConfig({ pricingSnapshot: { source: "bundled", autoRefresh: 3 } });
    const { call } = await setupServer();

    const today = (await call("usage", { range: "today" })) as { report: UsageReport };
    // The report used the configured price list.
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    expect(pricing.getPricingSnapshotSelection()).toBe("bundled");
    expect(pricing.getPricingRefreshPolicy().maxAgeMs).toBe(3 * 24 * 60 * 60 * 1000);
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
    // Later settings reads (the session's tokens) see OpenAI turned off; the model's
    // providers must still come from the read the snapshot's providers came from.
    useConfig({ enabledProviders: ["copilot"] });
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: true,
        enabledProviders: ["copilot", "openai"],
        minIntervalMs: 0,
        showSessionTokens: false,
        maintainerAnnouncements: { enabled: false, home: false },
      }),
    );
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
    const { BUNDLED_MAINTAINER_ANNOUNCEMENTS, getMaintainerAnnouncementsSummary } = await import(
      "../src/lib/maintainer-announcements.js"
    );
    const active = getMaintainerAnnouncementsSummary({
      enabledProviders: ["copilot"],
      announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
    }).activeCount;
    const expected =
      active === 0
        ? ""
        : `Notice: ${active} unread maintainer ${active === 1 ? "notice" : "notices"}, see /quota → Notices.`;
    useConfig({});
    await writeSettings({ announcements: { homeFrequency: "always" } });
    await expect((await setupServer()).call("notices", {})).resolves.toEqual({
      homeLine: expected,
    });

    await writeSettings({ announcements: { home: false } });
    await expect((await setupServer()).call("notices", {})).resolves.toEqual({ homeLine: "" });
  });

  it("lists the notices, saves their read state and the notice settings", async () => {
    useConfig({});
    await writeSettings({});
    const { call } = await setupServer();
    const first = (await call("noticeList", {})) as {
      enabled: boolean;
      home: boolean;
      notices: Array<{ id: string; read: boolean }>;
    };
    expect(first).toMatchObject({ enabled: true, home: true });
    const ids = first.notices.map((notice) => notice.id);

    const read = (await call("noticeList", { read: ids, home: false })) as typeof first;
    expect(read.home).toBe(false);
    expect(read.notices.every((notice) => notice.read)).toBe(true);
    const saved = await readFile(SETTINGS_FILE, "utf8");
    expect(saved).toContain('"home": false');

    // With notices off, none is listed.
    await expect(call("noticeList", { enabled: false })).resolves.toEqual({
      enabled: false,
      home: false,
      notices: [],
    });
  });

  it("serves the /quota_status report as text, and never writes the global config", async () => {
    useConfig({ enabledProviders: "auto" });
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockImplementation(async (params) => {
      await params.onDetectedProviderIds?.(["copilot"]);
      return {
        state: "output",
        command: params.command,
        title: "OpenCode Quota Status",
        output: "status \u001b[31mreport",
        document: messageDocument("status"),
      };
    });
    const { call, commands } = await setupServer();

    await expect(call("status", { sessionID: "session-1" })).resolves.toEqual({
      text: "status report",
    });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).not.toHaveBeenCalled();

    // The slash command of Web and Desktop adds the detected providers.
    const slash = commands.find((command) => command.name === "quota_status");
    await slash?.execute({ sessionID: "session-1", prompt: { text: "" } });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: process.cwd(),
      detectedProviderIds: ["copilot"],
    });
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

    const output = (await call("command", { command: "tokens_all" })) as {
      output: string;
      document: ReportDocument;
    };
    expect(output).toEqual(
      expect.objectContaining({
        state: "output",
        command: "tokens_all",
        title: "Tokens used (All Time)",
      }),
    );
    expect(output.output).toContain("# Tokens used (All Time) (/tokens_all)");
    expect(output.document.heading?.line).toContain("Tokens used (All Time)");
  });

  it("returns a failed palette command as output instead of an RPC error", async () => {
    useConfig({});
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockRejectedValue(
      new Error("tokens \u001b[31mbroke"),
    );
    const { call } = await setupServer();

    await expect(call("command", { command: "tokens_today" })).resolves.toEqual({
      state: "output",
      command: "tokens_today",
      title: "Tokens used (Today)",
      output: "tokens broke",
      document: messageDocument("tokens broke"),
    });
  });

  it("posts the /quota limits and notices of Web and Desktop into the chat", async () => {
    useConfig({});
    await writeSettings({ announcements: { enabled: false } });
    const { ctx, commands } = await setupServer();

    await commands
      .find((command) => command.name === "quota")
      ?.execute({
        sessionID: "session-1",
        prompt: { text: "" },
      });

    expect(ctx.session.wait).toHaveBeenCalledWith({ sessionID: "session-1" });
    const [message] = ctx.session.prompt.mock.calls[0] as [
      { text: string; metadata: Record<string, { command: string }> },
    ];
    expect(message.text.split("\n")).toEqual([
      "[OpenCode Quota report]",
      "Quota",
      "Copilot Plan        81% left",
      "[End of OpenCode Quota report]",
    ]);
    expect(message.metadata.opencodeQuota?.command).toBe("quota");
    expect(commands.map((command) => command.name)).not.toContain("quota_announcements");
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

    expect(workspaceRoots).toEqual([project]);
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
