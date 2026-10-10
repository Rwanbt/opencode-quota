import type { ProviderFetchResult } from "../providers/contract.js";
import type { CursorQuotaPlan } from "./cursor-pricing.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import type { ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { RuntimeProviderIdResolver } from "./runtime-provider-ids.js";

/**
 * The provider interface, and the legacy result the custom providers still return (built-in
 * providers return the row contract, `ProviderFetchResult`). `core/rows.ts` turns both into
 * v6 rows.
 */

/** What a custom row means; custom configs may still say `rate_limit` and `spend` (ADR 0001). */
export type AccountingResultType =
  | "quota"
  | "rate_limit"
  | "usage"
  | "spend"
  | "budget"
  | "balance"
  | "status";

export type AccountingAcquisitionMethod = "remote_api" | "local_estimation";

export type AccountingOwnership = "maintained" | "user_configured";

export type AccountingAuthority = "provider_reported" | "locally_derived";

export interface AccountingMetadata {
  /** What the row represents, independent of its percent/value render shape. */
  resultType: AccountingResultType;
  /** How the accounting value was acquired. */
  acquisitionMethod: AccountingAcquisitionMethod;
  /** Whether opencode-quota or the user owns the source definition. */
  ownership: AccountingOwnership;
  /** Whether the value came from the provider or was derived locally. */
  authority: AccountingAuthority;
  /** The custom definition id the row came from. */
  sourceId?: string;
  /** Source observation time only; never application fetch or cache time. */
  observedAtIso?: string;
}

/** When a fixed quota window started and ends, as its provider or local state reports it. */
export interface FixedWindowProjectionEvidence {
  kind: "fixed_window";
  startedAtIso: string;
  observedAtIso: string;
  endsAtIso: string;
  fullReset: true;
}

interface QuotaEntryMeta {
  accounting: AccountingMetadata;
  /** "<source label> <row name>"; the row name after the group is the fallback row key. */
  name: string;
  /** The custom source's label: the row's account. */
  group?: string;
  /** The row label, e.g. "Daily:". */
  label?: string;
  /** A compact "used/limit" summary, e.g. "26/100" or "$2.00/$10.00". */
  right?: string;
  /** The row key from configured ids (a local window's id, a json-v1 mapping's name). */
  rowKey?: string;
  resetTimeIso?: string;
}

export type QuotaPercentEntry = QuotaEntryMeta & {
  kind?: "percent";
  /** Remaining quota as a percentage (may be below 0 when over quota). */
  percentRemaining: number;
  fixedWindow?: FixedWindowProjectionEvidence;
};

export type QuotaValueEntry = QuotaEntryMeta & {
  kind: "value";
  value: string;
};

export type QuotaToastEntry = QuotaPercentEntry | QuotaValueEntry;

export interface QuotaToastError {
  /** Short label that will be rendered as "label: message". */
  label: string;
  message: string;
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

export interface QuotaProviderDiagnostic {
  sourceId: string;
  providerId: string;
  mode: QuotaProviderDefinition["mode"];
  format?: Extract<QuotaProviderDefinition, { mode: "remote-api" }>["format"];
  /** Null means the source covers every model for providerId. */
  modelIds: string[] | null;
  /** Explicit environment-variable name only; never its value. */
  apiKeyEnv: string | null;
  selected: true;
  attempted: boolean;
  credentialSource:
    | "explicit_env"
    | "global_opencode_json"
    | "global_opencode_jsonc"
    | "opencode_db"
    | null;
  outcome:
    | "missing_credential"
    | "success"
    | "http_error"
    | "redirect_error"
    | "timeout"
    | "body_too_large"
    | "invalid_content_type"
    | "invalid_json"
    | "invalid_response"
    | "network_error"
    | "local_state_error";
  httpStatus?: number;
  entryCount: number;
  checkedPaths: string[];
  credentialDatabasePaths: string[];
  statePath?: string;
  stateHealth?: "missing" | "healthy" | "malformed" | "version_mismatch";
  stateVersion?: number | null;
  stateLastUpdatedAt?: number | null;
}

export interface QuotaProviderResult {
  /** True when provider had enough configuration to attempt a query. */
  attempted: boolean;
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  /** Each custom definition's check, for /quota_status and the export's source list. */
  diagnostics?: QuotaProviderDiagnostic[];
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

  /** Fetch quota: built-in providers return the row contract, custom providers a legacy result. */
  fetch: (
    ctx: QuotaProviderContext,
    cacheContext?: QuotaProviderCacheContext,
  ) => Promise<QuotaProviderResult | ProviderFetchResult>;

  /**
   * Shared-cache safety policy. Canonical runtime providers are classified in
   * the registry. Missing policy fails closed as uncached; account-neutral
   * caching must be explicit.
   */
  cachePolicy?: QuotaProviderCachePolicy;

  /** Optional provider match for onlyCurrentModel filtering */
  matchesCurrentModel?: (model: string, context?: QuotaProviderMatchContext) => boolean;
}
