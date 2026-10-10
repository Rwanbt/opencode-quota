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
import { matchesQuotaProviderCurrentSelection } from "../lib/quota-render-data.js";
import {
  createQuotaProviderRuntimeContext,
  type QuotaRuntimeClient,
  resolveQuotaRuntimeContext,
} from "../lib/quota-runtime-context.js";
import type { MaintainerAnnouncementHomeFrequency, SessionTokenScope } from "../lib/types.js";
import { rowsFromLegacyResult } from "./rows.js";
import type { ProviderIdentity, StoreProvider, StoreSource } from "./store.js";

export type ProviderSourceHost = { client: QuotaRuntimeClient; roots: RuntimeContextRootHints };

/** A session's model: its id and OpenCode's provider id. */
export type SessionModel = { id?: string; providerID?: string };

/** The settings the server reads besides the providers themselves. */
export type ServerSettings = {
  /** False when the user turned OpenCode Quota off. */
  enabled: boolean;
  waitForQuotaReset: boolean;
  /** The enabled providers that serve `model`. */
  providerIdsForModel: (model: SessionModel) => string[];
  /** Session tokens of the session only, or with its subagents. */
  sessionTokenScope: SessionTokenScope;
  /** The maintainer notice on Home: off, once a day, or every time. */
  homeNotice: "off" | MaintainerAnnouncementHomeFrequency;
  /** The export file, written after each snapshot change when on. */
  export: { enabled: boolean; path: string };
  /** Quota gauges through the host's OpenTelemetry MeterProvider. */
  telemetry: boolean;
};

async function loadRuntime(host: ProviderSourceHost) {
  return resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
  });
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
  const ctx = createQuotaProviderRuntimeContext({
    client: runtime.client,
    config: { ...config, onlyCurrentModel: false },
    configMeta: runtime.configMeta,
    session: {},
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    workspaceRoot: runtime.roots.workspaceRoot,
  });
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
  };
}

export async function loadServerSettings(host: ProviderSourceHost): Promise<ServerSettings> {
  const { config, providers } = await loadRuntime(host);
  const announcements = config.maintainerAnnouncements;
  return {
    enabled: config.enabled,
    waitForQuotaReset: config.waitForQuotaReset,
    providerIdsForModel: (model) =>
      providers
        .filter((provider) =>
          matchesQuotaProviderCurrentSelection({
            provider,
            currentModel: model.id,
            currentProviderID: model.providerID,
            enabledProviders: config.enabledProviders,
            quotaProviders: config.quotaProviders,
          }),
        )
        .map((provider) => provider.id),
    sessionTokenScope: config.sessionTokenScope,
    homeNotice:
      config.enabled && announcements.enabled && announcements.home
        ? announcements.homeFrequency
        : "off",
    export: { enabled: config.enabled && config.export.enabled, path: config.export.path },
    telemetry: config.enabled && config.telemetry.enabled,
  };
}
