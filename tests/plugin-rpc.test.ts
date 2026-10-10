import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import { messageDocument } from "../src/lib/report-document.js";
import { answer, percentRow } from "./helpers/fake-answers.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { writeSessionDatabase } from "./helpers/session-database.js";

// A fresh folder per run, so test runs in sibling checkouts never share it.
const TEST_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "opencode-quota-plugin-rpc-"));

const mocks = vi.hoisted(() => ({
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

/** settings.jsonc: Copilot only, checked on every call, no notices; `overrides` per group. */
function useSettings(overrides: Record<string, unknown> = {}): void {
  writePluginTestSettings(TEST_RUNTIME_ROOT, {
    providers: { enabled: ["copilot"] },
    checking: { minIntervalMs: 1 },
    announcements: { enabled: false, home: false },
    ...overrides,
  });
}

const SNAPSHOT_FILE = `${TEST_RUNTIME_ROOT}/state/opencode-quota/snapshot-v6.json`;
const SETTINGS_FILE = `${TEST_RUNTIME_ROOT}/config/opencode-quota/settings.jsonc`;

/** A snapshot whose words say `percent`. */
const withPercentWords = (percent: string) =>
  expect.objectContaining({ words: expect.objectContaining({ percent }) });

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
        fetch: vi
          .fn()
          .mockResolvedValue(
            answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 81)] }),
          ),
      },
    ]);
    mocks.reconcileDetectedProvidersInGlobalConfig.mockResolvedValue({ changed: false });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
    useSettings();
  });

  afterEach(async () => {
    // Stops each server's store and waits for its fetches and writes.
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("registers the quota RPC with its nine methods during setup", async () => {
    const { QuotaRpc } = await import("../src/rpc.js");
    const { definition, handlers } = await setupServer();

    expect(definition).toBe(QuotaRpc);
    expect(definition.id).toBe("slkiser.opencode-quota");
    expect(Object.keys(definition.methods)).toEqual([
      "snapshot",
      "refresh",
      "notices",
      "noticeList",
      "status",
      "usage",
      "downloadPrices",
      "saveSettings",
      "acknowledgeDisplayImport",
    ]);
    expect(Object.keys(handlers)).toEqual(Object.keys(definition.methods));
  });

  it("asks no provider and reads no snapshot file during setup", async () => {
    useSettings();
    const fetch = vi.fn();
    mocks.getProviders.mockReturnValue([
      { id: "copilot", isAvailable: vi.fn().mockResolvedValue(true), fetch },
    ]);
    await setupServer();

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
    useSettings({ pricing: { source: "bundled", autoRefreshDays: 3 } });
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
    useSettings({ checking: { minIntervalMs: 60_000 } });
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue(
          answer({
            name: "Copilot (pro)",
            rows: [
              percentRow("allowance", "Premium requests", 80, {
                window: "month",
                used: { decimal: "60", unit: { kind: "count", unit: "request" } },
                limit: { decimal: "300", unit: { kind: "count", unit: "request" } },
                resetsAt: "2026-11-01T00:00:00.000Z",
              }),
            ],
          }),
        ),
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

  it("saves settings, then answers and tells every client with the new words", async () => {
    const { call, emit } = await setupServer();
    emit.mockClear();

    await expect(call("saveSettings", { patch: { words: { percent: "used" } } })).resolves.toEqual({
      ok: true,
      issues: [],
    });

    expect(parseJsonc(await readFile(SETTINGS_FILE, "utf8"))).toMatchObject({
      words: { percent: "used" },
    });
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith("changed", { snapshot: withPercentWords("used") }),
    );
    await expect(call("snapshot", {})).resolves.toEqual({ snapshot: withPercentWords("used") });
  });

  it("saves nothing that only the file may set", async () => {
    const { call } = await setupServer();
    const before = await readFile(SETTINGS_FILE, "utf8");

    const result = (await call("saveSettings", {
      patch: { export: { path: `${TEST_RUNTIME_ROOT}/elsewhere.json` } },
    })) as { ok: boolean; issues: unknown[] };

    expect(result.ok).toBe(false);
    expect(result.issues).not.toHaveLength(0);
    expect(await readFile(SETTINGS_FILE, "utf8")).toBe(before);
  });

  it("reads settings.jsonc again when it changes on disk", async () => {
    const { call, emit } = await setupServer();
    emit.mockClear();

    useSettings({ words: { percent: "bare" } });

    await vi.waitFor(
      () => expect(emit).toHaveBeenCalledWith("changed", { snapshot: withPercentWords("bare") }),
      { timeout: 5_000 },
    );
    await expect(call("snapshot", {})).resolves.toEqual({ snapshot: withPercentWords("bare") });
  });

  it("converts the v5 settings at the first start and offers their looks until a TUI takes them", async () => {
    await rm(SETTINGS_FILE);
    await writeFile(
      `${TEST_RUNTIME_ROOT}/config/opencode-quota/quota-toast.jsonc`,
      '{ // v5\n "enabledProviders": ["copilot"], "percentDisplayMode": "used", "showOnIdle": false }',
    );
    const first = await setupServer();

    expect(parseJsonc(await readFile(SETTINGS_FILE, "utf8"))).toMatchObject({
      providers: { enabled: ["copilot"] },
      words: { percent: "used" },
    });
    const offered = (await first.call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(offered.snapshot.words?.percent).toBe("used");
    expect(offered.snapshot.displayImport).toEqual({
      id: expect.any(String),
      display: { toast: { afterReply: "off" } },
    });

    // Only the offered looks' id takes them.
    await expect(first.call("acknowledgeDisplayImport", { id: "other" })).resolves.toEqual({});
    const kept = (await first.call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(kept.snapshot.displayImport).toEqual(offered.snapshot.displayImport);
    const id = offered.snapshot.displayImport?.id;
    await expect(first.call("acknowledgeDisplayImport", { id })).resolves.toEqual({});
    const taken = (await first.call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(taken.snapshot).not.toHaveProperty("displayImport");

    // The next start finds settings.jsonc: nothing to convert, no looks to offer.
    const second = await setupServer();
    const later = (await second.call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(later.snapshot).not.toHaveProperty("displayImport");
  });

  it("drops a check that ran across a settings change that turned its provider off", async () => {
    useSettings({
      providers: { enabled: ["copilot", "openai"] },
      checking: { minIntervalMs: 60_000 },
    });
    let answerCopilot: (result: unknown) => void = () => {};
    const slowCopilot = vi.fn(
      () =>
        new Promise((resolve) => {
          answerCopilot = resolve;
        }),
    );
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: slowCopilot,
      },
      {
        id: "openai",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi
          .fn()
          .mockResolvedValue(answer({ name: "OpenAI", rows: [percentRow("five_hour", "5h", 60)] })),
      },
    ]);
    const { call, emit } = await setupServer();
    const providerIds = (snapshot: QuotaSnapshot) =>
      snapshot.providers.map((provider) => provider.providerId);
    const emitted = () =>
      emit.mock.calls.map(([, data]) =>
        providerIds((data as { snapshot: QuotaSnapshot }).snapshot),
      );
    const running = call("refresh", { reason: "manual" }) as Promise<{ snapshot: QuotaSnapshot }>;
    await vi.waitFor(() => expect(slowCopilot).toHaveBeenCalledOnce());
    emit.mockClear();

    useSettings({ providers: { enabled: ["openai"] }, checking: { minIntervalMs: 60_000 } });
    await vi.waitFor(() => expect(emitted().at(-1)).toEqual(["openai"]), { timeout: 5_000 });
    answerCopilot(
      answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 70)] }),
    );

    // The refresh asked for before the change answers with the settings of now.
    expect(providerIds((await running).snapshot)).toEqual(["openai"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emitted().filter((ids) => ids.includes("copilot"))).toEqual([]);
    const now = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(providerIds(now.snapshot)).toEqual(["openai"]);
  });

  it("checks with the price list the settings choose, and again at once when it changes", async () => {
    useSettings({ pricing: { source: "bundled", autoRefreshDays: 5 } });
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    const seen: string[] = [];
    const fetch = vi.fn(async () => {
      const days = pricing.getPricingRefreshPolicy().maxAgeMs / (24 * 60 * 60 * 1000);
      seen.push(`${pricing.getPricingSnapshotSelection()} ${days}`);
      return answer();
    });
    mocks.getProviders.mockReturnValue([
      { id: "copilot", isAvailable: vi.fn().mockResolvedValue(true), fetch },
    ]);
    const { call } = await setupServer();

    await call("refresh", { reason: "poll" });
    expect(seen).toEqual(["bundled 5"]);

    // Local estimates use prices: another price list checks every provider again.
    useSettings({
      checking: { minIntervalMs: 60_000 },
      pricing: { source: "runtime", autoRefreshDays: 2 },
    });
    await vi.waitFor(() => expect(seen).toEqual(["bundled 5", "runtime 2"]), { timeout: 5_000 });
  });

  it("checks again at once when the time limit changes, also when set to its default", async () => {
    useSettings({ checking: { minIntervalMs: 60_000 } });
    const seen: unknown[] = [];
    const fetch = vi.fn(async (ctx: { config: Record<string, unknown> }) => {
      seen.push([ctx.config.requestTimeoutMs, ctx.config.requestTimeoutMsConfigured]);
      if (seen.length === 1) throw new Error("Request timeout after 5s");
      return answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 40)] });
    });
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch,
      },
    ]);
    const { call } = await setupServer();
    const failed = (await call("refresh", { reason: "manual" })) as { snapshot: QuotaSnapshot };
    expect(failed.snapshot.providers[0]?.error?.code).toBe("timeout");

    // The default time limit, now set in the file: providers use a configured limit.
    useSettings({ checking: { minIntervalMs: 60_000, requestTimeoutMs: 5_000 } });
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5_000 });
    expect(seen[1]).toEqual([5_000, true]);

    // A longer limit after the timeout: no interval or backoff waits for it.
    useSettings({ checking: { minIntervalMs: 60_000, requestTimeoutMs: 30_000 } });
    await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 5_000 });
    expect(seen[2]).toEqual([30_000, true]);
    const now = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(now.snapshot.providers[0]).not.toHaveProperty("error");
  });

  it("checks no provider again when the file lists the same check settings in another order", async () => {
    useSettings({ checking: { minIntervalMs: 60_000, requestTimeoutMs: 5_000 } });
    const fetch = vi.fn(async () => ({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 40 }],
      errors: [],
    }));
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch,
      },
    ]);
    const { call, emit } = await setupServer();
    await call("refresh", { reason: "manual" });
    expect(fetch).toHaveBeenCalledOnce();

    // The same check settings in another order, and new words: the words show at once.
    useSettings({
      checking: { requestTimeoutMs: 5_000, minIntervalMs: 60_000 },
      words: { percent: "used" },
    });
    await vi.waitFor(
      () => expect(emit).toHaveBeenCalledWith("changed", { snapshot: withPercentWords("used") }),
      { timeout: 5_000 },
    );

    // A refresh joins any check still running; the provider is not due for a minute.
    await call("refresh", { reason: "poll" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("offers the v5 looks a save kept when it finished the conversion", async () => {
    // A v5 sidecar that does not parse, and v5 settings in opencode.json: the start converts
    // them in memory only, and the first save writes settings.jsonc and keeps the looks.
    await rm(SETTINGS_FILE);
    await writeFile(`${TEST_RUNTIME_ROOT}/config/opencode-quota/quota-toast.jsonc`, "{ broken");
    await writeFile(
      `${TEST_RUNTIME_ROOT}/config/opencode.json`,
      JSON.stringify({
        experimental: { quotaToast: { enabledProviders: ["copilot"], showOnIdle: false } },
      }),
    );
    const { call, emit } = await setupServer();
    const before = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(before.snapshot).not.toHaveProperty("displayImport");
    emit.mockClear();

    await expect(
      call("saveSettings", { patch: { words: { percent: "used" } } }),
    ).resolves.toMatchObject({ ok: true });

    const offered = { id: expect.any(String), display: { toast: { afterReply: "off" } } };
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith("changed", {
        snapshot: expect.objectContaining({ displayImport: offered }),
      }),
    );
    const after = (await call("snapshot", {})) as { snapshot: QuotaSnapshot };
    expect(after.snapshot.displayImport).toEqual(offered);
  });

  it("names the providers of the session's model in the snapshot", async () => {
    useSettings({ providers: { enabled: ["copilot", "openai"] } });
    mocks.getProviders.mockReturnValue(
      ["copilot", "openai"].map((id) => ({
        id,
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue(answer()),
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
    useSettings();
    let answerFetch: (result: unknown) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          answerFetch = resolve;
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
    answerFetch(
      answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 70)] }),
    );
    await cleaning;
    expect(existsSync(SNAPSHOT_FILE)).toBe(true);
  });

  it("checks who each provider is signed in as after a login change", async () => {
    useSettings({ checking: { minIntervalMs: 60_000 } });
    let account = "alice";
    const fetch = vi.fn(async () =>
      answer({
        name: `Copilot (${account})`,
        rows: [percentRow("allowance", "Premium requests", 50)],
      }),
    );
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
    useSettings({ words: { sessionTokens: "tree" } });
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
    useSettings({ announcements: { enabled: true, home: true, homeFrequency: "always" } });
    await expect((await setupServer()).call("notices", {})).resolves.toEqual({
      homeLine: expected,
    });

    useSettings({ announcements: { enabled: true, home: false } });
    await expect((await setupServer()).call("notices", {})).resolves.toEqual({ homeLine: "" });
  });

  it("lists the notices, saves their read state and the notice settings", async () => {
    useSettings({ announcements: { enabled: true, home: true } });
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
    useSettings({ providers: { enabled: "auto" } });
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
    useSettings({ export: { enabled: false, path: exportPath } });
    const disabled = await setupServer();
    await disabled.call("refresh", { reason: "manual" });
    await vi.waitFor(() => expect(disabled.emit).toHaveBeenCalled());
    expect(existsSync(exportPath)).toBe(false);

    useSettings({ export: { enabled: true, path: exportPath } });
    const enabled = await setupServer();
    await enabled.call("refresh", { reason: "manual" });
    // The snapshot before the check is written first; the check's own part follows.
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(exportPath, "utf8"))).toMatchObject({
        version: 3,
        fromCache: true,
        providers: {
          copilot: {
            status: "ok",
            entries: [
              { id: "copilot.allowance", name: "Copilot Premium requests", percentRemaining: 81 },
            ],
          },
        },
      });
    });
    // The parts stay on the server: no client gets them.
    expect(JSON.stringify(await enabled.call("snapshot", {}))).not.toContain("exportPart");
    expect(JSON.stringify(enabled.emit.mock.calls)).not.toContain("exportPart");
  });

  it.each([
    {
      name: "downloads new prices whatever their age, and says when the settings keep the built-in ones",
      source: "bundled" as const,
      refresh: { attempted: true, updated: true, state: { version: 1, updatedAt: 1 } },
      answer: {
        ok: true,
        message:
          "Downloaded new prices. Usage keeps the built-in prices: the pricing source setting is bundled.",
      },
    },
    {
      name: "reports a failed price download with its error",
      source: "auto" as const,
      refresh: {
        attempted: true,
        updated: false,
        reason: "fetch_failed",
        error: "network down",
        state: { version: 1, updatedAt: 1 },
      },
      answer: { ok: false, message: "Couldn't download new prices: network down." },
    },
  ])("$name", async ({ source, refresh, answer }) => {
    useSettings({ pricing: { source, autoRefreshDays: 3 } });
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue(refresh);
    const { call } = await setupServer();

    await expect(call("downloadPrices", {})).resolves.toEqual(answer);
    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: source,
      allowRefreshWhenSelectionBundled: true,
    });
  });

  it("posts the /quota limits and notices of Web and Desktop into the chat", async () => {
    useSettings();
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
      "Copilot Premium re… 81% left",
      "[End of OpenCode Quota report]",
    ]);
    expect(message.metadata.opencodeQuota?.command).toBe("quota");
    expect(commands.map((command) => command.name)).not.toContain("quota_announcements");
  });

  it("treats a session the server cannot find as a session without a model", async () => {
    useSettings();
    const sessionGet = vi.fn().mockRejectedValue(new Error("Session not found"));
    const { call } = await setupServer(sessionGet);

    const output = (await call("snapshot", { sessionID: "missing" })) as {
      snapshot: QuotaSnapshot;
    };
    expect(output.snapshot).not.toHaveProperty("currentModelProviderIds");
    expect(sessionGet).toHaveBeenCalledWith({ sessionID: "missing" });
  });

  it("computes quota for the location's project folder, not the service's working folder", async () => {
    useSettings();
    const workspaceRoots: string[] = [];
    mocks.getProviders.mockReturnValue([
      {
        id: "copilot",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn(async (ctx: { workspaceRoot: string }) => {
          workspaceRoots.push(ctx.workspaceRoot);
          return answer({
            name: "Copilot",
            rows: [percentRow("allowance", "Premium requests", 81)],
          });
        }),
      },
    ]);
    const project = `${TEST_RUNTIME_ROOT}/project`;
    const { call } = await setupServer(undefined, project);

    // The store's refresh, then /quota_status, which checks every provider itself.
    await call("refresh", { reason: "manual" });
    await call("status", { sessionID: "session-1" });

    expect(workspaceRoots).toHaveLength(2);
    expect(new Set(workspaceRoots)).toEqual(new Set([project]));
    expect(project).not.toBe(process.cwd());
  });

  it("logs why a snapshot or notices RPC failed, without tokens, and still fails it", async () => {
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    useSettings({ announcements: { enabled: true, home: true } });
    mocks.getProviders.mockImplementation(() => {
      throw new Error(`registry broke ${token}`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = await setupServer();

    for (const [method, input] of [
      ["snapshot", { sessionID: "session-1" }],
      ["notices", {}],
    ] as const) {
      await expect(handlers[method](input, callContext)).rejects.toThrow("registry broke");
      expect(warn).toHaveBeenLastCalledWith(
        `[opencode-quota] ${method} RPC failed: registry broke [redacted]`,
      );
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });
});
