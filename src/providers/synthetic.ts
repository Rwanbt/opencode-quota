import { API_KEY_VENDORS, getApiKeyDiagnostics, hasApiKey } from "../lib/api-key-resolver.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { querySyntheticQuota } from "../lib/synthetic.js";
import type { SyntheticQuotaWindow } from "../lib/types.js";
import { attemptedResult, mapNullableProviderResult, withStatusDetails } from "./result-helpers.js";

function roundedAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.max(0, Math.round(value)));
}

/** `currencySign` is "$" for the weekly credit window and "" for the 5h request window. */
function toSyntheticEntry(
  window: SyntheticQuotaWindow,
  suffix: "5h" | "Weekly",
  currencySign: "" | "$",
): QuotaToastEntry {
  return {
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    name: `Synthetic ${suffix}`,
    group: "Synthetic",
    label: `${suffix}:`,
    percentRemaining: window.percentRemaining,
    right: `${currencySign}${roundedAmount(window.used)}/${currencySign}${roundedAmount(window.limit)}`,
    resetTimeIso: window.resetTimeIso,
  };
}

export const syntheticProvider: QuotaProvider = {
  id: "synthetic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "synthetic",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasApiKey(API_KEY_VENDORS.synthetic);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["synthetic"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getApiKeyDiagnostics(API_KEY_VENDORS.synthetic).catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
    }));
    const result = await querySyntheticQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "Synthetic",
      onSuccess: (result) =>
        attemptedResult(
          [
            toSyntheticEntry(result.windows.fiveHour, "5h", ""),
            toSyntheticEntry(result.windows.weekly, "Weekly", "$"),
          ],
          [],
          { singleWindowShowRight: true },
        ),
    });
    const detail = `configured=${diagnostics.configured ? "true" : "false"}${diagnostics.source ? ` source=${diagnostics.source}` : ""}${diagnostics.checkedPaths.length > 0 ? ` checked=${diagnostics.checkedPaths.join(" | ")}` : ""}`;
    return withStatusDetails(providerResult, [{ key: "synthetic api key", value: detail }]);
  },
};
