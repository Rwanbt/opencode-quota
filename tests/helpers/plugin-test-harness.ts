import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { createFakeIntegration } from "./fake-integration.js";

type MockFunction = ReturnType<typeof vi.fn>;

interface PricingMocks {
  getPricingSnapshotMeta: MockFunction;
  getPricingSnapshotSource: MockFunction;
  getRuntimePricingRefreshStatePath: MockFunction;
  getRuntimePricingSnapshotPath: MockFunction;
  maybeRefreshPricingSnapshot: MockFunction;
  setPricingSnapshotAutoRefresh: MockFunction;
  setPricingSnapshotSelection: MockFunction;
}

interface PluginBootstrapMocks extends PricingMocks {
  getProviders?: MockFunction;
  fetchSessionTokensForDisplay?: MockFunction;
  resolveAlibabaCodingPlanAuthCached?: MockFunction;
}

export function createProvidersRegistryModuleMock(getProviders: MockFunction) {
  return { getProviders };
}

export function createPricingModuleMock(mocks: PricingMocks) {
  return {
    getPricingSnapshotMeta: mocks.getPricingSnapshotMeta,
    getPricingSnapshotSource: mocks.getPricingSnapshotSource,
    getRuntimePricingRefreshStatePath: mocks.getRuntimePricingRefreshStatePath,
    getRuntimePricingSnapshotPath: mocks.getRuntimePricingSnapshotPath,
    maybeRefreshPricingSnapshot: mocks.maybeRefreshPricingSnapshot,
    setPricingSnapshotAutoRefresh: mocks.setPricingSnapshotAutoRefresh,
    setPricingSnapshotSelection: mocks.setPricingSnapshotSelection,
  };
}

export function createSessionTokensModuleMock(fetchSessionTokensForDisplay: MockFunction) {
  return { fetchSessionTokensForDisplay };
}

export function createAlibabaAuthModuleMock(resolveAlibabaCodingPlanAuthCached: MockFunction) {
  return {
    isAlibabaModelId: (model?: string) =>
      typeof model === "string" &&
      (model.toLowerCase().startsWith("alibaba/") || model.toLowerCase().startsWith("alibaba-cn/")),
    resolveAlibabaCodingPlanAuthCached,
  };
}

export function createPluginRuntimePathsMockModule(root: string) {
  return {
    getOpencodeRuntimeDirs: () => ({
      dataDir: `${root}/data`,
      configDir: `${root}/config`,
      cacheDir: `${root}/cache`,
      stateDir: `${root}/state`,
    }),
  };
}

/**
 * Writes the server settings file (settings.jsonc) under the runtime root of
 * `createPluginRuntimePathsMockModule(root)`.
 */
export function writePluginTestSettings(root: string, settings: Record<string, unknown>): void {
  const dir = join(root, "config", "opencode-quota");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.jsonc"), JSON.stringify(settings, null, 2));
}

/**
 * Clears every mock and gives the mocked modules their default answers. `resetPluginState`
 * loads fresh module instances, which clears module-level singleton state.
 */
export function seedDefaultPluginBootstrapMocks(
  mocks: PluginBootstrapMocks,
  options: { resetPluginState?: boolean } = {},
): void {
  vi.clearAllMocks();
  if (options.resetPluginState) vi.resetModules();

  mocks.getProviders?.mockReturnValue([]);
  mocks.fetchSessionTokensForDisplay?.mockResolvedValue({});
  mocks.resolveAlibabaCodingPlanAuthCached?.mockResolvedValue({ state: "none" });
  mocks.getPricingSnapshotMeta.mockReturnValue({
    source: "https://models.dev/api.json",
    generatedAt: Date.UTC(2026, 0, 1),
    units: "USD per 1M tokens",
  });
  mocks.getPricingSnapshotSource.mockReturnValue("runtime");
  mocks.getRuntimePricingSnapshotPath.mockReturnValue("/tmp/modelsdev-pricing.runtime.min.json");
  mocks.getRuntimePricingRefreshStatePath.mockReturnValue(
    "/tmp/modelsdev-pricing.refresh-state.json",
  );
  mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
    attempted: false,
    updated: false,
    state: { version: 1, updatedAt: Date.now() },
  });
}

export type ServerTool = {
  name: string;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
};

export type ServerCommand = {
  name: string;
  description?: string;
  execute: (invocation: {
    sessionID: string;
    prompt: { text: string };
    delivery?: "steer" | "queue";
  }) => Promise<void>;
};

/**
 * A fake OpenCode context for the server plugin's `setup`. It records the tools, slash
 * commands and session hooks the plugin adds; `emit` records the RPC events. OpenCode lists
 * the providers `openCodeProviders` names, and `sessionGet` answers for every session.
 */
export function createServerContext({
  directory = process.cwd(),
  openCodeProviders = [],
  sessionGet = vi.fn().mockResolvedValue({}),
  events = { async *[Symbol.asyncIterator]() {} },
}: {
  directory?: string;
  openCodeProviders?: string[];
  sessionGet?: MockFunction;
  events?: AsyncIterable<{ type: string }>;
} = {}) {
  const tools: ServerTool[] = [];
  const commands: ServerCommand[] = [];
  const hooks = new Map<string, unknown>();
  const emit = vi.fn(async (_name: string, _data: unknown) => {});
  const ctx = {
    location: { directory },
    provider: { list: vi.fn(async () => ({ data: openCodeProviders.map((id) => ({ id })) })) },
    session: {
      get: sessionGet,
      wait: vi.fn(async (_input: { sessionID: string }) => {}),
      prompt: vi.fn(async (_input: { sessionID: string; text: string }) => ({})),
      hook: vi.fn(async (name: string, callback: unknown) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      transform: vi.fn(async (build: (editor: { add: (tool: ServerTool) => void }) => void) =>
        build({ add: (tool) => tools.push(tool) }),
      ),
    },
    command: {
      transform: vi.fn(async (build: (editor: { add: (command: ServerCommand) => void }) => void) =>
        build({ add: (command) => commands.push(command) }),
      ),
    },
    rpc: { register: vi.fn(async () => ({ dispose: async () => {}, events: { emit } })) },
    integration: createFakeIntegration([]),
    event: { subscribe: () => events },
  };
  return { ctx, tools, commands, hooks, emit };
}
