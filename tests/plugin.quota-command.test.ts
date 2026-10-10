import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { renderPlainTextReport } from "../src/lib/report-document.js";
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

// A fresh folder per run, so test runs in sibling checkouts never share it.
const TEST_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "opencode-quota-plugin-quota-command-"));
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

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

type Command = "pricing_refresh" | "tokens_between";
type Tool = {
  name: string;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
};
type CommandHandler = (input: unknown, context: unknown) => Promise<unknown>;
type SlashCommand = {
  name: string;
  execute: (invocation: { sessionID: string; prompt: { text: string } }) => Promise<void>;
};

/** settings.jsonc: checked at most once a minute, no notices; `overrides` per group. */
function useSettings(overrides: Record<string, unknown> = {}): void {
  writePluginTestSettings(TEST_RUNTIME_ROOT, {
    checking: { minIntervalMs: 60_000 },
    announcements: { enabled: false },
    ...overrides,
  });
}

function provider(id: string, fetch: ReturnType<typeof vi.fn>, extra: object = {}) {
  return { id, isAvailable: vi.fn().mockResolvedValue(true), fetch, ...extra };
}

function quotaResult(entries: object[], errors: object[] = []) {
  return { attempted: true, entries, errors };
}

/** Each server's cleanup; run after every test, before its folder goes. */
const cleanups: Array<() => unknown> = [];

/**
 * Starts the server plugin. `quota` runs the /quota slash command of Web and Desktop and
 * returns the report it posts into the chat; `run` runs a report command over the quota RPC,
 * as the TUI does, and returns its text. Every session uses the model `sessionModel` gives.
 * OpenCode lists the quota providers' ids as its own, and `openCodeProviders` too.
 */
async function startServer(
  options: {
    directory?: string;
    sessionModel?: () => { id?: string; providerID?: string } | undefined;
    openCodeProviders?: string[];
  } = {},
) {
  const { default: server } = await import("../src/plugin.js");
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } }));
  let tool: Tool | undefined;
  const slashCommands: SlashCommand[] = [];
  const ctx = {
    location: { directory: options.directory ?? process.cwd() },
    provider: {
      list: vi.fn(async () => ({
        data: [
          ...mocks.getProviders().map((item: { id: string }) => item.id),
          ...(options.openCodeProviders ?? []),
        ].map((id) => ({ id })),
      })),
    },
    session: {
      get: vi.fn(async () => ({ model: options.sessionModel?.() })),
      hook: vi.fn(),
      wait: vi.fn(async () => {}),
      prompt: vi.fn(async (_input: { sessionID: string; text: string }) => {}),
    },
    command: {
      transform: async (build: (editor: { add: (value: SlashCommand) => void }) => void) =>
        build({ add: (value) => slashCommands.push(value) }),
    },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: {
      transform: async (build: (editor: { add: (value: Tool) => void }) => void) =>
        build({
          add: (value) => {
            tool = value;
          },
        }),
    },
  };
  const cleanup = await server.setup(ctx as never);
  if (typeof cleanup === "function") cleanups.push(cleanup);
  const [, handlers] = register.mock.calls[0] as unknown as [
    unknown,
    Record<string, CommandHandler>,
  ];
  if (!tool) throw new Error("quota_status tool was not registered");

  const run = async (
    command: Command,
    params: { sessionID?: string; arguments?: string; subtitle?: string } = {},
  ): Promise<string> => {
    const result = (await handlers.command(
      { command, sessionID: params.sessionID ?? "session-1", arguments: params.arguments },
      {},
    )) as { state: string; output: string; document: Parameters<typeof renderPlainTextReport>[0] };
    expect(result.state).toBe("output");
    // Every command here renders its document as plain text.
    expect(renderPlainTextReport(result.document)).toBe(result.output);
    if (params.subtitle !== undefined) {
      expect(result.document.heading?.subtitle).toBe(params.subtitle);
    }
    return result.output;
  };
  const quota = async (sessionID = "session-1"): Promise<string> => {
    const command = slashCommands.find((item) => item.name === "quota");
    if (!command) throw new Error("/quota was not registered");
    await command.execute({ sessionID, prompt: { text: "" } });
    const posted = ctx.session.prompt.mock.calls.filter(([input]) => input.sessionID === sessionID);
    const text = posted.at(-1)?.[0].text ?? "";
    // The report between its first and last line, which mark every quota report.
    return text.split("\n").slice(1, -1).join("\n");
  };
  const refresh = () => handlers.refresh({ reason: "manual" }, {});
  return { ctx, tool, run, quota, refresh };
}

describe("/quota and the report commands on the server", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    mocks.reconcileDetectedProvidersInGlobalConfig.mockResolvedValue({ changed: false });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
    useSettings();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("registers the server diagnostics tool with provider repair and no V1 command hooks", async () => {
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    const output = vi
      .spyOn(dialogModule, "buildQuotaDialogCommandOutput")
      .mockImplementation(async (params) => {
        expect(await params.resolveSessionModel?.("session-status")).toEqual({
          id: "gpt-5",
          providerID: "openai",
        });
        await params.onDetectedProviderIds?.(["openai"]);
        return { state: "output", output: "adapter output" } as never;
      });
    const { default: server } = await import("../src/plugin.js");
    const { ctx, tool } = await startServer({
      sessionModel: () => ({ id: "gpt-5", providerID: "openai" }),
    });

    expect(tool.name).toBe("quota_status");
    expect(await tool.execute({}, { sessionID: "session-status" })).toEqual({
      content: "adapter output",
    });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ command: "quota_status", sessionID: "session-status" }),
    );
    expect(output).toHaveBeenCalledWith(
      expect.not.objectContaining({ agent: expect.anything(), default_agent: expect.anything() }),
    );
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: process.cwd(),
      detectedProviderIds: ["openai"],
    });
    expect(ctx.session.get).toHaveBeenCalledWith({ sessionID: "session-status" });
    expect((server as Record<string, unknown>)["command.execute.before"]).toBeUndefined();
  });

  it.each([
    { name: "a working repair", repair: () => Promise.resolve({ changed: true }), warns: false },
    { name: "a failed repair", repair: () => Promise.reject(new Error("disk full")), warns: true },
  ])("adds the detected providers of the status tool to the project with $name", async ({
    repair,
    warns,
  }) => {
    mocks.reconcileDetectedProvidersInGlobalConfig.mockImplementationOnce(repair);
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockImplementation(async (params) => {
      await params.onDetectedProviderIds?.(["openai"]);
      return { state: "output", output: "OpenAI quota" } as never;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectDirectory = `${TEST_RUNTIME_ROOT}/project`;
    const { tool } = await startServer({ directory: projectDirectory });

    expect(await tool.execute({}, { sessionID: "session-auto-provider" })).toEqual({
      content: "OpenAI quota",
    });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: projectDirectory,
      detectedProviderIds: ["openai"],
    });
    if (warns) {
      expect(warn).toHaveBeenCalledWith(
        "Failed to add detected providers to global OpenCode config",
        expect.any(Error),
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("waits before asking a failed provider again; a manual refresh asks at once", async () => {
    useSettings({ providers: { enabled: ["openai"] } });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(
        quotaResult([
          { accounting: TEST_ACCOUNTING, name: "OpenAI 5h", label: "5h:", percentRemaining: 69 },
        ]),
      );
    mocks.getProviders.mockReturnValue([provider("openai", fetch)]);
    const { quota, refresh } = await startServer();

    await quota();
    const failed = await quota();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failed).not.toContain("69% left");

    await refresh();
    const recovered = await quota();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recovered).toContain("69% left");
  });

  it("prices the /quota usage with the price list the settings choose, as the token reports do", async () => {
    useSettings({ pricing: { source: "bundled", autoRefreshDays: 7 } });
    const { quota } = await startServer();

    await quota();

    expect(mocks.setPricingSnapshotSelection).toHaveBeenCalledWith("bundled");
    expect(mocks.setPricingSnapshotAutoRefresh).toHaveBeenCalledWith(7);
    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "tokens",
      snapshotSelection: "bundled",
    });
  });

  it.each([
    { words: { percent: "used" }, shows: "5h 19% used", hides: "left" },
    { words: { percent: "bare" }, shows: "5h 81%", hides: "left" },
  ])("shows /quota in the percent words the settings choose: $words", async ({
    words,
    shows,
    hides,
  }) => {
    useSettings({ providers: { enabled: ["openai"] }, words });
    mocks.getProviders.mockReturnValue([
      provider(
        "openai",
        vi.fn().mockResolvedValue(
          quotaResult([
            {
              accounting: TEST_ACCOUNTING,
              name: "OpenAI 5h",
              label: "5h:",
              percentRemaining: 81,
            },
          ]),
        ),
      ),
    ]);
    const { quota } = await startServer();

    const output = await quota();

    expect(output).toContain(shows);
    expect(output).not.toContain(hides);
  });

  it.each([
    {
      name: "an error without rows",
      id: "alibaba-coding-plan",
      fetch: vi.fn().mockResolvedValue(
        quotaResult(
          [],
          [
            {
              label: "Alibaba Coding Plan",
              message: "Unsupported Alibaba Coding Plan tier: max",
            },
          ],
        ),
      ),
      line: "Alibaba Coding Plan",
    },
    {
      name: "a failed fetch",
      id: "cursor",
      fetch: vi.fn().mockRejectedValue(new Error("sqlite busy")),
      line: "Cursor",
    },
    {
      name: "nothing reported",
      id: "anthropic",
      fetch: vi.fn().mockResolvedValue({ attempted: false, entries: [], errors: [] }),
      line: "Anthropic",
    },
  ])("shows a line for a provider with $name", async ({ id, fetch, line }) => {
    useSettings({ providers: { enabled: [id] } });
    mocks.getProviders.mockReturnValue([provider(id, fetch)]);
    const { quota } = await startServer();

    const output = await quota();

    expect(output).toContain(line);
    expect(output).not.toContain("Quota unavailable");
  });

  it("says no provider serves the session's model when onlyCurrentModel leaves none", async () => {
    useSettings({ words: { onlyCurrentModel: true } });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        quotaResult([
          { accounting: TEST_ACCOUNTING, name: "Cursor API", label: "API:", percentRemaining: 50 },
        ]),
      );
    mocks.getProviders.mockReturnValue([
      provider("cursor", fetch, { matchesCurrentModel: (model?: string) => model === "auto" }),
    ]);
    const { quota } = await startServer({
      sessionModel: () => ({ id: "gpt-5", providerID: "openai" }),
    });

    const output = await quota();

    expect(output).toContain("No quota provider serves the session's current model.");
  });

  it("shows only the custom sources serving the session's model when onlyCurrentModel is on", async () => {
    const definition = (id: string, model: string) => ({
      id,
      providerId: `${id}-gateway`,
      modelIds: [model],
      url: `https://${id}.example/quota`,
      mode: "remote-api",
      format: "quota-v1",
      apiKeyEnv: "TEST_GATEWAY_KEY",
    });
    useSettings({
      providers: {
        enabled: ["custom"],
        custom: [definition("alpha", "model-a"), definition("beta", "model-b")],
      },
      words: { onlyCurrentModel: true },
    });
    const entry = (id: string, percentRemaining: number) => ({
      accounting: { ...TEST_ACCOUNTING, ownership: "user_configured", sourceId: id },
      name: `${id} Monthly`,
      group: id,
      rowKey: "monthly",
      percentRemaining,
    });
    // One check reads every source; only the rows shown depend on the session's model.
    const fetch = vi.fn().mockResolvedValue(quotaResult([entry("alpha", 61), entry("beta", 32)]));
    mocks.getProviders.mockReturnValue([provider("quota-providers", fetch)]);
    let model = { id: "model-a", providerID: "alpha-gateway" };
    const { quota } = await startServer({
      sessionModel: () => model,
      openCodeProviders: ["alpha-gateway", "beta-gateway"],
    });

    const alpha = await quota();
    model = { id: "model-b", providerID: "beta-gateway" };
    const beta = await quota();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(alpha).toContain("61% left");
    expect(alpha).not.toContain("32% left");
    expect(beta).toContain("32% left");
    expect(beta).not.toContain("61% left");
  });

  it("answers /quota of every session from one check while the rows are fresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        quotaResult([
          { accounting: TEST_ACCOUNTING, name: "OpenAI 5h", label: "5h:", percentRemaining: 95 },
        ]),
      );
    mocks.getProviders.mockReturnValue([
      provider("openai", fetch, { cachePolicy: { kind: "account-neutral" } }),
    ]);
    const { quota } = await startServer();

    const first = await quota("session-a");
    const second = await quota("session-b");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toContain("95% left");
    expect(second).toContain("95% left");
  });

  it.each([
    {
      id: "alibaba-coding-plan",
      entry: (percentRemaining: number) => ({
        accounting: TEST_ACCOUNTING,
        name: "Alibaba Coding Plan (Lite) Weekly",
        label: "Weekly:",
        percentRemaining,
      }),
    },
    {
      id: "cursor",
      entry: (percentRemaining: number) => ({
        accounting: TEST_ACCOUNTING,
        name: "Cursor API (Pro)",
        label: "API:",
        semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
        percentRemaining,
      }),
    },
  ])("counts $id usage again on every /quota", async ({ id, entry }) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(quotaResult([entry(70)]))
      .mockResolvedValueOnce(quotaResult([entry(60)]));
    mocks.getProviders.mockReturnValue([provider(id, fetch)]);
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "dashscope-key",
      tier: "lite",
    });
    const { quota } = await startServer();

    await quota();
    const latest = await quota();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(latest).toContain("60% left");
  });

  it("runs /pricing_refresh with force=true by default and reports bundled pinning", async () => {
    useSettings({ pricing: { source: "bundled", autoRefreshDays: 7 } });
    mocks.getPricingSnapshotSource.mockReturnValue("bundled");
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
    });
    const { run } = await startServer();
    const generatedAtMs = Date.UTC(2026, 0, 2, 3, 4);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(generatedAtMs);

    const output = await run("pricing_refresh", {
      subtitle: formatLocalCallTimestamp(generatedAtMs),
    });
    vi.useRealTimers();

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(output.split("\n")).toEqual([
      `# Pricing Refresh (/pricing_refresh) ${formatLocalCallTimestamp(generatedAtMs)}`,
      "",
      "refresh:",
      "- attempted: true",
      "- result: success",
      "- runtime_snapshot_persisted: true",
      "",
      "pricing_snapshot:",
      "- selection: configured=bundled active=bundled",
      "- active_snapshot: source=https://models.dev/api.json generated_at=2026-01-01T00:00:00.000Z units=USD per 1M tokens",
      "- runtime_paths: snapshot=/tmp/modelsdev-pricing.runtime.min.json refresh_state=/tmp/modelsdev-pricing.refresh-state.json",
      "- selection_note: runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing",
    ]);
  });

  it("reports a failed /pricing_refresh with its error", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: false,
      reason: "fetch_failed",
      error: "network down",
      state: { version: 1, updatedAt: Date.now() },
    });
    const { run } = await startServer();

    const output = await run("pricing_refresh");

    expect(output).toContain(
      [
        "refresh:",
        "- attempted: true",
        "- result: fetch_failed",
        "- runtime_snapshot_persisted: false",
        "- error: network down",
        "",
        "pricing_snapshot:",
        "- selection: configured=auto active=runtime",
      ].join("\n"),
    );
  });

  it.each([
    {
      command: "pricing_refresh" as const,
      arguments: '{"force":false}',
      lines: ["Invalid arguments for /pricing_refresh", "This command does not accept arguments."],
    },
    {
      command: "tokens_between" as const,
      arguments: "not-a-date-range",
      lines: ["Invalid arguments for /tokens_between"],
    },
    {
      command: "tokens_between" as const,
      arguments: undefined,
      lines: ["Expected: /tokens_between YYYY-MM-DD YYYY-MM-DD"],
    },
  ])("explains wrong $command arguments ($arguments)", async (params) => {
    const { run } = await startServer();

    const output = await run(params.command, { arguments: params.arguments });

    for (const line of params.lines) expect(output).toContain(line);
    if (params.command === "pricing_refresh") {
      expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    }
  });
});
