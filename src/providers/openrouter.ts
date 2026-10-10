import {
  isPercentEntry,
  isValueEntry,
  type QuotaProvider,
  type QuotaProviderContext,
  type QuotaToastEntry,
} from "../lib/entries.js";
import {
  hasOpenRouterApiKeyConfigured,
  queryOpenRouterQuota,
  resolveOpenRouterApiKey,
} from "../lib/openrouter.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { failedAccount, type ProviderFetchResult, type ProviderRow } from "./contract.js";
import { simpleApiKeyStatusDetails } from "./result-helpers.js";

const LABEL = "OpenRouter";

/** The key's one row: its budget (percent left) or, without a limit, its spend. */
function keyRow(entry: QuotaToastEntry): ProviderRow[] {
  const row = {
    key: "key",
    label: (entry.label ?? "").replace(/:+$/u, "").trim() || "Key",
    type: entry.accounting.resultType === "spend" ? "usage" : "budget",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
  } as const;
  if (isValueEntry(entry)) return [{ ...row, text: entry.value }];
  if (isPercentEntry(entry)) return [{ ...row, percentRemaining: entry.percentRemaining }];
  return [];
}

export const openRouterProvider: QuotaProvider = {
  id: "openrouter",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasOpenRouterApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "openrouter");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const resolved = await resolveOpenRouterApiKey();
    const debug = simpleApiKeyStatusDetails({
      configured: Boolean(resolved.key),
      source: resolved.source,
      checkedPaths: resolved.checkedPaths,
      credentialDatabasePaths: resolved.credentialDatabasePaths,
    });
    const result = await queryOpenRouterQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
      resolved,
    });
    if (!result) return { attempted: false, accounts: [], debug };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount(LABEL, result.error)], debug };
    }
    return {
      attempted: true,
      accounts: [
        {
          name: LABEL,
          rows: result.entries.flatMap(keyRow),
          errors: (result.rowErrors ?? []).map((message) => ({ message })),
        },
      ],
      debug,
    };
  },
};
