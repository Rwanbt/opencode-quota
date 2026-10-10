import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-quota-command-tests";

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
});
