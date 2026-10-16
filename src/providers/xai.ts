/**
 * xAI SuperGrok: the shared credits meter of each OpenCode xAI sign-in. A sign-in OpenCode could
 * not return shows as its own error.
 */

import { classifyWindow } from "../core/windows.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
} from "../lib/entries.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  periodKindLabel,
  queryXaiQuota,
  readXaiLogins,
  type XaiWindowValue,
  xaiLoginsIdentity,
} from "../lib/xai.js";
import {
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "./contract.js";

/** The credits row, labelled with its period ("Weekly"), with when the period started. */
function creditsRow(window: XaiWindowValue): ProviderRow {
  const period = periodKindLabel(window.kind);
  return quotaRow({
    key: "credits",
    label: period,
    window: classifyWindow(period),
    percentRemaining: window.percentRemaining,
    resetsAt: window.resetTimeIso,
    windowStartedAt: window.fixedWindow?.startedAtIso,
  });
}

export const xaiProvider: QuotaProvider = {
  id: "xai",
  cachePolicy: {
    kind: "resolved-auth",
    resolveIdentity: async () => xaiLoginsIdentity(await readXaiLogins()),
  },

  async isAvailable(): Promise<boolean> {
    return (await readXaiLogins()).length > 0;
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID.trim().toLowerCase() === "xai";
    }
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    const logins = await readXaiLogins();
    const accounts = await fetchEachLogin({
      providerName: "xAI",
      logins,
      async fetchLogin({ auth }) {
        const result = await queryXaiQuota({ requestTimeoutMs, auth });
        if (!result.success) return { rows: [], errors: [{ message: result.error }] };
        return {
          rows: [creditsRow(result.window)],
          errors: [],
          fallbackName: result.label,
        };
      },
    });
    return { attempted: logins.length > 0, accounts, debug: [] };
  },
};
