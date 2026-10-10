/**
 * The provider interface and what a provider is given. Providers return the row contract
 * (`ProviderFetchResult`, see `providers/contract.ts`).
 */
import type { ProviderFetchResult } from "../providers/contract.js";
import type { CursorQuotaPlan } from "./cursor-pricing.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import type { ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { RuntimeProviderIdResolver } from "./runtime-provider-ids.js";

/** When a fixed quota window started and ends, as its provider or local state reports it. */
export interface FixedWindowProjectionEvidence {
  kind: "fixed_window";
  startedAtIso: string;
  observedAtIso: string;
  endsAtIso: string;
  fullReset: true;
}

/** Per-model token summary for current session (toast display). */
export interface SessionTokenModel {
  modelID: string;
  input: number;
  cachedInput?: number;
  totalInput?: number;
  output: number;
}

/** Session tokens data for toast display. */
export interface SessionTokensData {
  models: SessionTokenModel[];
  totalInput: number;
  totalCachedInput?: number;
  totalCombinedInput?: number;
  totalOutput: number;
}

export interface QuotaProviderMatchContext {
  enabledProviders: string[] | "auto";
  quotaProviders?: QuotaProviderDefinition[];
  currentProviderID?: string;
}

export interface QuotaProviderContext {
  client: {
    config: {
      providers: () => Promise<{ data?: { providers: Array<{ id: string }> } }>;
    };
  };
  resolveRuntimeProviderIds: RuntimeProviderIdResolver;
  /**
   * The project folder quota is computed for: the git root of the OpenCode location, or the
   * location itself. The terminal command computes quota for the home folder.
   */
  workspaceRoot: string;
  config: {
    anthropicBinaryPath?: string;
    cursorPlan: CursorQuotaPlan;
    cursorIncludedApiUsd?: number;
    cursorBillingCycleStartDay?: number;
    opencodeMonthlyLimit?: number;
    requestTimeoutMs?: number;
    /** True when the settings file sets checking.requestTimeoutMs (not its default). */
    requestTimeoutMsConfigured?: boolean;
    onlyCurrentModel?: boolean;
    currentModel?: string;
    currentProviderID?: string;
    enabledProviders: string[] | "auto";
    quotaProviders?: QuotaProviderDefinition[];
  };
}

export interface QuotaProviderCacheContext {
  runtimeEligibleQuotaProviders?: readonly QuotaProviderDefinition[];
}

export type QuotaProviderCachePolicy =
  | { kind: "account-neutral" }
  | { kind: "uncached" }
  | {
      kind: "resolved-auth";
      resolveIdentity: (
        ctx: QuotaProviderContext,
        cacheContext: QuotaProviderCacheContext,
      ) => Promise<ResolvedAuthIdentity | null>;
    };

export interface QuotaProvider {
  /** Stable id used by config.enabledProviders */
  id: string;

  /** Best-effort availability check (no network if possible) */
  isAvailable: (ctx: QuotaProviderContext) => Promise<boolean>;

  /** Fetch quota as the row contract. */
  fetch: (
    ctx: QuotaProviderContext,
    cacheContext?: QuotaProviderCacheContext,
  ) => Promise<ProviderFetchResult>;

  /**
   * Shared-cache safety policy. Canonical runtime providers are classified in
   * the registry. Missing policy fails closed as uncached; account-neutral
   * caching must be explicit.
   */
  cachePolicy?: QuotaProviderCachePolicy;

  /** Optional provider match for onlyCurrentModel filtering */
  matchesCurrentModel?: (model: string, context?: QuotaProviderMatchContext) => boolean;
}
