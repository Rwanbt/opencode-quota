import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { renderPlainTextReport } from "../src/lib/report-document.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-quota-command-tests";

type DialogCommand = "pricing_refresh" | "tokens_between";

async function buildDialogOutput(params: {
  command: DialogCommand;
  client: ReturnType<typeof createClient>;
  sessionID: string;
  arguments?: string;
  generatedAtMs?: number;
  /** The line the TUI dialog shows under its title, in place of the report's title line. */
  subtitle?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  // V2 CLI obtains host provider IDs from its location cache, not V1 plugin bootstrap.
  params.client.config.providers.mockResolvedValue({
    data: {
      providers: mocks.getProviders().map((provider: { id: string }) => ({ id: provider.id })),
    },
  });
  const result = await buildQuotaDialogCommandOutput({
    command: params.command,
    arguments: params.arguments,
    generatedAtMs: params.generatedAtMs,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
    resolveSessionMeta: async (sessionID) => {
      const response = await params.client.session.get({ path: { id: sessionID } });
      return {
        modelID: response.data?.model?.id,
        providerID: response.data?.model?.providerID,
      };
    },
  });
  expect(params.client.session.prompt).not.toHaveBeenCalled();
  expect(result.state).toBe("output");
  if (result.state !== "output") return "";
  // Every command here renders its document as plain text.
  expect(renderPlainTextReport(result.document)).toBe(result.output);
  if (params.subtitle !== undefined) {
    expect(result.document.heading?.subtitle).toBe(params.subtitle);
  }
  return result.output;
}

async function createV2StatusTool(directory: string) {
  const { default: server } = await import("../src/plugin.js");
  let execute:
    | ((input: unknown, context: { sessionID: string }) => Promise<{ content: string }>)
    | undefined;
  await server.setup({
    location: { directory },
    provider: { list: vi.fn().mockResolvedValue({ data: [] }) },
    session: { get: vi.fn().mockResolvedValue({}), hook: vi.fn() },
    command: { transform: vi.fn() },
    rpc: { register: vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } })) },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: {
      transform: async (
        register: (editor: { add: (tool: { execute: typeof execute }) => void }) => void,
      ) =>
        register({
          add: (tool) => {
            execute = tool.execute;
          },
        }),
    },
  } as never);
  if (!execute) throw new Error("quota_status tool was not registered");
  return execute;
}

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
  disposeQuotaTelemetryOwner: vi.fn(),
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

vi.mock("../src/lib/quota-telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-telemetry.js")>()),
  disposeQuotaTelemetryOwner: mocks.disposeQuotaTelemetryOwner,
}));

describe("server report commands", () => {
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    mocks.loadConfig.mockReset();
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      },
      resetPluginState: true,
    });
    mocks.reconcileDetectedProvidersInGlobalConfig.mockResolvedValue({
      path: `${TEST_RUNTIME_ROOT}/config/opencode.jsonc`,
      format: "jsonc",
      addedProviderIds: [],
      changed: false,
    });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("registers the V2 server diagnostics tool with provider repair and no V1 command hooks", async () => {
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    const output = vi
      .spyOn(dialogModule, "buildQuotaDialogCommandOutput")
      .mockImplementation(async (params) => {
        expect(await params.resolveSessionMeta?.("session-status")).toEqual({
          modelID: "gpt-5",
          providerID: "openai",
        });
        await params.onDetectedProviderIds?.(["openai"]);
        return { state: "output", output: "adapter output" };
      });
    const { default: server } = await import("../src/plugin.js");
    let tool:
      | {
          name: string;
          execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
        }
      | undefined;
    const ctx = {
      location: { directory: process.cwd() },
      tool: {
        transform: vi.fn(async (register) =>
          register({
            add: (value: typeof tool) => {
              tool = value;
            },
          }),
        ),
      },
      provider: { list: vi.fn().mockResolvedValue({ data: [] }) },
      session: {
        get: vi.fn().mockResolvedValue({ model: { providerID: "openai", id: "gpt-5" } }),
        hook: vi.fn(),
      },
      command: { transform: vi.fn() },
      rpc: {
        register: vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } })),
      },
      integration: createFakeIntegration([]),
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    };
    await server.setup(ctx as never);
    expect(tool?.name).toBe("quota_status");
    expect(await tool?.execute({}, { sessionID: "session-status" })).toEqual({
      content: "adapter output",
    });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "quota_status",
        sessionID: "session-status",
      }),
    );
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: process.cwd(),
      detectedProviderIds: ["openai"],
    });
    expect(ctx.session.get).toHaveBeenCalledWith({ sessionID: "session-status" });
    expect((server as Record<string, unknown>)["command.execute.before"]).toBeUndefined();
  });

  it("reconciles auth-detected providers using the V2 server status tool", async () => {
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockImplementation(async (params) => {
      await params.onDetectedProviderIds?.(["openai"]);
      return { state: "output", output: "OpenAI quota" };
    });
    const projectDirectory = `${TEST_RUNTIME_ROOT}/project`;
    const execute = await createV2StatusTool(projectDirectory);
    expect(await execute({}, { sessionID: "session-auto-provider" })).toEqual({
      content: "OpenAI quota",
    });
    expect(mocks.reconcileDetectedProvidersInGlobalConfig).toHaveBeenCalledWith({
      configRootDir: projectDirectory,
      detectedProviderIds: ["openai"],
    });
  });

  it("keeps the V2 status tool working when automatic global config repair fails", async () => {
    mocks.reconcileDetectedProvidersInGlobalConfig.mockRejectedValueOnce(new Error("disk full"));
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockImplementation(async (params) => {
      await params.onDetectedProviderIds?.(["openai"]);
      return { state: "output", output: "OpenAI quota" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const execute = await createV2StatusTool(`${TEST_RUNTIME_ROOT}/project`);
      expect(await execute({}, { sessionID: "session-repair-failure" })).toEqual({
        content: "OpenAI quota",
      });
      expect(warn).toHaveBeenCalledWith(
        "Failed to add detected providers to global OpenCode config",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not mutate server agent selection from the V2 diagnostics tool", async () => {
    const dialogModule = await import("../src/lib/quota-dialog-commands.js");
    vi.spyOn(dialogModule, "buildQuotaDialogCommandOutput").mockResolvedValue({
      state: "output",
      output: "Quota ready",
    });
    const execute = await createV2StatusTool(process.cwd());
    expect(await execute({}, { sessionID: "session-status" })).toEqual({ content: "Quota ready" });
    // V2 has no server config mutation hook; CLI slash commands do not touch agents.
    expect(dialogModule.buildQuotaDialogCommandOutput).toHaveBeenCalledWith(
      expect.not.objectContaining({ agent: expect.anything(), default_agent: expect.anything() }),
    );
  });

  it("runs /pricing_refresh with force=true by default and reports bundled pinning", async () => {
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      enabled: true,
      pricingSnapshot: { source: "bundled", autoRefresh: 7 },
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });
    mocks.getPricingSnapshotSource.mockReturnValue("bundled");
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: {
        version: 1,
        updatedAt: Date.now(),
        lastResult: "success",
      },
    });

    const client = createClient();

    const generatedAtMs = Date.UTC(2026, 0, 2, 3, 4);
    const injected = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-pricing-refresh",
      generatedAtMs,
      subtitle: formatLocalCallTimestamp(generatedAtMs),
    });

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(injected).toBe(
      [
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
      ].join("\n"),
    );
  });

  it("reports a failed /pricing_refresh with its error", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: false,
      reason: "fetch_failed",
      error: "network down",
      state: { version: 1, updatedAt: Date.now() },
    });
    const generatedAtMs = Date.UTC(2026, 0, 2, 3, 4);

    const injected = await buildDialogOutput({
      command: "pricing_refresh",
      client: createClient(),
      sessionID: "session-pricing-refresh-failed",
      generatedAtMs,
    });

    expect(injected).toBe(
      [
        `# Pricing Refresh (/pricing_refresh) ${formatLocalCallTimestamp(generatedAtMs)}`,
        "",
        "refresh:",
        "- attempted: true",
        "- result: fetch_failed",
        "- runtime_snapshot_persisted: false",
        "- error: network down",
        "",
        "pricing_snapshot:",
        "- selection: configured=auto active=runtime",
        "- active_snapshot: source=https://models.dev/api.json generated_at=2026-01-01T00:00:00.000Z units=USD per 1M tokens",
        "- runtime_paths: snapshot=/tmp/modelsdev-pricing.runtime.min.json refresh_state=/tmp/modelsdev-pricing.refresh-state.json",
      ].join("\n"),
    );
  });

  it("rejects /pricing_refresh arguments", async () => {
    const client = createClient();

    const injected = await buildDialogOutput({
      command: "pricing_refresh",
      arguments: '{"force":false}',
      client,
      sessionID: "session-pricing-refresh-invalid",
    });

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(injected).toContain("Invalid arguments for /pricing_refresh");
    expect(injected).toContain("This command does not accept arguments.");
  });

  it("reports invalid /tokens_between dates without admitting a session prompt", async () => {
    const client = createClient();
    const output = await buildDialogOutput({
      command: "tokens_between",
      arguments: "not-a-date-range",
      client,
      sessionID: "session-between-invalid",
    });
    expect(output).toContain("Invalid arguments for /tokens_between");
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("explains the expected /tokens_between range when arguments are missing", async () => {
    const client = createClient();
    const output = await buildDialogOutput({
      command: "tokens_between",
      client,
      sessionID: "session-between-missing",
    });
    expect(output).toContain("Expected: /tokens_between YYYY-MM-DD YYYY-MM-DD");
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("returns a no-op for disabled token commands without refreshing pricing", async () => {
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, enabled: false });
    const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
    const client = createClient();
    const result = await buildQuotaDialogCommandOutput({
      command: "tokens_daily",
      client,
      roots: { fallbackDirectory: process.cwd() },
      sessionID: "session-disabled",
    });
    expect(result).toEqual({ state: "noop", command: "tokens_daily", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("does not refresh pricing when /pricing_refresh is disabled", async () => {
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, enabled: false });
    const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
    const result = await buildQuotaDialogCommandOutput({
      command: "pricing_refresh",
      client: createClient(),
      roots: { fallbackDirectory: process.cwd() },
      sessionID: "session-disabled-refresh",
    });
    expect(result).toEqual({ state: "noop", command: "pricing_refresh", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
  });
});
