import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  QuotaProviderContext,
  QuotaProviderPresentation,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import type { GoogleCompanionPresence } from "../lib/google-companion-credentials.js";
import type {
  GoogleAuthPresence,
  GoogleAuthSourceKey,
  GoogleQuotaResult,
} from "../lib/google-oauth-quota.js";
import {
  type CredentialRow,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import type { AuthData } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

/** The parts in which the Google AGY and Gemini CLI providers differ. */
export type GoogleProviderFlavor<Bucket extends { accountEmail?: string }> = {
  name: "Google AGY" | "Gemini CLI";
  authKeys: readonly string[];
  inspectAuth: () => Promise<GoogleAuthPresence<GoogleAuthSourceKey>>;
  inspectCompanion: () => Promise<GoogleCompanionPresence>;
  query: (options: {
    requestTimeoutMs?: number;
    authData?: AuthData;
  }) => Promise<GoogleQuotaResult<Bucket>>;
  /** Error row for a login OpenCode could not return; without it the login is queried. */
  failedLoginError?: (resolveError: string) => string;
  compareBuckets?: (left: Bucket, right: Bucket) => number;
  presentation: QuotaProviderPresentation;
  /** Entry for a bucket of one OpenCode login, shown under that login's name. */
  loginEntry: (bucket: Bucket, login: { group: string; sourceId: string }) => QuotaToastEntry;
  /** Entry for a bucket from the default login read; `accountLabel` is the short email. */
  accountEntry: (bucket: Bucket, accountLabel: string | undefined) => QuotaToastEntry;
};

export function googleQuotaAccounting(sourceId: string | undefined): AccountingMetadata {
  return {
    resultType: "quota",
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
    ...(sourceId !== undefined ? { sourceId } : {}),
  };
}

export async function isGoogleRuntimeAvailable(
  hasRuntime: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await hasRuntime();
  } catch {
    return false;
  }
}

function getGoogleAccountLocalPart(email: string): string {
  const [local = email] = email.split("@");
  return local || email;
}

function formatGoogleAccountLabel(email: string | undefined): string {
  if (!email) return "Unknown";
  return `${getGoogleAccountLocalPart(email).slice(0, 3)}…`;
}

/** Short account labels ("ali…"), extended or numbered where they would collide. */
export function createGoogleAccountLabelMap(
  emails: readonly (string | undefined)[],
): ReadonlyMap<string, string> {
  const uniqueEmails = [...new Set(emails.filter((email): email is string => Boolean(email)))];
  const labels = new Map(uniqueEmails.map((email) => [email, formatGoogleAccountLabel(email)]));
  const emailsByLabel = new Map<string, string[]>();

  for (const email of uniqueEmails) {
    const label = labels.get(email)!;
    emailsByLabel.set(label, [...(emailsByLabel.get(label) ?? []), email]);
  }

  for (const collidingEmails of emailsByLabel.values()) {
    if (collidingEmails.length < 2) continue;

    const localParts = collidingEmails.map(getGoogleAccountLocalPart);
    const distinctLocalParts = [...new Set(localParts)];
    const maxLength = Math.max(...distinctLocalParts.map((local) => local.length));
    let prefixLength = distinctLocalParts.length === 1 ? maxLength : 4;
    while (
      prefixLength <= maxLength &&
      new Set(distinctLocalParts.map((local) => local.slice(0, prefixLength))).size <
        distinctLocalParts.length
    ) {
      prefixLength += 1;
    }

    const emailsByPrefix = new Map<string, string[]>();
    collidingEmails.forEach((email, index) => {
      const local = localParts[index]!;
      const prefix = local.slice(0, Math.min(prefixLength, local.length));
      emailsByPrefix.set(prefix, [...(emailsByPrefix.get(prefix) ?? []), email]);
    });
    for (const [prefix, matchingEmails] of emailsByPrefix) {
      matchingEmails.forEach((email, index) => {
        labels.set(email, `${prefix}…${matchingEmails.length > 1 ? ` ${index + 1}` : ""}`);
      });
    }
  }

  return labels;
}

function sortBuckets<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  buckets: Bucket[],
): Bucket[] {
  return flavor.compareBuckets ? [...buckets].sort(flavor.compareBuckets) : buckets;
}

/** One group per OpenCode login, named after the login. */
async function fetchLoginRows<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  rows: CredentialRow[],
  requestTimeoutMs: number | undefined,
): Promise<QuotaProviderResult> {
  const results = await Promise.all(
    rows.map(async (row) => ({
      row,
      result:
        row.resolveError !== undefined && flavor.failedLoginError
          ? { success: false as const, error: flavor.failedLoginError(row.resolveError) }
          : await flavor.query({
              requestTimeoutMs,
              authData: { [row.integrationId]: row.value } as AuthData,
            }),
    })),
  );
  const groups = formatCredentialDisplayNames(
    flavor.name,
    rows.map((row) => ({ row, fallbackName: flavor.name })),
  );

  const entries: QuotaToastEntry[] = [];
  const errors: QuotaToastError[] = [];
  results.forEach(({ row, result }, index) => {
    const group = groups[index] ?? flavor.name;
    if (!result) return;
    if (!result.success) {
      errors.push({ label: group, message: result.error });
      return;
    }
    for (const bucket of sortBuckets(flavor, result.buckets)) {
      entries.push(flavor.loginEntry(bucket, { group, sourceId: row.id }));
    }
    for (const error of result.errors ?? []) errors.push({ label: group, message: error.error });
  });
  return attemptedResult(entries, errors, { ...flavor.presentation });
}

/** The default login read, with groups labelled per account email. */
async function fetchDefaultLogin<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  requestTimeoutMs: number | undefined,
): Promise<QuotaProviderResult> {
  const result = await flavor.query({ requestTimeoutMs });
  if (!result) return notAttemptedResult();
  if (!result.success) return attemptedErrorResult(flavor.name, result.error);

  const buckets = sortBuckets(flavor, result.buckets);
  const accountErrors = result.errors ?? [];
  const labels = createGoogleAccountLabelMap([
    ...buckets.map((bucket) => bucket.accountEmail),
    ...accountErrors.map((error) => error.email),
  ]);
  const entries = buckets.map((bucket) =>
    flavor.accountEntry(bucket, bucket.accountEmail ? labels.get(bucket.accountEmail) : undefined),
  );
  const errors = accountErrors.map((error) => ({
    label: labels.get(error.email) ?? formatGoogleAccountLabel(error.email),
    message: error.error,
  }));
  return attemptedResult(entries, errors, { ...flavor.presentation });
}

export async function fetchGoogleProviderQuota<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  ctx: QuotaProviderContext,
): Promise<QuotaProviderResult> {
  const [auth, companion] = await Promise.all([flavor.inspectAuth(), flavor.inspectCompanion()]);
  const statusDetails = statusDetailsFromRecord({
    auth_state: auth.state,
    auth_source: auth.sourceKey ?? "(none)",
    account_count: String(auth.accountCount),
    valid_account_count: String(auth.validAccountCount),
    companion_package_state: companion.state,
    companion_package_path:
      companion.state === "missing" ? "(none)" : (companion.resolvedPath ?? "(none)"),
    auth_error: auth.state === "invalid" ? sanitizeDisplayText(auth.error) : undefined,
    companion_error:
      companion.state !== "present" ? sanitizeDisplayText(companion.error) : undefined,
  });

  const requestTimeoutMs = ctx.config?.requestTimeoutMsConfigured
    ? ctx.config.requestTimeoutMs
    : undefined;
  const rows = await readCredentialRows(flavor.authKeys, { methods: ["oauth"] });
  const result =
    rows.length > 0
      ? await fetchLoginRows(flavor, rows, requestTimeoutMs)
      : await fetchDefaultLogin(flavor, requestTimeoutMs);
  return withStatusDetails(result, statusDetails);
}
