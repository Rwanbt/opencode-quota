import { API_KEY_VENDORS, getApiKeyDiagnostics, hasApiKey } from "../lib/api-key-resolver.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { OllamaCloudResult } from "../lib/types.js";
import {
  attemptedResult,
  mapNullableProviderResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OLLAMA_CLOUD_PROVIDER_LABEL = "Ollama Cloud";
const OLLAMA_CLOUD_WINDOWS = [
  ["session", "Session"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
] as const;

type OllamaCloudSuccess = Extract<OllamaCloudResult, { success: true }>;

function mapOllamaCloudSuccess(result: OllamaCloudSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = OLLAMA_CLOUD_WINDOWS.flatMap(([key, name]) => {
    const window = result[key];
    if (!window) return [];
    return [
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: `${OLLAMA_CLOUD_PROVIDER_LABEL} ${name}`,
        group: OLLAMA_CLOUD_PROVIDER_LABEL,
        label: `${name}:`,
        percentRemaining: window.percentRemaining,
      },
    ];
  });
  const rowErrors = result.rowErrors ?? [];

  return withStatusDetails(
    attemptedResult(
      entries,
      rowErrors.map((message) => ({ label: OLLAMA_CLOUD_PROVIDER_LABEL, message })),
    ),
    [
      ...statusDetailsFromRecord(
        Object.fromEntries(
          OLLAMA_CLOUD_WINDOWS.map(([key]) => [
            `${key}_usage_fraction`,
            result[key]?.usageFraction.toString(),
          ]),
        ),
      ),
      ...rowErrors.map((message, index) => ({ key: `live_error_${index + 1}`, value: message })),
    ],
  );
}

export const ollamaCloudProvider: QuotaProvider = {
  id: "ollama-cloud",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasApiKey(API_KEY_VENDORS["ollama-cloud"]);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "ollama-cloud");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getApiKeyDiagnostics(API_KEY_VENDORS["ollama-cloud"]).catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    }));
    const result = await queryOllamaCloudQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: OLLAMA_CLOUD_PROVIDER_LABEL,
      onSuccess: mapOllamaCloudSuccess,
    });

    return withStatusDetails(providerResult, [
      ...simpleApiKeyStatusDetails(diagnostics),
      ...(providerResult.statusDetails ?? []),
    ]);
  },
};
