/**
 * DeepSeek provider wrapper.
 *
 * Queries the DeepSeek /user/balance endpoint and maps exact source decimals
 * into provider-neutral accounting rows.
 */

import { API_KEY_VENDORS, getApiKeyDiagnostics, hasApiKey } from "../lib/api-key-resolver.js";
import { queryDeepSeekBalance } from "../lib/deepseek.js";
import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  mapNullableProviderResult,
  simpleApiKeyStatusDetails,
  withStatusDetails,
} from "./result-helpers.js";

const DEEPSEEK_GROUP = "DeepSeek";
const BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const STATUS_ACCOUNTING: AccountingMetadata = {
  ...BALANCE_ACCOUNTING,
  resultType: "status",
};

type DeepSeekBalanceSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof queryDeepSeekBalance>>>,
  { success: true }
>;

const BALANCE_COMPONENTS = [
  ["total_balance", "totalBalance", "primary"],
  ["granted_balance", "grantedBalance", "supplementary"],
  ["topped_up_balance", "toppedUpBalance", "supplementary"],
] as const;

function buildDeepSeekResult(result: DeepSeekBalanceSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = [];
  let hasTotalBalance = false;

  for (const info of result.balanceInfos) {
    for (const [component, field, prominence] of BALANCE_COMPONENTS) {
      const decimal = info[field];
      if (decimal === undefined) continue;
      if (component === "total_balance") hasTotalBalance = true;
      entries.push({
        kind: "quantity",
        accounting: BALANCE_ACCOUNTING,
        name: `deepseek-${info.currency.toLowerCase()}-${component.replaceAll("_", "-")}`,
        group: DEEPSEEK_GROUP,
        semantic: { metric: { kind: "component", component }, prominence },
        quantity: { decimal, unit: { kind: "currency", code: info.currency } },
      });
    }
  }

  if (!hasTotalBalance && result.isAvailable !== undefined) {
    entries.push({
      kind: "boolean",
      accounting: STATUS_ACCOUNTING,
      name: "deepseek-availability",
      group: DEEPSEEK_GROUP,
      semantic: {
        metric: { kind: "named", name: "Availability" },
        prominence: "primary",
      },
      value: result.isAvailable,
    });
  }

  return attemptedResult(
    entries,
    result.parseIssues.map((issue) => ({
      label: `DeepSeek ${issue.currency}`,
      message: `${issue.field} returned an invalid decimal`,
    })),
  );
}

export const deepseekProvider: QuotaProvider = {
  id: "deepseek",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "deepseek",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasApiKey(API_KEY_VENDORS.deepseek);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["deepseek"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getApiKeyDiagnostics(API_KEY_VENDORS.deepseek).catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: [],
    }));
    const result = await queryDeepSeekBalance({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "DeepSeek",
      onSuccess: buildDeepSeekResult,
    });
    return withStatusDetails(providerResult, simpleApiKeyStatusDetails(diagnostics));
  },
};
