/**
 * The export file: the quota snapshot as JSON for scripts and status bars, and
 * `opencode-quota show --json`.
 */
import { homedir } from "os";
import { join } from "path";
import { describeError } from "../core/errors.js";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import { rowValueText } from "../view/format.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import type { AccountingWindow } from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type {
  QuotaExport,
  QuotaExportEntry,
  QuotaExportError,
  QuotaExportProvider,
  QuotaExportRawDetail,
} from "./quota-export-types.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./quota-providers.js";

/** Max length for an exported provider error message after sanitization. */
const EXPORT_ERROR_MAX_LENGTH = 240;

const EXPORT_WINDOW_LABELS: Readonly<Record<AccountingWindow, string>> = {
  rpm: "RPM",
  hour: "Hourly",
  five_hour: "5h",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
  mcp: "MCP",
  code_review: "Code Review",
};

/**
 * Resolves the export file path from a configured value.
 *
 * - Empty string → XDG cache default: `$XDG_CACHE_HOME/opencode/quota-export.json`
 * - Starts with `~/` → expands `~` to `homedir()`
 * - Starts with `~\` → expands `~` and treats backslashes as path separators
 * - Otherwise → returns as-is (caller is responsible for absolute paths)
 */
export function resolveExportPath(configured: string): string {
  if (configured === "") {
    return join(getOpencodeRuntimeDirs().cacheDir, "quota-export.json");
  }
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  if (configured.startsWith("~\\")) {
    return join(homedir(), ...configured.slice(2).split(/\\+/u));
  }
  return configured;
}

function unixSecondsFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function toExportError(error: { label: string; message: string }): QuotaExportError {
  return {
    label: sanitizeSingleLineDisplaySnippet(error.label, EXPORT_ERROR_MAX_LENGTH),
    message: sanitizeSingleLineDisplaySnippet(error.message, EXPORT_ERROR_MAX_LENGTH),
  };
}

function toExportRawDetail(detail: { key: string; value: string }): QuotaExportRawDetail {
  return {
    key: sanitizeSingleLineDisplaySnippet(detail.key, EXPORT_ERROR_MAX_LENGTH),
    value: sanitizeSingleLineDisplaySnippet(detail.value, EXPORT_ERROR_MAX_LENGTH),
  };
}

function snapshotEntry(provider: ProviderSnapshot, row: QuotaRow): QuotaExportEntry {
  const account = row.account ? ` (${row.account})` : "";
  const window = row.window
    ? (EXPORT_WINDOW_LABELS[row.window as AccountingWindow] ?? WINDOWS[row.window].label)
    : undefined;
  const resetAt = unixSecondsFromIso(row.resetsAt);
  const base = {
    name: sanitizeSingleLineDisplaySnippet(
      `${provider.label}${account} ${row.label}`,
      EXPORT_ERROR_MAX_LENGTH,
    ),
    resultType: row.type,
    acquisitionMethod: row.method,
    ownership:
      provider.providerId === QUOTA_PROVIDERS_AGGREGATE_ID
        ? ("user_configured" as const)
        : ("maintained" as const),
    authority: row.authority,
    ...(window ? { window } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
  if (row.percentRemaining !== undefined) {
    return { ...base, renderType: "percent", percentRemaining: row.percentRemaining };
  }
  return {
    ...base,
    renderType: "value",
    value: sanitizeSingleLineDisplaySnippet(rowValueText(row), EXPORT_ERROR_MAX_LENGTH),
  };
}

/**
 * Builds the export document from the quota snapshot: the server's last known rows, so no
 * provider is asked again. A provider that has never answered is "unavailable".
 */
export function buildQuotaExportFromSnapshot(
  snapshot: QuotaSnapshot,
  nowMs: number = Date.now(),
): QuotaExport {
  const providers: Record<string, QuotaExportProvider> = {};
  const fetchedAtValues: number[] = [];
  for (const provider of snapshot.providers) {
    const answeredAtMs = provider.okAtMs ?? provider.checkedAtMs;
    if (answeredAtMs === undefined) {
      providers[provider.providerId] = { status: "unavailable" };
      continue;
    }
    const fetchedAt = Math.floor(answeredAtMs / 1000);
    fetchedAtValues.push(fetchedAt);
    const withRawDetails =
      provider.debug.length > 0 ? { rawDetails: provider.debug.map(toExportRawDetail) } : {};
    const entries = provider.rows.map((row) => snapshotEntry(provider, row));
    const error = provider.error
      ? sanitizeSingleLineDisplaySnippet(
          describeError(provider.error, provider.label, nowMs),
          EXPORT_ERROR_MAX_LENGTH,
        )
      : undefined;
    if (error === undefined) {
      providers[provider.providerId] = { status: "ok", fetchedAt, entries, ...withRawDetails };
    } else if (entries.length > 0) {
      providers[provider.providerId] = {
        status: "partial",
        fetchedAt,
        entries,
        errors: [toExportError({ label: provider.label, message: error })],
        ...withRawDetails,
      };
    } else {
      providers[provider.providerId] = { status: "error", fetchedAt, error, ...withRawDetails };
    }
  }
  const exportedAt = Math.floor(nowMs / 1000);
  return {
    version: 2,
    exportedAt,
    fromCache: true,
    cacheAgeSeconds: fetchedAtValues.length > 0 ? exportedAt - Math.min(...fetchedAtValues) : 0,
    providers,
  };
}

/**
 * Writes a `QuotaExport` document atomically to disk.
 *
 * Errors are re-thrown — callers are responsible for catching and logging them.
 */
export async function writeQuotaExport(
  exportData: QuotaExport,
  resolvedPath: string,
): Promise<void> {
  await writeJsonAtomic(resolvedPath, exportData, { trailingNewline: true });
}
