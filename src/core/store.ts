/**
 * The server's quota store. It keeps the last known rows of every provider (in memory and in
 * one snapshot file), refreshes them in the background, and tells subscribers when they change.
 *
 * - `snapshot()` answers at once from what is known; when a provider is due it starts a
 *   background refresh.
 * - Refreshes are single-flight per provider and keep a minimum interval (30 s after a turn,
 *   none for a manual or retry refresh); failures back off from 1 to 15 minutes, or until the
 *   provider's own retry time.
 * - A failed refresh keeps the last good rows and records the error.
 * - Rows belong to an identity (account plus provider settings). Rows of another identity are
 *   never shown; rows whose identity can't be saved stay in memory and go on a login change.
 * - When a quota window resets between two checks, a reset notice is recorded once.
 */
import { createHash } from "node:crypto";
import { classifyError } from "./errors.js";
import { readSavedState, type SavedEntry, type SavedState, writeSavedState } from "./persist.js";
import type {
  DebugDetail,
  ProviderSnapshot,
  QuotaError,
  QuotaRow,
  QuotaSnapshot,
  ResetNotice,
} from "./types.js";
import { WINDOWS } from "./windows.js";

const TURN_MIN_INTERVAL_MS = 30_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** A reset notice stays in snapshots this long; each TUI shows it once. */
const RESET_NOTICE_KEEP_MS = 60 * 60_000;
/** A window that reset longer ago than this when we noticed gets no notice. */
const RESET_NOTICE_MAX_LATENESS_MS = 24 * 60 * 60_000;

/** One provider fetch, already turned into rows. */
export type ProviderFetch = { rows: QuotaRow[]; error?: QuotaError; debug: DebugDetail[] };

/** Whose rows a fetch returns. */
export type ProviderIdentity = {
  /** Changes whenever the rows would differ: another account or other provider settings. */
  key: string;
  /** False when the account can't be told apart safely: rows stay in memory only. */
  persist: boolean;
};

export type StoreProvider = {
  id: string;
  /** Registration label, for example "Anthropic". */
  label: string;
  /** Overrides the source's minimum interval (0 for providers that only read local data). */
  minIntervalMs?: number;
  identity: () => Promise<ProviderIdentity>;
  fetch: () => Promise<ProviderFetch>;
};

/** The providers to show and refresh now (enabled and available, in registration order). */
export type StoreSource = { providers: StoreProvider[]; minIntervalMs: number };

export type RefreshReason = "poll" | "turn" | "manual" | "retry";
export type RefreshOptions = { reason: RefreshReason; providerIds?: readonly string[] };

export type QuotaStoreDeps = {
  source: () => Promise<StoreSource>;
  /** The snapshot file; null keeps everything in memory. */
  file: string | null;
  now?: () => number;
  log?: (message: string) => void;
};

export type QuotaStore = {
  snapshot(): Promise<QuotaSnapshot>;
  /** Refreshes the due providers (all, or `providerIds`) and answers when they are done. */
  refresh(options: RefreshOptions): Promise<QuotaSnapshot>;
  subscribe(listener: (snapshot: QuotaSnapshot) => void): () => void;
  /** A login changed: identities are resolved again and memory-only rows are dropped. */
  invalidateIdentity(): void;
};

type Entry = SavedEntry & { persist: boolean };

/** Where a provider's rows live for its current identity. */
type ResolvedKey = { key: string; persist: boolean };

function resolvedKey(providerId: string, identity: ProviderIdentity): ResolvedKey {
  const hash = createHash("sha256").update(identity.key).digest("hex").slice(0, 32);
  return {
    key: `${providerId}|${identity.persist ? hash : `memory-${hash}`}`,
    persist: identity.persist,
  };
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1));
}

function isDue(
  entry: Entry | undefined,
  reason: RefreshReason,
  minIntervalMs: number,
  nowMs: number,
): boolean {
  if (reason === "manual" || reason === "retry") return true;
  if (entry?.checkedAtMs === undefined || entry.checkedAtMs > nowMs) return true;
  let waitMs = reason === "turn" ? Math.min(minIntervalMs, TURN_MIN_INTERVAL_MS) : minIntervalMs;
  if (entry.failures > 0) waitMs = Math.max(waitMs, backoffMs(entry.failures));
  if (nowMs - entry.checkedAtMs < waitMs) return false;
  return entry.error?.retryAtMs === undefined || nowMs >= entry.error.retryAtMs;
}

/** Rows by id and account; an id that appears twice for one account can't be matched. */
function rowsByAccount(rows: readonly QuotaRow[]): Map<string, QuotaRow | null> {
  const byKey = new Map<string, QuotaRow | null>();
  for (const row of rows) {
    const key = `${row.id}\u001f${row.account ?? ""}`;
    byKey.set(key, byKey.has(key) ? null : row);
  }
  return byKey;
}

/**
 * True when `before` (seen at `observedAtMs`, before its reset time) has reset by now: the
 * reset time passed less than a day ago and the new row has a later reset and more left.
 */
function didReset(before: QuotaRow, after: QuotaRow, observedAtMs: number, nowMs: number): boolean {
  const resetMs = Date.parse(before.resetsAt ?? "");
  const nextResetMs = Date.parse(after.resetsAt ?? "");
  if (!Number.isFinite(resetMs) || !Number.isFinite(nextResetMs)) return false;
  if (before.percentRemaining === undefined || after.percentRemaining === undefined) return false;
  const lateMs = nowMs - resetMs;
  return (
    observedAtMs <= resetMs &&
    lateMs >= 0 &&
    lateMs <= RESET_NOTICE_MAX_LATENESS_MS &&
    nextResetMs > resetMs &&
    nextResetMs > nowMs &&
    after.percentRemaining > before.percentRemaining &&
    before.percentRemaining < 100
  );
}

function findResets(previous: Entry, rows: readonly QuotaRow[], nowMs: number): ResetNotice[] {
  if (previous.okAtMs === undefined) return [];
  const before = rowsByAccount(previous.rows);
  const notices: ResetNotice[] = [];
  for (const [key, row] of rowsByAccount(rows)) {
    const old = before.get(key);
    if (!row || !old || row.type !== "quota" || !row.window || !WINDOWS[row.window].resets) {
      continue;
    }
    if (!didReset(old, row, previous.okAtMs, nowMs)) continue;
    notices.push({
      id: `${row.id}|${row.account ?? ""}|${old.resetsAt}`,
      rowId: row.id,
      providerId: row.providerId,
      ...(row.account === undefined ? {} : { account: row.account }),
      label: row.label,
      window: row.window,
      percentRemaining: row.percentRemaining as number,
      atMs: nowMs,
    });
  }
  return notices;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createQuotaStore(deps: QuotaStoreDeps): QuotaStore {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[opencode-quota] ${message}`));
  const entries = new Map<string, Entry>();
  /** Each provider's identity as last resolved; every snapshot and refresh resolves it again. */
  const currentKeys = new Map<string, ResolvedKey>();
  const inFlight = new Map<string, Promise<void>>();
  const fetching = new Set<string>();
  const listeners = new Set<(snapshot: QuotaSnapshot) => void>();
  let notices: ResetNotice[] = [];
  let loaded: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let writeAgain = false;

  function adopt(saved: SavedState): void {
    for (const [key, entry] of saved.entries) {
      const ours = entries.get(key);
      if (!ours || (ours.checkedAtMs ?? 0) < (entry.checkedAtMs ?? 0)) {
        entries.set(key, { ...entry, persist: true });
      }
    }
    const known = new Set(notices.map((notice) => notice.id));
    notices.push(...saved.notices.filter((notice) => !known.has(notice.id)));
  }

  function load(): Promise<void> {
    loaded ??= deps.file ? readSavedState(deps.file).then(adopt) : Promise.resolve();
    return loaded;
  }

  async function writeFile(file: string): Promise<void> {
    const saved = new Map<string, SavedEntry>();
    for (const [key, { persist: keep, ...entry }] of entries) {
      if (keep) saved.set(key, entry);
    }
    const state: SavedState = { entries: saved, notices };
    try {
      const options = { nowMs: now(), noticeMaxAgeMs: RESET_NOTICE_KEEP_MS };
      adopt(await writeSavedState(file, state, options));
    } catch (error) {
      log(`could not save the quota snapshot: ${errorMessage(error)}`);
    }
  }

  /** Writes the file soon; writes asked for while one runs are joined into one more write. */
  function persist(): void {
    const file = deps.file;
    if (!file) return;
    if (writing) {
      writeAgain = true;
      return;
    }
    writing = writeFile(file).finally(() => {
      writing = undefined;
      if (writeAgain) {
        writeAgain = false;
        persist();
      }
    });
  }

  async function flush(): Promise<void> {
    while (writing) await writing;
  }

  async function resolveKey(provider: StoreProvider): Promise<ResolvedKey> {
    let identity: ProviderIdentity;
    try {
      identity = await provider.identity();
    } catch {
      identity = { key: "unknown", persist: false };
    }
    const resolved = resolvedKey(provider.id, identity);
    currentKeys.set(provider.id, resolved);
    return resolved;
  }

  /** Loads the file once, reads the providers and resolves who each one is signed in as. */
  async function prepare(): Promise<StoreSource> {
    await load();
    const source = await deps.source();
    await Promise.all(source.providers.map(resolveKey));
    return source;
  }

  function buildSnapshot(source: StoreSource): QuotaSnapshot {
    const nowMs = now();
    notices = notices.filter((notice) => nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS);
    const providers = source.providers.map((provider): ProviderSnapshot => {
      const key = currentKeys.get(provider.id)?.key;
      const entry = key === undefined ? undefined : entries.get(key);
      return {
        providerId: provider.id,
        label: provider.label,
        rows: entry?.rows ?? [],
        ...(entry?.okAtMs === undefined ? {} : { okAtMs: entry.okAtMs }),
        ...(entry?.checkedAtMs === undefined ? {} : { checkedAtMs: entry.checkedAtMs }),
        ...(entry?.error === undefined ? {} : { error: entry.error }),
        refreshing: fetching.has(provider.id),
        debug: entry?.debug ?? [],
      };
    });
    return { version: 6, providers, resetNotices: [...notices], generatedAtMs: nowMs };
  }

  function emit(source: StoreSource): void {
    if (listeners.size === 0) return;
    const snapshot = buildSnapshot(source);
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log(`a quota snapshot subscriber failed: ${errorMessage(error)}`);
      }
    }
  }

  function record(provider: StoreProvider, where: ResolvedKey, result: ProviderFetch): void {
    const nowMs = now();
    const previous = entries.get(where.key);
    const gotRows = result.rows.length > 0;
    const error = result.error ?? (gotRows ? undefined : ({ code: "no_data" } as const));
    if (gotRows && previous) notices.push(...findResets(previous, result.rows, nowMs));
    const okAtMs = gotRows ? nowMs : previous?.okAtMs;
    entries.set(where.key, {
      providerId: provider.id,
      persist: where.persist,
      rows: gotRows ? result.rows : (previous?.rows ?? []),
      ...(okAtMs === undefined ? {} : { okAtMs }),
      checkedAtMs: nowMs,
      ...(error === undefined ? {} : { error }),
      failures: gotRows ? 0 : (previous?.failures ?? 0) + 1,
      debug: result.debug,
    });
    persist();
  }

  async function fetchProvider(provider: StoreProvider): Promise<ProviderFetch> {
    fetching.add(provider.id);
    try {
      return await provider.fetch();
    } catch (error) {
      return { rows: [], error: classifyError(errorMessage(error), now()), debug: [] };
    } finally {
      fetching.delete(provider.id);
    }
  }

  async function refreshProviderNow(
    provider: StoreProvider,
    reason: RefreshReason,
    source: StoreSource,
  ): Promise<void> {
    const minIntervalMs = provider.minIntervalMs ?? source.minIntervalMs;
    const where = currentKeys.get(provider.id) ?? (await resolveKey(provider));
    if (!isDue(entries.get(where.key), reason, minIntervalMs, now())) return;
    const result = await fetchProvider(provider);
    // A fetch is stored only under the account it read: if the login changed meanwhile, drop it.
    if ((await resolveKey(provider)).key !== where.key) return;
    record(provider, where, result);
    emit(source);
  }

  function refreshProvider(
    provider: StoreProvider,
    reason: RefreshReason,
    source: StoreSource,
  ): Promise<void> {
    const running = inFlight.get(provider.id);
    if (running) return running;
    const run = refreshProviderNow(provider, reason, source).finally(() => {
      inFlight.delete(provider.id);
    });
    inFlight.set(provider.id, run);
    return run;
  }

  async function runRefresh(source: StoreSource, options: RefreshOptions): Promise<void> {
    const providers = options.providerIds
      ? source.providers.filter((provider) => options.providerIds?.includes(provider.id))
      : source.providers;
    await Promise.all(
      providers.map((provider) => refreshProvider(provider, options.reason, source)),
    );
  }

  async function refresh(options: RefreshOptions): Promise<QuotaSnapshot> {
    const source = await prepare();
    await runRefresh(source, options);
    await flush();
    return buildSnapshot(source);
  }

  return {
    async snapshot() {
      const source = await prepare();
      runRefresh(source, { reason: "poll" }).catch((error) => {
        log(`background quota refresh failed: ${errorMessage(error)}`);
      });
      return buildSnapshot(source);
    },

    refresh,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    invalidateIdentity() {
      currentKeys.clear();
      for (const [key, entry] of entries) {
        if (!entry.persist) entries.delete(key);
      }
      // Subscribers get the new account's rows (or none) even when nothing needs a fetch.
      prepare()
        .then(async (source) => {
          await runRefresh(source, { reason: "poll" });
          emit(source);
        })
        .catch((error) => {
          log(`quota refresh after a login change failed: ${errorMessage(error)}`);
        });
    },
  };
}
