import type { QuotaProvider, QuotaToastEntry } from "../lib/entries.js";
import {
  GEMINI_CLI_AUTH_KEYS,
  hasGeminiCliQuotaRuntimeAvailable,
  inspectGeminiCliAuthPresence,
  inspectGeminiCliCompanionPresence,
  queryGeminiCliQuota,
} from "../lib/google-gemini-cli.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import type { GeminiCliQuotaBucket } from "../lib/types.js";
import {
  fetchGoogleProviderQuota,
  type GoogleProviderFlavor,
  googleQuotaAccounting,
  isGoogleRuntimeAvailable,
} from "./google-oauth-provider.js";

function isGeminiCliModel(model: string): boolean {
  const { providerId, modelId } = parseProviderModelRef(model);
  if (["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth"].includes(providerId)) {
    return true;
  }
  return (
    providerId === "google" && !modelId.startsWith("antigravity-") && modelId.includes("gemini")
  );
}

/** "1,234 left", plus the token type unless it is the usual REQUESTS. */
function formatRight(bucket: GeminiCliQuotaBucket): string {
  const parsedRemaining = bucket.remainingAmount
    ? Number.parseInt(bucket.remainingAmount, 10)
    : Number.NaN;
  const remainingAmount = bucket.remainingAmount
    ? `${Number.isFinite(parsedRemaining) ? parsedRemaining.toLocaleString("en-US") : bucket.remainingAmount} left`
    : undefined;
  const tokenType = bucket.tokenType?.trim().toUpperCase();
  return [remainingAmount, tokenType && tokenType !== "REQUESTS" ? tokenType : undefined]
    .filter(Boolean)
    .join(" ");
}

function geminiCliEntry(
  bucket: GeminiCliQuotaBucket,
  names: { name: string; group: string; sourceId: string | undefined },
): QuotaToastEntry {
  const right = formatRight(bucket);
  return {
    accounting: googleQuotaAccounting(names.sourceId),
    name: names.name,
    group: names.group,
    label: `${bucket.displayName}:`,
    ...(right ? { right } : {}),
    percentRemaining: bucket.percentRemaining,
    resetTimeIso: bucket.resetTimeIso,
  };
}

const GEMINI_CLI_PROVIDER: GoogleProviderFlavor<GeminiCliQuotaBucket> = {
  name: "Gemini CLI",
  authKeys: GEMINI_CLI_AUTH_KEYS,
  inspectAuth: inspectGeminiCliAuthPresence,
  inspectCompanion: inspectGeminiCliCompanionPresence,
  query: queryGeminiCliQuota,
  failedLoginError: (resolveError) =>
    `Gemini CLI sign-in could not be refreshed: ${resolveError}. Run \`opencode auth login google\`.`,
  presentation: { singleWindowDisplayName: "Gemini CLI", singleWindowShowRight: true },
  loginEntry: (bucket, { group, sourceId }) =>
    geminiCliEntry(bucket, { name: `${group} ${bucket.displayName}`, group, sourceId }),
  accountEntry: (bucket, accountLabel = "Unknown") =>
    geminiCliEntry(bucket, {
      name: `${bucket.displayName} (${accountLabel})`,
      group: `Gemini CLI (${accountLabel})`,
      sourceId: bucket.accountEmail,
    }),
};

export const googleGeminiCliProvider: QuotaProvider = {
  id: "google-gemini-cli",
  isAvailable: () => isGoogleRuntimeAvailable(hasGeminiCliQuotaRuntimeAvailable),
  matchesCurrentModel: isGeminiCliModel,
  fetch: (ctx) => fetchGoogleProviderQuota(GEMINI_CLI_PROVIDER, ctx),
};
