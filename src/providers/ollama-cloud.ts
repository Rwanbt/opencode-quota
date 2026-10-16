/**
 * Ollama Cloud: included credits or session and weekly limits, and purchased credits. Each key
 * stored in OpenCode is queried as its own account; an env or config key is used alone.
 */

import type { Amount, DebugDetail } from "../core/types.js";
import { API_KEY_VENDORS, hasVendorKey, readVendorKeys } from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { OllamaCloudIncludedCredits, OllamaCloudResult } from "../lib/types.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  fetchKeyLogins,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { statusDetailsFromRecord, vendorKeyDetails } from "./result-helpers.js";

const LABEL = "Ollama Cloud";
const SPEC = API_KEY_VENDORS["ollama-cloud"];
const SESSION = { key: "session", label: "Session", window: "session" } as const;
const NO_DATA = "Ollama Cloud returned no limits or balance";

function usd(value: number): Amount {
  return { decimal: accountingDecimalFromNumber(value), unit: { kind: "currency", code: "USD" } };
}

/** A credit plan's included credits: the share left this monthly period, with its USD. */
function includedCreditsRow(
  included: OllamaCloudIncludedCredits,
  percentRemaining: number,
): ProviderRow {
  const remainingUsd = Math.max(0, included.balanceUsd);
  return {
    ...MONTHLY,
    type: "quota",
    method: "remote_api",
    authority: "locally_derived",
    prominence: "primary",
    percentRemaining,
    used: usd(Math.max(0, included.allowanceUsd - remainingUsd)),
    limit: usd(included.allowanceUsd),
    remaining: usd(remainingUsd),
    ...(included.resetTimeIso ? { resetsAt: included.resetTimeIso } : {}),
    ...(included.periodStartIso ? { windowStartedAt: included.periodStartIso } : {}),
  };
}

/** One key's rows and errors, and the details its reply gave. */
function ollamaKeyFetch(result: OllamaCloudResult): {
  rows: ProviderRow[];
  errors: Array<{ message: string }>;
  debug: DebugDetail[];
} {
  if (!result.success) return { rows: [], errors: [{ message: result.error }], debug: [] };

  const { session, weekly, includedCredits: included, purchasedUsd } = result;
  const rows: ProviderRow[] = [];
  if (session) {
    rows.push(
      quotaRow({
        ...SESSION,
        percentRemaining: session.percentRemaining,
        resetsAt: session.resetTimeIso,
      }),
    );
  }
  if (weekly) {
    rows.push(
      quotaRow({
        ...WEEKLY,
        percentRemaining: weekly.percentRemaining,
        resetsAt: weekly.resetTimeIso,
      }),
    );
  }
  // A plan with no included allowance has no share to show.
  if (included?.percentRemaining !== undefined) {
    rows.push(includedCreditsRow(included, included.percentRemaining));
  }
  // Purchased credits show when there are some, or when they are all Ollama returned.
  if (purchasedUsd !== undefined && (purchasedUsd > 0 || rows.length === 0)) {
    rows.push({
      key: "purchased",
      label: "Purchased",
      type: "balance",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      amount: usd(purchasedUsd),
    });
  }

  const rowErrors = result.rowErrors ?? [];
  const errors = [...rowErrors, ...(rows.length === 0 ? [NO_DATA] : [])];
  return {
    rows,
    errors: errors.map((message) => ({ message })),
    debug: [
      ...statusDetailsFromRecord({
        included_balance_usd: included?.balanceUsd.toString(),
        included_allowance_usd: included?.allowanceUsd.toString(),
        included_period_from: included?.periodStartIso,
        included_period_until: included?.resetTimeIso,
        session_remaining_percent: session?.percentRemaining.toString(),
        session_resets_at: session?.resetTimeIso,
        weekly_remaining_percent: weekly?.percentRemaining.toString(),
        weekly_resets_at: weekly?.resetTimeIso,
        purchased_balance_usd: purchasedUsd?.toString(),
      }),
      ...rowErrors.map((message, index) => ({ key: `live_error_${index + 1}`, value: message })),
    ],
  };
}

export const ollamaCloudProvider: QuotaProvider = {
  id: "ollama-cloud",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return hasVendorKey(await readVendorKeys(SPEC));
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "ollama-cloud");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keys = await readVendorKeys(SPEC);
    const keyDetails = vendorKeyDetails(SPEC, keys);
    const query = async (apiKey: string) =>
      ollamaKeyFetch(
        await queryOllamaCloudQuota({ apiKey, requestTimeoutMs: ctx.config?.requestTimeoutMs }),
      );

    if (keys.envOrConfig) {
      const { rows, errors, debug } = await query(keys.envOrConfig.key);
      return {
        attempted: true,
        accounts: [{ name: LABEL, rows, errors }],
        debug: [...keyDetails, ...debug],
      };
    }

    const debugByLogin = new Map<string, DebugDetail[]>();
    const accounts = await fetchKeyLogins({
      providerName: LABEL,
      logins: keys.logins,
      brokenFirst: false,
      async fetchLogin({ row, auth }) {
        const { rows, errors, debug } = await query(auth.apiKey);
        debugByLogin.set(row.id, debug);
        return { rows, errors };
      },
    });
    return {
      attempted: keys.logins.length > 0,
      accounts,
      debug: [...keyDetails, ...keys.logins.flatMap(({ row }) => debugByLogin.get(row.id) ?? [])],
    };
  },
};
