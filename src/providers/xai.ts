/**
 * xAI SuperGrok provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { AuthData } from "../lib/types.js";
import {
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
  hasXaiOAuthCached,
  periodKindLabel,
  queryXaiQuota,
  resolveXaiOAuth,
  type XaiWindowValue,
} from "../lib/xai.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

function xaiQuotaEntry(group: string, window: XaiWindowValue, sourceId?: string): QuotaToastEntry {
  const period = periodKindLabel(window.kind);
  return {
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      ...(sourceId === undefined ? {} : { sourceId }),
    },
    name: `${group} ${period}`,
    group,
    label: `${period}:`,
    percentRemaining: window.percentRemaining,
    resetTimeIso: window.resetTimeIso,
  };
}

export const xaiProvider: QuotaProvider = {
  id: "xai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "xai",
      fallbackOnError: false,
    });
    return hasXaiOAuthCached({
      maxAgeMs: providerAvailable ? 0 : DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
    });
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID.trim().toLowerCase() === "xai";
    }
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    // A failed login stays in the list so it shows as its own error row.
    const credentials = (await readCredentialRows(["xai"], { methods: ["oauth"] })).flatMap(
      (row) => {
        const auth = resolveXaiOAuth({ xai: credentialRowAuthEntry(row) } as AuthData);
        return auth.state === "none" ? [] : [{ row, auth }];
      },
    );

    if (credentials.length === 0) {
      const result = await queryXaiQuota({ requestTimeoutMs });
      return mapNullableProviderResult(result, {
        errorLabel: "xAI",
        onSuccess: ({ label, window }) =>
          attemptedResult(
            [
              {
                ...xaiQuotaEntry(label, window),
                ...(window.fixedWindow ? { fixedWindow: { ...window.fixedWindow } } : {}),
              },
            ],
            [],
            { singleWindowDisplayName: label },
          ),
      });
    }

    const results = await Promise.all(
      credentials.map(async ({ row, auth }) => ({
        row,
        result: await queryXaiQuota({ requestTimeoutMs, auth }),
      })),
    );
    const names = formatCredentialDisplayNames(
      "xAI",
      results.map(({ row, result }) => ({
        row,
        fallbackName: result?.success ? result.label : "xAI",
      })),
    );
    const mapped = results.map(({ row, result }, index) =>
      mapNullableProviderResult(result, {
        errorLabel: names[index],
        onSuccess: ({ window }) => attemptedResult([xaiQuotaEntry(names[index], window, row.id)]),
      }),
    );
    return attemptedResult(
      mapped.flatMap(({ entries }) => entries),
      mapped.flatMap(({ errors }) => errors),
    );
  },
};
