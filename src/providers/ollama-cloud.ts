import { API_KEY_VENDORS, getApiKeyDiagnostics, hasApiKey } from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { failedAccount, MONTHLY, type ProviderFetchResult, quotaRow, WEEKLY } from "./contract.js";
import { simpleApiKeyStatusDetails, statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "Ollama Cloud";
const SESSION = { key: "session", label: "Session", window: "session" } as const;
const OLLAMA_CLOUD_WINDOWS = [
  ["session", SESSION],
  ["weekly", WEEKLY],
  ["monthly", MONTHLY],
] as const;

export const ollamaCloudProvider: QuotaProvider = {
  id: "ollama-cloud",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasApiKey(API_KEY_VENDORS["ollama-cloud"]);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "ollama-cloud");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const diagnostics = await getApiKeyDiagnostics(API_KEY_VENDORS["ollama-cloud"]).catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    }));
    const keyDetails = simpleApiKeyStatusDetails(diagnostics);

    const result = await queryOllamaCloudQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    if (!result) return { attempted: false, accounts: [], debug: keyDetails };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount(LABEL, result.error)], debug: keyDetails };
    }

    const rows = OLLAMA_CLOUD_WINDOWS.flatMap(([field, slot]) => {
      const window = result[field];
      return window ? [quotaRow({ ...slot, percentRemaining: window.percentRemaining })] : [];
    });
    const rowErrors = result.rowErrors ?? [];
    return {
      attempted: true,
      accounts: [{ name: LABEL, rows, errors: rowErrors.map((message) => ({ message })) }],
      debug: [
        ...keyDetails,
        ...statusDetailsFromRecord(
          Object.fromEntries(
            OLLAMA_CLOUD_WINDOWS.map(([field]) => [
              `${field}_usage_fraction`,
              result[field]?.usageFraction.toString(),
            ]),
          ),
        ),
        ...rowErrors.map((message, index) => ({ key: `live_error_${index + 1}`, value: message })),
      ],
    };
  },
};
