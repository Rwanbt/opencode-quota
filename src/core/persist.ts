/**
 * The store's snapshot file: one JSON file with the last known rows of every provider and
 * account, plus recent reset notices. Several OpenCode processes share it, so every write
 * first merges what the others saved (the newer check wins) and drops entries older than a
 * week. A file that does not parse is ignored; a bad entry or row is skipped on its own.
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type { DebugDetail, QuotaError, QuotaErrorCode, QuotaRow, ResetNotice } from "./types.js";
import { validateRows } from "./validate.js";
import { isQuotaWindow } from "./windows.js";

const FILE_VERSION = 1;
const ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DETAIL_MAX_LENGTH = 300;

const ERROR_CODES: readonly QuotaErrorCode[] = [
  "not_configured",
  "login_expired",
  "no_plan",
  "rate_limited",
  "timeout",
  "network",
  "provider_error",
  "bad_response",
  "no_data",
  "local_tool",
  "internal",
];

/** What the file keeps per provider and account, keyed `${providerId}|${identity hash}`. */
export type SavedEntry = {
  providerId: string;
  rows: QuotaRow[];
  okAtMs?: number;
  checkedAtMs?: number;
  error?: QuotaError;
  /** Failed attempts in a row; drives the error backoff. */
  failures: number;
  debug: DebugDetail[];
};

export type SavedState = { entries: Map<string, SavedEntry>; notices: ResetNotice[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTime(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseError(value: unknown): QuotaError | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { code, status, retryAtMs, tool, missing, detail } = value;
  if (typeof code !== "string" || !(ERROR_CODES as readonly string[]).includes(code)) return null;
  const error: QuotaError = { code: code as QuotaErrorCode };
  if (Number.isInteger(status)) error.status = status as number;
  if (typeof retryAtMs === "number" && Number.isFinite(retryAtMs)) error.retryAtMs = retryAtMs;
  if (typeof tool === "string") error.tool = sanitizeSingleLineDisplaySnippet(tool, 40);
  if (missing === true) error.missing = true;
  if (typeof detail === "string") {
    error.detail = sanitizeSingleLineDisplaySnippet(detail, DETAIL_MAX_LENGTH);
  }
  return error;
}

function parseDebug(value: unknown): DebugDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item.key === "string" && typeof item.value === "string"
      ? [{ key: item.key, value: item.value }]
      : [],
  );
}

function parseEntry(key: string, value: unknown): SavedEntry | undefined {
  if (!isRecord(value) || typeof value.providerId !== "string") return undefined;
  const { providerId } = value;
  if (!key.startsWith(`${providerId}|`) || !Array.isArray(value.rows)) return undefined;
  const okAtMs = optionalTime(value.okAtMs);
  const checkedAtMs = optionalTime(value.checkedAtMs);
  const error = parseError(value.error);
  if (okAtMs === null || checkedAtMs === null || error === null) return undefined;
  const failures =
    Number.isInteger(value.failures) && (value.failures as number) >= 0
      ? (value.failures as number)
      : 0;
  return {
    providerId,
    rows: validateRows(providerId, value.rows).rows,
    ...(okAtMs === undefined ? {} : { okAtMs }),
    ...(checkedAtMs === undefined ? {} : { checkedAtMs }),
    ...(error === undefined ? {} : { error }),
    failures,
    debug: parseDebug(value.debug),
  };
}

function parseNotice(value: unknown): ResetNotice | undefined {
  if (!isRecord(value)) return undefined;
  const { id, rowId, providerId, account, label, window, percentRemaining, atMs } = value;
  if (
    typeof id !== "string" ||
    typeof rowId !== "string" ||
    typeof providerId !== "string" ||
    (account !== undefined && typeof account !== "string") ||
    typeof label !== "string" ||
    !isQuotaWindow(window) ||
    typeof percentRemaining !== "number" ||
    !Number.isFinite(percentRemaining) ||
    typeof atMs !== "number" ||
    !Number.isFinite(atMs)
  ) {
    return undefined;
  }
  return {
    id,
    rowId,
    providerId,
    ...(account === undefined ? {} : { account }),
    label,
    window,
    percentRemaining,
    atMs,
  };
}

function emptyState(): SavedState {
  return { entries: new Map(), notices: [] };
}

/** What the file holds now; empty when it is missing or does not parse. */
export async function readSavedState(file: string): Promise<SavedState> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return emptyState();
  }
  if (!isRecord(data) || data.version !== FILE_VERSION || !isRecord(data.entries)) {
    return emptyState();
  }
  const entries = new Map<string, SavedEntry>();
  for (const [key, value] of Object.entries(data.entries)) {
    const entry = parseEntry(key, value);
    if (entry) entries.set(key, entry);
  }
  const notices = Array.isArray(data.resetNotices)
    ? data.resetNotices.flatMap((value) => parseNotice(value) ?? [])
    : [];
  return { entries, notices };
}

/**
 * Merges `state` into the file (per entry the newer check wins; notices are joined by id),
 * drops entries not checked for a week and notices older than `noticeMaxAgeMs`, writes it
 * atomically (owner-only), and returns the merged state.
 */
export async function writeSavedState(
  file: string,
  state: SavedState,
  options: { nowMs: number; noticeMaxAgeMs: number },
): Promise<SavedState> {
  const merged = await readSavedState(file);
  for (const [key, entry] of state.entries) {
    const other = merged.entries.get(key);
    if (!other || (other.checkedAtMs ?? 0) <= (entry.checkedAtMs ?? 0)) {
      merged.entries.set(key, entry);
    }
  }
  for (const [key, entry] of merged.entries) {
    if (options.nowMs - (entry.checkedAtMs ?? 0) > ENTRY_MAX_AGE_MS) merged.entries.delete(key);
  }
  const noticesById = new Map(merged.notices.map((notice) => [notice.id, notice]));
  for (const notice of state.notices) noticesById.set(notice.id, notice);
  merged.notices = [...noticesById.values()].filter(
    (notice) => options.nowMs - notice.atMs <= options.noticeMaxAgeMs,
  );
  await writeJsonAtomic(
    file,
    {
      version: FILE_VERSION,
      entries: Object.fromEntries(merged.entries),
      resetNotices: merged.notices,
    },
    { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 },
  );
  return merged;
}
