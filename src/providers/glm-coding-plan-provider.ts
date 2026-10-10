import {
  API_KEY_LOGIN_CACHE_MAX_AGE_MS,
  type ApiKeyLoginSpec,
  getApiKeyLoginDiagnostics,
  parseApiKeyLogin,
  resolveApiKeyLogin,
} from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import {
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-metadata.js";
import type { ZaiQuotaResult, ZaiResult } from "../lib/types.js";
import {
  apiKeyStatusDetails,
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type GlmQuotaWindow = ZaiQuotaResult["windows"]["weekly"];

function glmWindowRows(quota: ZaiQuotaResult) {
  return [
    { window: quota.windows.fiveHour, suffix: "5h", label: "5h:" },
    { window: quota.windows.weekly, suffix: "Weekly", label: "Weekly:" },
    { window: quota.windows.mcp, suffix: "MCP", label: "MCP:" },
  ];
}

export function createGlmCodingPlanProvider(params: {
  id: "zai" | "zhipu";
  providerId: CanonicalQuotaProviderId;
  errorLabel: string;
  auth: ApiKeyLoginSpec;
  queryQuota: (params: { requestTimeoutMs?: number; apiKey?: string }) => Promise<ZaiResult>;
  matchesCurrentModel: (model: string) => boolean;
}): QuotaProvider {
  return {
    id: params.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable = await isCanonicalProviderAvailable({
        ctx,
        providerId: params.providerId,
        fallbackOnError: false,
      });
      if (!providerAvailable) return false;

      const auth = await resolveApiKeyLogin(params.auth, {
        maxAgeMs: API_KEY_LOGIN_CACHE_MAX_AGE_MS,
      });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel: params.matchesCurrentModel,

    async fetch(ctx: QuotaProviderContext) {
      const diagnostics = await getApiKeyLoginDiagnostics(params.auth, {
        maxAgeMs: API_KEY_LOGIN_CACHE_MAX_AGE_MS,
      });
      const authDetails = apiKeyStatusDetails(diagnostics);
      if (diagnostics.source === "opencode.db") {
        const credentials = (
          await readCredentialRows(params.auth.authKeys, { methods: ["key"] })
        ).flatMap((row) => {
          if (!params.auth.authKeys.includes(row.integrationId)) return [];
          const auth = parseApiKeyLogin(params.auth, {
            [row.integrationId]: credentialRowAuthEntry(row),
          });
          // An invalid login stays in the list so it shows as its own error row.
          return auth.state === "none" ? [] : [{ row, auth }];
        });
        if (credentials.length > 0) {
          const results = await Promise.all(
            credentials.map(async ({ row, auth }) => ({
              row,
              result:
                auth.state === "invalid"
                  ? { success: false as const, error: auth.error }
                  : await params.queryQuota({
                      requestTimeoutMs: ctx.config?.requestTimeoutMs,
                      apiKey: auth.apiKey,
                    }),
            })),
          );
          // A successful query is labelled `errorLabel` too, so it is every row's fallback name.
          const names = formatCredentialDisplayNames(
            params.errorLabel,
            results.map(({ row }) => ({ row, fallbackName: params.errorLabel })),
          );
          const entries = [];
          const errors = [];
          for (const [index, { row, result }] of results.entries()) {
            const group = names[index] ?? params.errorLabel;
            const mapped = mapNullableProviderResult(result, {
              errorLabel: group,
              onSuccess: (quota) =>
                attemptedResult(
                  groupedPercentWindowEntries({
                    group,
                    accounting: {
                      resultType: "quota",
                      acquisitionMethod: "remote_api",
                      ownership: "maintained",
                      authority: "provider_reported",
                      sourceId: row.id,
                    },
                    windows: glmWindowRows(quota),
                  }),
                ),
            });
            entries.push(...mapped.entries);
            errors.push(...mapped.errors);
          }
          return withStatusDetails(attemptedResult(entries, errors), authDetails);
        }
      }
      const result = await params.queryQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
      const providerResult = mapNullableProviderResult(result, {
        errorLabel: params.errorLabel,
        onSuccess: (quota) =>
          attemptedResult(
            groupedPercentWindowEntries({
              group: quota.label,
              accounting: {
                resultType: "quota",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
              },
              windows: glmWindowRows(quota),
            }),
            [],
            { singleWindowDisplayName: quota.label },
          ),
      });
      const windows = result?.success ? result.windows : {};
      const formatWindow = (window: GlmQuotaWindow | undefined): string | undefined =>
        window
          ? `${window.percentRemaining}% reset_at=${window.resetTimeIso ?? "(none)"}`
          : undefined;
      return withStatusDetails(providerResult, [
        ...authDetails,
        ...statusDetailsFromRecord({
          live_fetch_error: !result
            ? `${params.errorLabel} API key became unavailable before fetch`
            : result.success
              ? undefined
              : result.error,
          five_hour_remaining: formatWindow(windows.fiveHour),
          weekly_remaining: formatWindow(windows.weekly),
          mcp_remaining: formatWindow(windows.mcp),
          live_state:
            result?.success && !windows.fiveHour && !windows.weekly && !windows.mcp
              ? `no reportable ${params.errorLabel} quota windows`
              : undefined,
        }),
      ]);
    },
  };
}
