import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

type MockFunction = ReturnType<typeof vi.fn>;

type PromptClient = {
  session: {
    prompt: MockFunction;
  };
};

type ToastClient = {
  tui: {
    showToast: MockFunction;
  };
};

interface PricingMocks {
  getPricingSnapshotMeta: MockFunction;
  getPricingSnapshotSource: MockFunction;
  getRuntimePricingRefreshStatePath: MockFunction;
  getRuntimePricingSnapshotPath: MockFunction;
  maybeRefreshPricingSnapshot: MockFunction;
  setPricingSnapshotAutoRefresh: MockFunction;
  setPricingSnapshotSelection: MockFunction;
}

interface SessionTokenMocks {
  fetchSessionTokensForDisplay: MockFunction;
}

interface AuthPlanMocks {
  resolveAlibabaCodingPlanAuthCached?: MockFunction;
}

interface PluginBootstrapMocks extends PricingMocks, AuthPlanMocks {
  getProviders?: MockFunction;
  fetchSessionTokensForDisplay?: MockFunction;
}

interface PluginBootstrapOptions {
  providers?: unknown[];
  resetModules?: boolean;
  resetPluginState?: boolean;
  seedAuthPlans?: boolean;
  seedSessionTokens?: boolean;
}

interface PluginRuntimeRoot {
  cacheDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
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
    DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS: 5000,
    isAlibabaModelId: (model?: string) =>
      typeof model === "string" &&
      (model.toLowerCase().startsWith("alibaba/") || model.toLowerCase().startsWith("alibaba-cn/")),
    resolveAlibabaCodingPlanAuthCached,
  };
}

export function createPluginBootstrapRuntimeRoot(root: string): PluginRuntimeRoot {
  return {
    dataDir: `${root}/data`,
    configDir: `${root}/config`,
    cacheDir: `${root}/cache`,
    stateDir: `${root}/state`,
  };
}

export function createPluginRuntimePathsMockModule(root: string) {
  const runtimeRoot = createPluginBootstrapRuntimeRoot(root);

  return {
    getOpencodeRuntimeDirs: () => ({ ...runtimeRoot }),
  };
}

export function resetPluginTestState(): void {
  // Per-test module resets clear in-memory plugin/cache singletons.
}

/**
 * Writes the server settings file (settings.jsonc) under the runtime root of
 * `createPluginRuntimePathsMockModule(root)`.
 */
export function writePluginTestSettings(root: string, settings: Record<string, unknown>): void {
  const dir = join(createPluginBootstrapRuntimeRoot(root).configDir, "opencode-quota");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.jsonc"), JSON.stringify(settings, null, 2));
}

export function seedDefaultPricingMocks(mocks: PricingMocks): void {
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

export function seedDefaultSessionTokenMocks(mocks: SessionTokenMocks): void {
  mocks.fetchSessionTokensForDisplay.mockResolvedValue({
    sessionTokens: undefined,
    error: undefined,
  });
}

export function seedDefaultAuthPlanMocks(mocks: AuthPlanMocks): void {
  mocks.resolveAlibabaCodingPlanAuthCached?.mockResolvedValue({ state: "none" });
}

export function seedDefaultPluginBootstrapMocks(
  mocks: PluginBootstrapMocks,
  options: PluginBootstrapOptions = {},
): void {
  vi.clearAllMocks();

  if (options.resetModules || options.resetPluginState) {
    // Fresh module instances clear module-level singleton state.
    vi.resetModules();
  }

  if (options.resetPluginState) {
    resetPluginTestState();
  }

  mocks.getProviders?.mockReturnValue(options.providers ?? []);

  if (mocks.fetchSessionTokensForDisplay && options.seedSessionTokens !== false) {
    seedDefaultSessionTokenMocks(mocks);
  }

  if (options.seedAuthPlans !== false) {
    seedDefaultAuthPlanMocks(mocks);
  }

  seedDefaultPricingMocks(mocks);
}

export function createPluginTestClient({
  modelID,
  providerID,
  sessionData,
}: {
  modelID?: string;
  providerID?: string;
  sessionData?: Record<string, unknown>;
} = {}) {
  const data = {
    ...(modelID === undefined && providerID === undefined
      ? {}
      : {
          model: {
            ...(modelID === undefined ? {} : { id: modelID }),
            ...(providerID === undefined ? {} : { providerID }),
          },
        }),
    ...(sessionData ?? {}),
  };

  return {
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data }),
      prompt: vi.fn().mockResolvedValue({}),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue({}),
    },
    app: {
      log: vi.fn().mockResolvedValue({}),
    },
  };
}

export function getPromptText(client: PromptClient, callIndex = 0): string {
  return client.session.prompt.mock.calls[callIndex]?.[0]?.body?.parts?.[0]?.text ?? "";
}

export function getToastMessage(client: ToastClient, callIndex = 0): string {
  return client.tui.showToast.mock.calls[callIndex]?.[0]?.body?.message ?? "";
}
