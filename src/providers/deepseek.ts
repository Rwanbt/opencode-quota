/**
 * DeepSeek: the exact balances /user/balance reports, per currency. Each key stored in OpenCode
 * is queried as its own account; an env or config key is used alone.
 */

import { API_KEY_VENDORS, hasVendorKey, readVendorKeys } from "../lib/api-key-resolver.js";
import { queryDeepSeekBalance } from "../lib/deepseek.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  type AccountResult,
  failedAccount,
  fetchKeyLogins,
  keySlug,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { vendorKeyDetails } from "./result-helpers.js";

const LABEL = "DeepSeek";
const SPEC = API_KEY_VENDORS.deepseek;

const BALANCE_COMPONENTS = [
  ["total_balance", "totalBalance", "Balance", "primary"],
  ["granted_balance", "grantedBalance", "Granted", "supplementary"],
  ["topped_up_balance", "toppedUpBalance", "Topped up", "supplementary"],
] as const;

type DeepSeekBalanceSuccess = Extract<
  Awaited<ReturnType<typeof queryDeepSeekBalance>>,
  { success: true }
>;

function deepseekRows(result: DeepSeekBalanceSuccess): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const info of result.balanceInfos) {
    for (const [component, field, label, prominence] of BALANCE_COMPONENTS) {
      const decimal = info[field];
      if (decimal === undefined) continue;
      rows.push({
        key: `${component}.${keySlug(info.currency)}`,
        label,
        type: "balance",
        method: "remote_api",
        authority: "provider_reported",
        prominence,
        amount: { decimal, unit: { kind: "currency", code: info.currency } },
      });
    }
  }

  // Without any total balance, the availability flag stands in for it.
  const hasTotalBalance = result.balanceInfos.some((info) => info.totalBalance !== undefined);
  if (!hasTotalBalance && result.isAvailable !== undefined) {
    rows.push({
      key: "available",
      label: "Available",
      type: "status",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      flag: result.isAvailable,
    });
  }
  return rows;
}

/** An env or config key: a value DeepSeek sent that is not a decimal is an account of its own. */
function deepseekAccounts(result: DeepSeekBalanceSuccess): AccountResult[] {
  return [
    { name: LABEL, rows: deepseekRows(result), errors: [] },
    ...result.parseIssues.map((issue) =>
      failedAccount(`${LABEL} ${issue.currency}`, `${issue.field} returned an invalid decimal`),
    ),
  ];
}

export const deepseekProvider: QuotaProvider = {
  id: "deepseek",
  cachePolicy: vendorKeysPolicy("deepseek"),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "deepseek",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return hasVendorKey(await readVendorKeys(SPEC));
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["deepseek"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keys = await readVendorKeys(SPEC);
    const debug = vendorKeyDetails(SPEC, keys);
    const query = (apiKey: string) =>
      queryDeepSeekBalance({ apiKey, requestTimeoutMs: ctx.config?.requestTimeoutMs });

    if (keys.envOrConfig) {
      const result = await query(keys.envOrConfig.key);
      const accounts = result.success
        ? deepseekAccounts(result)
        : [failedAccount(LABEL, result.error)];
      return { attempted: true, accounts, debug };
    }

    const accounts = await fetchKeyLogins({
      providerName: LABEL,
      logins: keys.logins,
      brokenFirst: false,
      async fetchLogin({ auth }) {
        const result = await query(auth.apiKey);
        if (!result.success) return { rows: [], errors: [{ message: result.error }] };
        return {
          rows: deepseekRows(result),
          errors: result.parseIssues.map((issue) => ({
            message: `${issue.currency} ${issue.field} returned an invalid decimal`,
          })),
        };
      },
    });
    return { attempted: keys.logins.length > 0, accounts, debug };
  },
};
