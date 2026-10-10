/**
 * Today's providers and settings, as the store needs them: which providers are on and
 * available, how to ask each one, and who it is signed in as. Temporary glue: the v6 settings
 * file (V3) replaces the settings part and the row contract (V8/V9) the legacy fetch part.
 */
import type { RuntimeContextRootHints } from "../lib/config-file-utils.js";
import type {
  QuotaProvider,
  QuotaProviderCacheContext,
  QuotaProviderContext,
} from "../lib/entries.js";
import {
  getQuotaProviderDisplayLabel,
  isLiveLocalUsageProviderId,
} from "../lib/provider-metadata.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  selectEligibleQuotaProviderDefinitions,
} from "../lib/quota-providers.js";
import {
  createQuotaProviderRuntimeContext,
  type QuotaRuntimeClient,
  type QuotaRuntimeContext,
  resolveQuotaRuntimeContext,
} from "../lib/quota-runtime-context.js";
import { rowsFromLegacyResult } from "./rows.js";
import { matchesQuotaProviderCurrentSelection } from "./selection.js";
import type { ProviderIdentity, StoreProvider, StoreSource } from "./store.js";
import type { SessionModel } from "./types.js";

export type ProviderSourceHost = { client: QuotaRuntimeClient; roots: RuntimeContextRootHints };

/** The settings the server reads besides the providers themselves. */
export type ModelProviderSettings = {
  waitForQuotaReset: boolean;
  /** The enabled providers that serve `model`. */
  providerIdsForModel: (model: SessionModel) => string[];
  /** The custom definitions (rows `quota-providers.custom.<id>.*`) that serve `model`. */
  customDefinitionIdsForModel: (model: SessionModel) => string[];
};

async function loadRuntime(host: ProviderSourceHost) {
  // The source never configures telemetry: the v5 surfaces still own it.
  return resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    configureTelemetry: false,
  });
}

function providerIdsForModel(runtime: QuotaRuntimeContext, model: SessionModel): string[] {
  const { config, providers } = runtime;
  return providers
    .filter((provider) =>
      matchesQuotaProviderCurrentSelection({
        provider,
        currentModel: model.id,
        currentProviderID: model.providerID,
        enabledProviders: config.enabledProviders,
        quotaProviders: config.quotaProviders,
      }),
    )
    .map((provider) => provider.id);
}

/** The quota-providers aggregate needs the custom definitions OpenCode can serve right now. */
async function cacheContextFor(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderCacheContext> {
  if (provider.id !== QUOTA_PROVIDERS_AGGREGATE_ID) return {};
  return {
    runtimeEligibleQuotaProviders: selectEligibleQuotaProviderDefinitions({
      definitions: ctx.config.quotaProviders ?? [],
      availableProviderIds: await ctx.resolveRuntimeProviderIds(),
    }),
  };
}

/** The signed-in account per the provider's cache policy; null when it can't be told safely. */
async function accountIdentity(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  cacheContext: QuotaProviderCacheContext,
): Promise<string | null> {
  const policy = provider.cachePolicy;
  if (!policy || policy.kind === "uncached") return null;
  if (policy.kind === "account-neutral") return "account-neutral";
  try {
    return await policy.resolveIdentity(ctx, cacheContext);
  } catch {
    return null;
  }
}

function storeProvider(
  provider: QuotaProvider,
  ctx: QuotaProviderContext,
  settingsKey: string,
): StoreProvider {
  return {
    id: provider.id,
    label: getQuotaProviderDisplayLabel(provider.id),
    // Cursor and Alibaba Coding Plan count OpenCode's own history: cheap, and stale at once.
    ...(isLiveLocalUsageProviderId(provider.id) ? { minIntervalMs: 0 } : {}),
    async identity(): Promise<ProviderIdentity> {
      const account = await accountIdentity(provider, ctx, await cacheContextFor(provider, ctx));
      return account === null
        ? { key: settingsKey, persist: false }
        : { key: `${account}\u001f${settingsKey}`, persist: true };
    },
    async fetch() {
      const result = await provider.fetch(ctx, await cacheContextFor(provider, ctx));
      return rowsFromLegacyResult(provider.id, result);
    },
  };
}

/** The store's source: enabled and available providers, read with today's settings. */
export async function loadProviderSource(host: ProviderSourceHost): Promise<StoreSource> {
  const runtime = await loadRuntime(host);
  const { config } = runtime;
  // "Only the current model" is a view filter in v6: every enabled provider is fetched.
  const legacyCtx = createQuotaProviderRuntimeContext({
    client: runtime.client,
    config: { ...config, onlyCurrentModel: false },
    configMeta: runtime.configMeta,
    session: {},
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    workspaceRoot: runtime.roots.workspaceRoot,
    configureTelemetry: false,
  });
  // The store keeps its own interval. The custom aggregate's own cache would hand back old
  // rows that the store then stamps as fresh, so it is off.
  const ctx = { ...legacyCtx, config: { ...legacyCtx.config, providerCacheTtlMs: 0 } };
  const enabled = !config.enabled
    ? []
    : config.enabledProviders === "auto"
      ? runtime.providers
      : runtime.providers.filter((provider) => config.enabledProviders.includes(provider.id));
  const available = await Promise.all(
    enabled.map(async (provider) => {
      try {
        return await provider.isAvailable(ctx);
      } catch {
        return false;
      }
    }),
  );
  // A settings change that alters what a provider reports also changes its identity.
  const settingsKey = JSON.stringify([
    config.anthropicBinaryPath ?? null,
    config.cursorPlan,
    config.cursorIncludedApiUsd ?? null,
    config.cursorBillingCycleStartDay ?? null,
    config.opencodeGoWindows ?? null,
    config.opencodeMonthlyLimit ?? null,
    config.quotaProviders ?? [],
  ]);
  return {
    providers: enabled
      .filter((_, index) => available[index])
      .map((provider) => storeProvider(provider, ctx, settingsKey)),
    minIntervalMs: config.minIntervalMs,
    providerIdsForModel: (model) => providerIdsForModel(runtime, model),
  };
}

export async function loadModelProviderSettings(
  host: ProviderSourceHost,
): Promise<ModelProviderSettings> {
  const runtime = await loadRuntime(host);
  const { config } = runtime;
  let availableProviderIds: ReadonlySet<string> = new Set();
  try {
    availableProviderIds = await runtime.resolveRuntimeProviderIds();
  } catch {
    // Without OpenCode's provider list no custom definition can be matched to a model.
  }
  return {
    waitForQuotaReset: config.waitForQuotaReset,
    providerIdsForModel: (model) => providerIdsForModel(runtime, model),
    customDefinitionIdsForModel: (model) =>
      selectEligibleQuotaProviderDefinitions({
        definitions: config.quotaProviders ?? [],
        availableProviderIds,
        onlyCurrentModel: true,
        currentModel: model.id,
        currentProviderID: model.providerID,
      }).map((definition) => definition.id),
  };
}
