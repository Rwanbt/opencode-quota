import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaToastEntry } from "../lib/entries.js";
import {
  AGY_AUTH_KEYS,
  compareAgyBuckets,
  hasAgyQuotaRuntimeAvailable,
  inspectAgyAuthPresence,
  inspectAgyCompanionPresence,
  queryGoogleAgyQuota,
} from "../lib/google-agy.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import type { GoogleAgyQuotaBucket } from "../lib/types.js";
import {
  fetchGoogleProviderQuota,
  type GoogleProviderFlavor,
  googleQuotaAccounting,
  isGoogleRuntimeAvailable,
} from "./google-oauth-provider.js";

function formatFamilyLabel(family: string): string {
  if (family === "Gemini Models") return "Gemini";
  if (family === "Claude and GPT models") return "Claude/GPT";
  return family;
}

function formatRemainingAmount(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  const display = Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US")
    : sanitizeDisplayText(normalized);
  return `${display} left`;
}

function agyEntry(
  bucket: GoogleAgyQuotaBucket,
  names: { name: string; group: string; sourceId: string },
): QuotaToastEntry {
  const right = formatRemainingAmount(bucket.remainingAmount);
  return {
    accounting: googleQuotaAccounting(names.sourceId),
    name: names.name,
    group: names.group,
    label: `${bucket.windowLabel}:`,
    sortPriority: bucket.window === "weekly" ? 0 : 1,
    ...(right ? { right } : {}),
    percentRemaining: bucket.percentRemaining,
    resetTimeIso: bucket.resetTimeIso,
  };
}

const AGY_PROVIDER: GoogleProviderFlavor<GoogleAgyQuotaBucket> = {
  name: "Google AGY",
  authKeys: AGY_AUTH_KEYS,
  inspectAuth: inspectAgyAuthPresence,
  inspectCompanion: inspectAgyCompanionPresence,
  query: queryGoogleAgyQuota,
  compareBuckets: compareAgyBuckets,
  presentation: { singleWindowShowRight: true },
  loginEntry: (bucket, { group, sourceId }) =>
    agyEntry(bucket, {
      name: `${group} ${formatFamilyLabel(bucket.family)} ${bucket.windowLabel}`,
      group,
      sourceId,
    }),
  accountEntry: (bucket, accountLabel) => {
    const account = accountLabel ?? `Account ${bucket.accountIndex + 1}`;
    return agyEntry(bucket, {
      name: `${bucket.family} (${account})`,
      group: `AGY (${account}): ${formatFamilyLabel(bucket.family)}`,
      sourceId: `account-${bucket.accountIndex + 1}`,
    });
  },
};

export const googleAgyProvider: QuotaProvider = {
  id: "google-agy",
  isAvailable: () => isGoogleRuntimeAvailable(hasAgyQuotaRuntimeAvailable),
  matchesCurrentModel: (model) =>
    (AGY_AUTH_KEYS as readonly string[]).includes(parseProviderModelRef(model).providerId),
  fetch: (ctx) => fetchGoogleProviderQuota(AGY_PROVIDER, ctx),
};
