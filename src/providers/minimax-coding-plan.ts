/** MiniMax Token Plan quota (international and China endpoints), one canonical model per account. */

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  AccountingPercentageBasis,
  AccountingQuantity,
  AccountingWindow,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { fetchWithTimeout } from "../lib/http.js";
import { asRecord } from "../lib/json-guards.js";
import {
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
  getMiniMaxAuthDiagnostics,
  getMiniMaxChinaAuthDiagnostics,
  type MiniMaxAuthDiagnostics,
  type ResolvedMiniMaxAuth,
  resolveMiniMaxAuth,
  resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuth,
  resolveMiniMaxChinaAuthCached,
} from "../lib/minimax-auth.js";
import { getMiniMaxQuotaEndpoint, type MiniMaxQuotaEndpointId } from "../lib/minimax-endpoints.js";
import {
  isAnyProviderIdAvailable,
  isCanonicalProviderAvailable,
} from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { AuthData } from "../lib/types.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { readKeyLoginRows } from "./key-login-rows.js";
import {
  apiKeyStatusDetails,
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const MINIMAX_PROVIDER_LABEL = "MiniMax Token Plan";
const MINIMAX_CHINA_PROVIDER_LABEL = "MiniMax Token Plan (CN)";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

const MINIMAX_TOKEN_PLAN_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

const REQUEST_UNIT = { kind: "count", unit: "request" } as const;

interface MiniMaxModelRemain {
  model_name: string;
  current_interval_total_count?: number;
  /** Endpoint-specific raw count: international reports remaining, China reports used. */
  current_interval_usage_count?: number;
  remains_time: number;
  current_weekly_total_count?: number;
  /** Endpoint-specific raw count: international reports remaining, China reports used. */
  current_weekly_usage_count?: number;
  weekly_remains_time?: number;
  /** Provider-reported remaining percentage used by supported percentage-only responses. */
  current_interval_remaining_percent?: number;
  current_weekly_remaining_percent?: number;
}

interface MiniMaxApiResponse {
  model_remains: MiniMaxModelRemain[];
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface MiniMaxWindowSpec {
  window: AccountingWindow;
  name: string;
  label: string;
  getTotal(model: MiniMaxModelRemain): number | undefined;
  getCount(model: MiniMaxModelRemain): number | undefined;
  getResetOffsetMs(model: MiniMaxModelRemain): number | undefined;
  getPercentRemaining(model: MiniMaxModelRemain): number | undefined;
}

const MINIMAX_WINDOW_SPECS: readonly MiniMaxWindowSpec[] = [
  {
    window: "five_hour",
    name: "minimax-token-plan-5h",
    label: "5h:",
    getTotal: (model) => model.current_interval_total_count,
    getCount: (model) => model.current_interval_usage_count,
    getResetOffsetMs: (model) => model.remains_time,
    getPercentRemaining: (model) => model.current_interval_remaining_percent,
  },
  {
    window: "week",
    name: "minimax-token-plan-week",
    label: "Weekly:",
    getTotal: (model) => model.current_weekly_total_count,
    getCount: (model) => model.current_weekly_usage_count,
    getResetOffsetMs: (model) => model.weekly_remains_time,
    getPercentRemaining: (model) => model.current_weekly_remaining_percent,
  },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Accepts the count shape or the percentage-only shape; a finite 5-hour reset offset is required. */
function isMiniMaxModelRecord(value: unknown): value is MiniMaxModelRemain {
  const v = asRecord(value);
  if (!v || typeof v.model_name !== "string" || !isFiniteNumber(v.remains_time)) return false;
  const hasCounts =
    isFiniteNumber(v.current_interval_total_count) &&
    isFiniteNumber(v.current_interval_usage_count);
  return hasCounts || isFiniteNumber(v.current_interval_remaining_percent);
}

function isMiniMaxCodingModelName(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return normalized.startsWith("minimax-m") || normalized === "general";
}

function roundPercent(value: number): number {
  return Math.min(100, Math.round(value));
}

function requests(value: number): AccountingQuantity {
  return { decimal: accountingDecimalFromNumber(value), unit: REQUEST_UNIT };
}

function sanitizeMiniMaxMessage(text: string): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, 120);
}

/**
 * Used/limit/remaining facts for a row with a positive total. The raw count is endpoint-specific:
 * China reports the used count, international the remaining count.
 */
function countBasis(
  total: number,
  rawCount: number,
  endpointId: MiniMaxQuotaEndpointId,
): { basis: AccountingPercentageBasis; remaining: number } {
  const reportsUsed = endpointId === "china";
  const used = reportsUsed ? Math.max(0, rawCount) : total - Math.min(total, rawCount);
  const remaining = reportsUsed ? total - used : Math.min(total, rawCount);
  return {
    basis: {
      used: {
        quantity: requests(used),
        authority: reportsUsed ? "provider_reported" : "locally_derived",
      },
      limit: { quantity: requests(total), authority: "provider_reported" },
      remaining: {
        quantity: requests(remaining),
        authority: reportsUsed ? "locally_derived" : "provider_reported",
      },
    },
    remaining,
  };
}

function buildMiniMaxEntry(
  model: MiniMaxModelRemain,
  spec: MiniMaxWindowSpec,
  providerLabel: string,
  endpointId: MiniMaxQuotaEndpointId,
): QuotaToastEntry | null {
  const resetOffsetMs = spec.getResetOffsetMs(model);
  if (!isFiniteNumber(resetOffsetMs)) return null;

  const total = spec.getTotal(model);
  const rawCount = spec.getCount(model);
  let percentRemaining: number;
  let basis: AccountingPercentageBasis | undefined;
  if (isFiniteNumber(total) && total > 0 && isFiniteNumber(rawCount)) {
    const counts = countBasis(total, rawCount, endpointId);
    percentRemaining = roundPercent((counts.remaining / total) * 100);
    basis = counts.basis;
  } else {
    // New plan rows (general bucket, total=0) only report a percent. China counts never fall
    // back to it except on general rows. No basis: a lone percent fact would just duplicate
    // percentRemaining in the display.
    const percent =
      endpointId === "international" || model.model_name.trim().toLowerCase() === "general"
        ? spec.getPercentRemaining(model)
        : undefined;
    if (!isFiniteNumber(percent)) return null;
    percentRemaining = roundPercent(percent);
  }

  return {
    name: spec.name,
    group: providerLabel,
    label: spec.label,
    percentRemaining,
    ...(basis ? { basis } : {}),
    resetTimeIso: new Date(Date.now() + Math.max(0, resetOffsetMs)).toISOString(),
    semantic: { metric: { kind: "window", window: spec.window }, prominence: "primary" },
    accounting: MINIMAX_TOKEN_PLAN_ACCOUNTING,
  };
}

function buildMiniMaxEntries(
  model: MiniMaxModelRemain,
  providerLabel: string,
  endpointId: MiniMaxQuotaEndpointId,
): QuotaToastEntry[] {
  return MINIMAX_WINDOW_SPECS.flatMap((spec) => {
    const entry = buildMiniMaxEntry(model, spec, providerLabel, endpointId);
    return entry ? [entry] : [];
  });
}

function getWorstPercent(model: MiniMaxModelRemain, endpointId: MiniMaxQuotaEndpointId): number {
  const percents = buildMiniMaxEntries(model, MINIMAX_PROVIDER_LABEL, endpointId).flatMap(
    (entry) => ("percentRemaining" in entry ? [entry.percentRemaining] : []),
  );
  return percents.length > 0 ? Math.min(...percents) : Number.POSITIVE_INFINITY;
}

/** The `MiniMax-M*` wildcard row when it reports quota, else the model with the least left. */
function selectCanonicalMiniMaxModel(
  models: MiniMaxModelRemain[],
  endpointId: MiniMaxQuotaEndpointId,
): MiniMaxModelRemain | null {
  const wildcardModel = models.find(
    (model) => model.model_name.trim().toLowerCase() === "minimax-m*",
  );
  if (wildcardModel && Number.isFinite(getWorstPercent(wildcardModel, endpointId))) {
    return wildcardModel;
  }

  return (
    [...models].sort((left, right) => {
      const percentDiff = getWorstPercent(left, endpointId) - getWorstPercent(right, endpointId);
      if (percentDiff !== 0) return percentDiff;
      return left.model_name.localeCompare(right.model_name);
    })[0] ?? null
  );
}

/** Entries on success (empty when no coding model reports quota), one error row on failure. */
export async function queryMiniMaxQuota(
  apiKey: string,
  options: { requestTimeoutMs?: number; endpoint?: MiniMaxQuotaEndpointId; label?: string } = {},
): Promise<QuotaProviderResult> {
  const endpointId = options.endpoint ?? "international";
  const label = options.label ?? MINIMAX_PROVIDER_LABEL;
  try {
    return await fetchWithTimeout(getMiniMaxQuotaEndpoint(endpointId).quotaUrl, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const text = await response.text();
          return attemptedErrorResult(
            label,
            `MiniMax API error ${response.status}: ${sanitizeMiniMaxMessage(text)}`,
          );
        }

        const payload = (await response.json()) as MiniMaxApiResponse;
        if (payload.base_resp?.status_code !== 0) {
          return attemptedErrorResult(
            label,
            `MiniMax API error: ${sanitizeMiniMaxMessage(payload.base_resp?.status_msg ?? "unknown")}`,
          );
        }

        const matchingModels = (payload.model_remains ?? []).filter(
          (model): model is MiniMaxModelRemain =>
            isMiniMaxModelRecord(model) && isMiniMaxCodingModelName(model.model_name),
        );
        const canonicalModel = selectCanonicalMiniMaxModel(matchingModels, endpointId);
        return attemptedResult(
          canonicalModel ? buildMiniMaxEntries(canonicalModel, label, endpointId) : [],
        );
      },
    });
  } catch (err) {
    return attemptedErrorResult(
      label,
      sanitizeMiniMaxMessage(err instanceof Error ? err.message : String(err)),
    );
  }
}

type MiniMaxProviderSpec = {
  id: "minimax-coding-plan" | "minimax-china-coding-plan";
  label: string;
  endpoint: MiniMaxQuotaEndpointId;
  resolveAuthCached: (params?: { maxAgeMs?: number }) => Promise<ResolvedMiniMaxAuth>;
  resolveCredentialAuth: (auth: AuthData) => ResolvedMiniMaxAuth;
  credentialIntegrationIds: readonly string[];
  getAuthDiagnostics: (params?: { maxAgeMs?: number }) => Promise<MiniMaxAuthDiagnostics>;
};

/** The ambiguous `minimax` runtime id counts for China only when China is explicitly enabled. */
function isMiniMaxChinaExplicitlyEnabled(context?: QuotaProviderMatchContext): boolean {
  if (!context || context.enabledProviders === "auto") return false;
  return context.enabledProviders.some(
    (providerId) => normalizeQuotaProviderId(providerId) === "minimax-china-coding-plan",
  );
}

function usageDetail(entry: QuotaToastEntry | undefined): string | undefined {
  if (!entry) return undefined;
  const percent = "percentRemaining" in entry ? entry.percentRemaining : undefined;
  return `percent_remaining=${percent ?? "(none)"} reset_at=${entry.resetTimeIso ?? "(none)"}`;
}

function createMiniMaxProvider(spec: MiniMaxProviderSpec): QuotaProvider {
  const query = (apiKey: string, ctx: QuotaProviderContext) =>
    queryMiniMaxQuota(apiKey, {
      endpoint: spec.endpoint,
      label: spec.label,
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

  return {
    id: spec.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable =
        (await isCanonicalProviderAvailable({
          ctx,
          providerId: spec.id,
          fallbackOnError: false,
        })) ||
        (spec.id === "minimax-china-coding-plan" &&
          isMiniMaxChinaExplicitlyEnabled(ctx.config) &&
          (await isAnyProviderIdAvailable({
            ctx,
            candidateIds: ["minimax"],
            fallbackOnError: false,
          })));
      if (!providerAvailable) return false;

      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
      const [provider = "", modelId] = model.toLowerCase().split("/", 2);
      if (!modelId || !isMiniMaxCodingModelName(modelId)) return false;

      const normalizedProvider = normalizeQuotaProviderId(provider);
      if (spec.id === "minimax-coding-plan") {
        return normalizedProvider === "minimax-coding-plan";
      }
      return (
        normalizedProvider === "minimax-china-coding-plan" ||
        (provider === "minimax" && isMiniMaxChinaExplicitlyEnabled(context))
      );
    },

    async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
      const diagnostics = await spec.getAuthDiagnostics({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });
      const endpoint =
        diagnostics.state === "configured"
          ? getMiniMaxQuotaEndpoint(diagnostics.endpoint)
          : undefined;
      const statusDetails = [
        ...apiKeyStatusDetails(diagnostics),
        ...statusDetailsFromRecord({
          api_endpoint: endpoint?.id,
          api_base_url: endpoint?.apiBaseUrl,
        }),
      ];
      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
      });

      if (auth.state === "none") {
        return withStatusDetails(notAttemptedResult(), statusDetails);
      }

      if (diagnostics.source === "opencode.db") {
        const { credentials, invalidErrors } = await readKeyLoginRows({
          integrationIds: spec.credentialIntegrationIds,
          label: spec.label,
          parseAuth: spec.resolveCredentialAuth,
        });
        if (credentials.length > 0 || invalidErrors.length > 0) {
          const results = await Promise.all(
            credentials.map(async ({ row, displayName, auth }) => ({
              row,
              group: displayName,
              result: await query(auth.apiKey, ctx),
            })),
          );
          const entries: QuotaProviderResult["entries"] = [];
          const errors: QuotaProviderResult["errors"] = [...invalidErrors];
          for (const { row, group, result } of results) {
            if (result.errors.length > 0) {
              errors.push(...result.errors.map((error) => ({ ...error, label: group })));
              continue;
            }
            entries.push(
              ...result.entries.map((entry) => ({
                ...entry,
                group,
                accounting: { ...entry.accounting, sourceId: row.id },
              })),
            );
          }
          return withStatusDetails(attemptedResult(entries, errors), statusDetails);
        }
      }

      if (auth.state === "invalid") {
        return withStatusDetails(attemptedErrorResult(spec.label, auth.error), statusDetails);
      }

      const result = await query(auth.apiKey, ctx);
      if (result.errors.length > 0) {
        const message = result.errors[0]?.message ?? "MiniMax API error";
        return withStatusDetails(attemptedErrorResult(spec.label, message), [
          ...statusDetails,
          { key: "live_fetch_error", value: message },
        ]);
      }

      const fiveHourEntry = result.entries.find((entry) => entry.name === "minimax-token-plan-5h");
      const weeklyEntry = result.entries.find((entry) => entry.name === "minimax-token-plan-week");
      return withStatusDetails(result, [
        ...statusDetails,
        ...statusDetailsFromRecord({
          five_hour_usage: usageDetail(fiveHourEntry),
          weekly_usage: usageDetail(weeklyEntry),
          live_state:
            !fiveHourEntry && !weeklyEntry ? `no reportable ${spec.label} quota` : undefined,
        }),
      ]);
    },
  };
}

export const minimaxCodingPlanProvider: QuotaProvider = createMiniMaxProvider({
  id: "minimax-coding-plan",
  label: MINIMAX_PROVIDER_LABEL,
  endpoint: "international",
  resolveAuthCached: resolveMiniMaxAuthCached,
  resolveCredentialAuth: resolveMiniMaxAuth,
  credentialIntegrationIds: ["minimax-coding-plan"],
  getAuthDiagnostics: getMiniMaxAuthDiagnostics,
});

export const minimaxChinaCodingPlanProvider: QuotaProvider = createMiniMaxProvider({
  id: "minimax-china-coding-plan",
  label: MINIMAX_CHINA_PROVIDER_LABEL,
  endpoint: "china",
  resolveAuthCached: resolveMiniMaxChinaAuthCached,
  resolveCredentialAuth: resolveMiniMaxChinaAuth,
  credentialIntegrationIds: ["minimax-china-coding-plan", "minimax-cn-coding-plan"],
  getAuthDiagnostics: getMiniMaxChinaAuthDiagnostics,
});
