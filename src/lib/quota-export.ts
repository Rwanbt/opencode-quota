/**
 * The export file (version 2) for scripts and status bars, and `opencode-quota show --json`.
 * Each check gives its provider's part of the file as v5 wrote it (`exportProviderFromResult`),
 * and the server keeps that part, in memory only, next to the provider's snapshot. A provider
 * without one (in the terminal command, or before its first check since the server started)
 * is written from its snapshot rows.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describeError } from "../core/errors.js";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../core/types.js";
import { classifyWindow, WINDOWS } from "../core/windows.js";
import { rowValueText } from "../view/format.js";
import { formatAccountingQuantity } from "./accounting-format.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeDisplayText, sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import type {
  AccountingWindow,
  QuotaPercentEntry,
  QuotaProviderDiagnostic,
  QuotaProviderResult,
  QuotaToastEntry,
} from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type {
  QuotaExport,
  QuotaExportEntry,
  QuotaExportError,
  QuotaExportProvider,
  QuotaExportRawDetail,
  QuotaExportSource,
} from "./quota-export-types.js";
import {
  MAINTAINED_LOCAL_ESTIMATE_IDS,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
} from "./quota-providers.js";

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

function exportWindow(entry: QuotaToastEntry): string | undefined {
  if (entry.semantic) {
    return entry.semantic.metric.kind === "window"
      ? EXPORT_WINDOW_LABELS[entry.semantic.metric.window]
      : undefined;
  }
  // Without semantics the window comes only from the row label. The entry name is display
  // text and is never parsed here.
  const window = classifyWindow(entry.label ?? "");
  return window && window !== "session" ? EXPORT_WINDOW_LABELS[window] : undefined;
}

/** A value entry's text; a yes/no entry reads "Enabled" or "Disabled". */
function entryValueText(entry: Exclude<QuotaToastEntry, QuotaPercentEntry>): string {
  if (entry.kind === "value") return entry.value;
  if (entry.kind === "quantity") return formatAccountingQuantity(entry.quantity);
  return entry.value ? "Enabled" : "Disabled";
}

/** One entry as v5 exported it; provider text loses terminal escapes and control characters. */
function toExportEntry(entry: QuotaToastEntry): QuotaExportEntry {
  const window = exportWindow(entry);
  const resetAt = unixSecondsFromIso(entry.resetTimeIso);
  const { sourceId } = entry.accounting;
  const observedAt = unixSecondsFromIso(entry.accounting.observedAtIso);
  const base = {
    name: sanitizeDisplayText(entry.name),
    resultType: entry.accounting.resultType,
    acquisitionMethod: entry.accounting.acquisitionMethod,
    ownership: entry.accounting.ownership,
    authority: entry.accounting.authority,
    ...(sourceId ? { sourceId: sanitizeDisplayText(sourceId) } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(window ? { window } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
  if (entry.kind === "value" || entry.kind === "quantity" || entry.kind === "boolean") {
    return { ...base, renderType: "value", value: sanitizeDisplayText(entryValueText(entry)) };
  }
  return { ...base, renderType: "percent", percentRemaining: entry.percentRemaining };
}

/** The entries as v5 exported them; one that can't be read (a bad amount) is left out. */
function exportEntries(entries: readonly QuotaToastEntry[]): QuotaExportEntry[] {
  return entries.flatMap((entry) => {
    try {
      return [toExportEntry(entry)];
    } catch {
      return [];
    }
  });
}

/** Each custom definition's status in its configured order, never its URL, key or format. */
function customSourceStatuses(
  definitions: readonly QuotaProviderDefinition[],
  diagnostics: readonly QuotaProviderDiagnostic[] = [],
): QuotaExportSource[] {
  const diagnosticsBySource = new Map(
    diagnostics.map((diagnostic) => [diagnostic.sourceId, diagnostic] as const),
  );
  return definitions
    .filter((source) => !(MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(source.id))
    .map((source) => {
      // A switched-off definition is never fetched, so any result for it is old.
      const diagnostic = source.enabled === false ? undefined : diagnosticsBySource.get(source.id);
      return {
        id: source.id,
        providerId: source.providerId,
        status: !diagnostic ? "unavailable" : diagnostic.outcome === "success" ? "ok" : "error",
        entryCount: diagnostic?.entryCount ?? 0,
        ...(source.enabled === false ? { enabled: false as const } : {}),
      };
    });
}

/**
 * A provider's part of the export file from one check, as v5 wrote it: "ok" or "partial" with
 * its entries, "error" when the check found no entries, and "unavailable" when the provider
 * could not be asked (it is not set up). The custom providers also list each definition.
 */
export function exportProviderFromResult(params: {
  providerId: string;
  result: QuotaProviderResult;
  checkedAtMs: number;
  customDefinitions: readonly QuotaProviderDefinition[];
}): QuotaExportProvider {
  const { result } = params;
  const withSources =
    params.providerId === QUOTA_PROVIDERS_AGGREGATE_ID
      ? {
          sources: customSourceStatuses(
            params.customDefinitions,
            result.attempted ? result.diagnostics : undefined,
          ),
        }
      : {};
  if (!result.attempted) return { status: "unavailable", ...withSources };

  const withRawDetails = result.rawDetails?.length
    ? { rawDetails: result.rawDetails.map(toExportRawDetail) }
    : {};
  const fetchedAt = Math.floor(params.checkedAtMs / 1000);
  if (result.entries.length > 0 && result.errors.length > 0) {
    return {
      status: "partial",
      fetchedAt,
      entries: exportEntries(result.entries),
      errors: result.errors.map(toExportError),
      ...withSources,
      ...withRawDetails,
    };
  }
  if (result.errors.length > 0) {
    return {
      status: "error",
      fetchedAt,
      error: sanitizeSingleLineDisplaySnippet(result.errors[0].message, EXPORT_ERROR_MAX_LENGTH),
      ...withSources,
      ...withRawDetails,
    };
  }
  return {
    status: "ok",
    fetchedAt,
    entries: exportEntries(result.entries),
    ...withSources,
    ...withRawDetails,
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

/** A provider's part written from its snapshot rows; "unavailable" until it first answered. */
function exportProviderFromSnapshot(
  provider: ProviderSnapshot,
  nowMs: number,
): QuotaExportProvider {
  const answeredAtMs = provider.okAtMs ?? provider.checkedAtMs;
  if (answeredAtMs === undefined) return { status: "unavailable" };
  const fetchedAt = Math.floor(answeredAtMs / 1000);
  const withRawDetails =
    provider.debug.length > 0 ? { rawDetails: provider.debug.map(toExportRawDetail) } : {};
  const entries = provider.rows.map((row) => snapshotEntry(provider, row));
  if (!provider.error) return { status: "ok", fetchedAt, entries, ...withRawDetails };
  const error = sanitizeSingleLineDisplaySnippet(
    describeError(provider.error, provider.label, nowMs),
    EXPORT_ERROR_MAX_LENGTH,
  );
  if (entries.length === 0) return { status: "error", fetchedAt, error, ...withRawDetails };
  return {
    status: "partial",
    fetchedAt,
    entries,
    errors: [toExportError({ label: provider.label, message: error })],
    ...withRawDetails,
  };
}

/** Builds the export document from the quota snapshot; no provider is asked again. */
export function buildQuotaExportFromSnapshot(
  snapshot: QuotaSnapshot,
  nowMs: number = Date.now(),
): QuotaExport {
  const providers: Record<string, QuotaExportProvider> = {};
  const fetchedAtValues: number[] = [];
  for (const provider of snapshot.providers) {
    const part = provider.exportPart ?? exportProviderFromSnapshot(provider, nowMs);
    providers[provider.providerId] = part;
    if (part.status !== "unavailable") fetchedAtValues.push(part.fetchedAt);
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
