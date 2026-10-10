import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryKimiQuota } from "../lib/kimi.js";
import {
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
  type ResolvedKimiAuth,
  type ResolvedKimiAuthWithDiagnostics,
  resolveKimiCnAuth,
  resolveKimiCnAuthCached,
  resolveKimiCnAuthWithDiagnosticsCached,
  resolveKimiGlobalAuth,
  resolveKimiGlobalAuthCached,
  resolveKimiGlobalAuthWithDiagnosticsCached,
} from "../lib/kimi-auth.js";
import { getKimiQuotaEndpoint, type KimiQuotaEndpointId } from "../lib/kimi-endpoints.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { AuthData, KimiQuotaWindow } from "../lib/types.js";
import { readKeyLoginRows } from "./key-login-rows.js";
import {
  apiKeyStatusDetails,
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type KimiProviderSpec = {
  id: "kimi-code-plan-global" | "kimi-code-plan-cn";
  label: string;
  endpoint: KimiQuotaEndpointId;
  integrationIds: readonly string[];
  parseAuth: (auth: AuthData) => ResolvedKimiAuth;
  resolveAuthCached: (params?: { maxAgeMs?: number }) => Promise<ResolvedKimiAuth>;
  resolveAuthWithDiagnosticsCached: (params?: {
    maxAgeMs?: number;
  }) => Promise<ResolvedKimiAuthWithDiagnostics>;
};

function toKimiEntries(
  windows: KimiQuotaWindow[],
  group: string,
  sourceId?: string,
): QuotaToastEntry[] {
  return windows.map((window) => ({
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      ...(sourceId === undefined ? {} : { sourceId }),
    },
    name: `${group} ${window.label}`,
    group,
    label: `${window.label}:`,
    right: `${window.used}/${window.limit}`,
    percentRemaining: window.percentRemaining,
    resetTimeIso: window.resetTimeIso,
  }));
}

function createKimiProvider(spec: KimiProviderSpec): QuotaProvider {
  return {
    id: spec.id,

    async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
      const providerAvailable = await isCanonicalProviderAvailable({
        ctx,
        providerId: spec.id,
        fallbackOnError: false,
      });
      if (!providerAvailable) return false;

      const auth = await spec.resolveAuthCached({
        maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      });
      return auth.state === "configured" || auth.state === "invalid";
    },

    matchesCurrentModel(model: string): boolean {
      const [provider = "", modelId] = model.toLowerCase().split("/", 2);
      return Boolean(modelId) && normalizeQuotaProviderId(provider) === spec.id;
    },

    async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
      const { auth, diagnostics } = await spec.resolveAuthWithDiagnosticsCached({
        maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
      });
      const endpoint = getKimiQuotaEndpoint(
        auth.state === "configured" ? auth.endpoint : spec.endpoint,
      );
      const authDetails = [
        ...apiKeyStatusDetails(diagnostics),
        ...statusDetailsFromRecord({
          api_endpoint: endpoint.id,
          api_base_url: endpoint.apiBaseUrl,
        }),
      ];

      if (auth.state === "none") {
        return withStatusDetails(notAttemptedResult(), authDetails);
      }

      if (diagnostics.source === "opencode.db") {
        const { credentials, invalidErrors } = await readKeyLoginRows({
          integrationIds: spec.integrationIds,
          label: spec.label,
          parseAuth: spec.parseAuth,
        });
        if (credentials.length > 0 || invalidErrors.length > 0) {
          const results = await Promise.all(
            credentials.map(async ({ row, displayName, auth: rowAuth }) => ({
              row,
              group: displayName,
              result: await queryKimiQuota({
                apiKey: rowAuth.apiKey,
                endpoint: rowAuth.endpoint,
                label: spec.label,
                requestTimeoutMs: ctx.config?.requestTimeoutMs,
              }),
            })),
          );
          const entries: QuotaToastEntry[] = [];
          const errors: QuotaProviderResult["errors"] = [...invalidErrors];
          for (const { row, group, result } of results) {
            if (!result.success) {
              errors.push({ label: group, message: result.error });
              continue;
            }
            entries.push(...toKimiEntries(result.windows, group, row.id));
          }
          return withStatusDetails(attemptedResult(entries, errors), authDetails);
        }
      }

      if (auth.state === "invalid") {
        return withStatusDetails(attemptedErrorResult(spec.label, auth.error), authDetails);
      }

      const result = await queryKimiQuota({
        apiKey: auth.apiKey,
        endpoint: auth.endpoint,
        label: spec.label,
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
      });

      if (!result.success) {
        return withStatusDetails(attemptedErrorResult(spec.label, result.error), [
          ...authDetails,
          { key: "live_fetch_error", value: result.error },
        ]);
      }

      return withStatusDetails(
        attemptedResult(toKimiEntries(result.windows, result.label), [], {
          singleWindowDisplayName: result.label,
        }),
        [
          ...authDetails,
          ...result.windows.map((window) => ({
            key: window.label.toLowerCase().replace(/\s+/g, "_"),
            value: `used=${window.used}/${window.limit} percent_remaining=${window.percentRemaining} reset_at=${window.resetTimeIso ?? "(none)"}`,
          })),
        ],
      );
    },
  };
}

export const kimiCodePlanGlobalProvider: QuotaProvider = createKimiProvider({
  id: "kimi-code-plan-global",
  label: "Kimi Code",
  endpoint: "global",
  integrationIds: ["kimi-code-plan-global"],
  parseAuth: resolveKimiGlobalAuth,
  resolveAuthCached: resolveKimiGlobalAuthCached,
  resolveAuthWithDiagnosticsCached: resolveKimiGlobalAuthWithDiagnosticsCached,
});

export const kimiCodePlanCnProvider: QuotaProvider = createKimiProvider({
  id: "kimi-code-plan-cn",
  label: "Kimi Code (CN)",
  endpoint: "cn",
  integrationIds: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
  parseAuth: resolveKimiCnAuth,
  resolveAuthCached: resolveKimiCnAuthCached,
  resolveAuthWithDiagnosticsCached: resolveKimiCnAuthWithDiagnosticsCached,
});
