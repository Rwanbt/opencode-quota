import type { ProviderFetchResult } from "../providers/contract.js";
import type { CursorQuotaPlan } from "./cursor-pricing.js";
import type { QuotaProviderDefinition } from "./quota-providers.js";
import type { ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { RuntimeProviderIdResolver } from "./runtime-provider-ids.js";

/**
 * Normalized quota output model.
 *
 * Providers should map their internal quota shapes into these types so that
 * formatting and toast display stays universal across providers.
 */

export type AccountingResultType =
  | "quota"
  | "rate_limit"
  | "usage"
  | "spend"
  | "budget"
  | "balance"
  | "status";

export type AccountingAcquisitionMethod =
  | "remote_api"
  | "dashboard_scrape"
  | "local_cli"
  | "local_runtime_accounting"
  | "local_estimation";

export type AccountingOwnership = "maintained" | "user_configured";

export type AccountingAuthority = "provider_reported" | "locally_derived";

export type AccountingProminence = "primary" | "supplementary";

export type AccountingWindow =
  | "rpm"
  | "hour"
  | "five_hour"
  | "day"
  | "week"
  | "month"
  | "year"
  | "mcp"
  | "code_review";

export type AccountingComponent =
  | "current_balance"
  | "total_balance"
  | "cash_balance"
  | "gift_balance"
  | "granted_balance"
  | "topped_up_balance"
  | "remaining_credits"
  | "auto_reload"
  | "auto_reload_amount"
  | "auto_reload_trigger";

export type AccountingMetric =
  | { kind: "aggregate" }
  | { kind: "window"; window: AccountingWindow }
  | { kind: "component"; component: AccountingComponent }
  | { kind: "named"; name: string };

export interface AccountingSemantic {
  metric: AccountingMetric;
  prominence: AccountingProminence;
}

export type AccountingCountUnit =
  | "request"
  | "token"
  | "credit"
  | "message"
  | "interaction"
  | "unit";

export type AccountingUnit =
  | { kind: "currency"; code: string }
  | { kind: "count"; unit: AccountingCountUnit }
  | { kind: "custom"; symbol: string };

export interface AccountingQuantity {
  decimal: string;
  unit: AccountingUnit;
}

export type AccountingFactAuthority = AccountingAuthority | "user_configured";

export interface AccountingBasisFact {
  quantity: AccountingQuantity;
  authority: AccountingFactAuthority;
}

export interface AccountingPercentageBasis {
  used?: AccountingBasisFact;
  limit?: AccountingBasisFact;
  remaining?: AccountingBasisFact;
}

export interface AccountingMetadata {
  /** What the row represents, independent of its percent/value render shape. */
  resultType: AccountingResultType;
  /** How the accounting value was acquired. */
  acquisitionMethod: AccountingAcquisitionMethod;
  /** Whether opencode-quota or the user owns the source definition. */
  ownership: AccountingOwnership;
  /** Whether the value came from the provider or was derived locally. */
  authority: AccountingAuthority;
  /** Stable configured source identity when one aggregate provider owns multiple sources. */
  sourceId?: string;
  /** Source observation time only; never application fetch or cache time. */
  observedAtIso?: string;
}

export interface FixedWindowProjectionEvidence {
  kind: "fixed_window";
  startedAtIso: string;
  observedAtIso: string;
  endsAtIso: string;
  fullReset: true;
}

export type QuotaRunwayProjection =
  | { kind: "before_reset"; projectedAtIso: string }
  | { kind: "lasts_past_reset" };

export interface GroupedQuotaEntryMeta {
  /** Required provider-neutral accounting semantics for this row. */
  accounting: AccountingMetadata;
  /** Optional provider/account group header for grouped toast and /quota output. */
  group?: string;
  /** Optional row label inside the group, e.g. "5h:" or "Usage:". */
  label?: string;
  /** Optional legacy label for verbose command output when it differs from resultType. */
  metricLabel?: string;
  /** Complete provider-neutral row semantics. Rich providers require this on every row. */
  semantic?: AccountingSemantic;
  /** Optional compact right-hand summary for legacy and configured providers only. */
  right?: string;
  /** Optional stable row priority within a group; lower values render first. */
  sortPriority?: number;
  /** Optional stable row key from configured ids (custom local windows), for v6 row ids. */
  rowKey?: string;
}

type SemanticGroupedQuotaEntryMeta = Omit<GroupedQuotaEntryMeta, "semantic"> & {
  semantic: AccountingSemantic;
};

export type QuotaPercentEntry = GroupedQuotaEntryMeta & {
  /** The optional discriminant preserves the existing percent-entry shape. */
  kind?: "percent";
  name: string;
  /** Remaining quota as a percentage (may be below 0 when over quota). */
  percentRemaining: number;
  /** Optional typed operands. Renderers never derive a percentage from these facts. */
  basis?: AccountingPercentageBasis;
  resetTimeIso?: string;
  /** Internal provider evidence for fixed-window exhaustion projection. */
  fixedWindow?: FixedWindowProjectionEvidence;
  /** Presentation-only projection. Provider caches must never persist this field. */
  runway?: QuotaRunwayProjection;
};

export type QuotaValueEntry = GroupedQuotaEntryMeta & {
  /** Legacy formatted text value. */
  kind: "value";
  name: string;
  value: string;
  resetTimeIso?: string;
};

export type QuotaQuantityEntry = SemanticGroupedQuotaEntryMeta & {
  kind: "quantity";
  name: string;
  quantity: AccountingQuantity;
  resetTimeIso?: string;
};

export type QuotaBooleanEntry = SemanticGroupedQuotaEntryMeta & {
  kind: "boolean";
  name: string;
  value: boolean;
  resetTimeIso?: string;
};

export type QuotaToastEntry =
  | QuotaPercentEntry
  | QuotaValueEntry
  | QuotaQuantityEntry
  | QuotaBooleanEntry;

export interface QuotaToastError {
  /** Short label that will be rendered as "label: message". */
  label: string;
  message: string;
  /** Whether a later refresh may succeed without user action. */
  retryable?: boolean;
  /** Intentional diagnostics remain verbose but do not count as compact-status issues. */
  kind?: "intentional-filter";
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

export interface QuotaProviderStatusDetail {
  readonly key: string;
  readonly value: string;
}

export interface QuotaProviderPresentation {
  singleWindowDisplayName?: string;
  singleWindowShowRight?: boolean;
  /**
   * A family label that display projections should replace with a generic
   * quota label. Raw provider entries remain unchanged.
   */
  redundantQuotaFamily?: string;
  /**
   * When set to "preserve", the provider's entries are kept individually
   * (one per window) even in single-window format styles.
   */
  classicStrategy?: "preserve";
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
  /** Internal provider diagnostics; not projected into normal presentation/export surfaces. */
  diagnostics?: QuotaProviderDiagnostic[];
  /**
   * Safe, single-line provider details from this fetch attempt. Diagnostic consumers
   * may reuse them, but must not refetch when details are absent.
   */
  statusDetails?: readonly QuotaProviderStatusDetail[];
  /** Safe provider-owned facts preserved in cache and JSON exports, never human presentation. */
  rawDetails?: readonly QuotaProviderStatusDetail[];
  presentation?: QuotaProviderPresentation;
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

  /** Fetch quota for this provider: on the row contract, or as a legacy result. */
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
