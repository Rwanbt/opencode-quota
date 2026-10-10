/**
 * The server's quota store. It keeps the last known rows of every provider (in memory and in
 * one snapshot file), refreshes them in the background, and tells subscribers when they change.
 *
 * - `snapshot()` answers at once from what is known; when a provider is due it starts a
 *   background refresh.
 * - Refreshes are single-flight per provider and keep a minimum interval (30 s after a turn,
 *   none for a manual or retry refresh); failures back off from 1 to 15 minutes, or until the
 *   provider's own retry time.
 * - A failed refresh keeps the last good rows and records the error; when one of several
 *   logins fails, that login keeps its last rows while the others update.
 * - Rows and reset notices belong to an identity (account plus provider settings). Those of
 *   another identity are never shown; those whose identity can't be saved stay in memory and
 *   go on a login change. A fetch that was running when the login changed is dropped.
 * - When a quota window resets between two checks, a reset notice is recorded once.
 */
import { createHash } from "node:crypto";
import { classifyError } from "./errors.js";
import {
  joinNotices,
  readSavedState,
  rowSlot,
  type SavedEntry,
  type SavedState,
  writeSavedState,
} from "./persist.js";
import type {
  DebugDetail,
  ProviderSnapshot,
  QuotaError,
  QuotaRow,
  QuotaSnapshot,
  ResetNotice,
  SessionModel,
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
export type StoreSource = {
  providers: StoreProvider[];
  minIntervalMs: number;
  /** The providers serving a session's model, from the same settings read as `providers`. */
  providerIdsForModel?: (model: SessionModel) => string[];
};

export type RefreshReason = "poll" | "turn" | "manual" | "retry";
/** With a model, the snapshot also names the providers serving it. */
export type SnapshotOptions = { model?: SessionModel };
export type RefreshOptions = SnapshotOptions & {
  reason: RefreshReason;
  providerIds?: readonly string[];
};

export type QuotaStoreDeps = {
  source: () => Promise<StoreSource>;
  /** The snapshot file; null keeps everything in memory. */
  file: string | null;
  now?: () => number;
  log?: (message: string) => void;
};

export type QuotaStore = {
  snapshot(options?: SnapshotOptions): Promise<QuotaSnapshot>;
  /** Refreshes the due providers (all, or `providerIds`) and answers when they are done. */
  refresh(options: RefreshOptions): Promise<QuotaSnapshot>;
  subscribe(listener: (snapshot: QuotaSnapshot) => void): () => void;
  /** A login changed: identities are resolved again and memory-only rows are dropped. */
  invalidateIdentity(): void;
  /** Stops background work, waits for running fetches and the last file write. */
  dispose(): Promise<void>;
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
  // The one exception to the configured minimum: a model turn just used quota, so it may
  // refresh 30 s after the last check even when `minIntervalMs` is longer.
  let waitMs = reason === "turn" ? Math.min(minIntervalMs, TURN_MIN_INTERVAL_MS) : minIntervalMs;
  if (entry.failures > 0) waitMs = Math.max(waitMs, backoffMs(entry.failures));
  if (nowMs - entry.checkedAtMs < waitMs) return false;
  return entry.error?.retryAtMs === undefined || nowMs >= entry.error.retryAtMs;
}

/** Rows by id and account; an id that appears twice for one account can't be matched. */
function rowsByAccount(rows: readonly QuotaRow[]): Map<string, QuotaRow | null> {
  const byKey = new Map<string, QuotaRow | null>();
  for (const row of rows) {
    const key = rowSlot(row);
    byKey.set(key, byKey.has(key) ? null : row);
  }
  return byKey;
}

/**
 * True when `before` (its reset time first seen at `observedAtMs`, before that time) has reset
 * by now: the reset time passed less than a day ago and the new row has a later reset and more
 * left.
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
  const before = rowsByAccount(previous.rows);
  const notices: ResetNotice[] = [];
  for (const [key, row] of rowsByAccount(rows)) {
    const old = before.get(key);
    if (!row || !old || row.type !== "quota" || !row.window || !WINDOWS[row.window].resets) {
      continue;
    }
    const observedAtMs = previous.resetSeenAtMs[key] ?? previous.okAtMs;
    if (observedAtMs === undefined || !didReset(old, row, observedAtMs, nowMs)) continue;
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

/**
 * When each row's reset time was first seen. A provider that repeats a reset time already past
 * keeps the earlier observation, so the refill it reports later still counts as a reset.
 */
function resetSeenTimes(
  previous: Entry | undefined,
  rows: readonly QuotaRow[],
  nowMs: number,
): Record<string, number> {
  const before = previous ? rowsByAccount(previous.rows) : new Map<string, QuotaRow | null>();
  const seen: Record<string, number> = {};
  for (const row of rows) {
    if (!row.resetsAt) continue;
    const slot = rowSlot(row);
    const earlier = previous?.resetSeenAtMs[slot];
    seen[slot] =
      earlier !== undefined && before.get(slot)?.resetsAt === row.resetsAt ? earlier : nowMs;
  }
  return seen;
}

/** The previous rows of logins that are missing from `rows` (their fetch failed). */
function rowsOfMissingAccounts(previous: readonly QuotaRow[], rows: readonly QuotaRow[]) {
  const answered = new Set(rows.map((row) => row.account ?? ""));
  return previous.filter((row) => !answered.has(row.account ?? ""));
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
  /** Running fetches per provider (an old one may still run after a login change). */
  const fetching = new Map<string, number>();
  const listeners = new Set<(snapshot: QuotaSnapshot) => void>();
  /** Background work that `dispose` waits for. */
  const tasks = new Set<Promise<unknown>>();
  /** Bumped on every login change; a fetch started before it is dropped. */
  let generation = 0;
  let disposed = false;
  let loaded: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let writeAgain = false;

  function track<T>(promise: Promise<T>): Promise<T> {
    tasks.add(promise);
    promise
      .finally(() => {
        tasks.delete(promise);
      })
      .catch(() => {});
    return promise;
  }

  function adopt(saved: SavedState): void {
    for (const [key, entry] of saved.entries) {
      const ours = entries.get(key);
      if (!ours || (ours.checkedAtMs ?? 0) < (entry.checkedAtMs ?? 0)) {
        entries.set(key, { ...entry, persist: true });
      } else {
        ours.notices = joinNotices(ours.notices, entry.notices);
      }
    }
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
    try {
      const options = { nowMs: now(), noticeMaxAgeMs: RESET_NOTICE_KEEP_MS };
      adopt(await writeSavedState(file, { entries: saved }, options));
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

  function buildSnapshot(source: StoreSource, model?: SessionModel): QuotaSnapshot {
    const nowMs = now();
    const resetNotices: ResetNotice[] = [];
    const providers = source.providers.map((provider): ProviderSnapshot => {
      const key = currentKeys.get(provider.id)?.key;
      const entry = key === undefined ? undefined : entries.get(key);
      for (const notice of entry?.notices ?? []) {
        if (nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS) resetNotices.push(notice);
      }
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
    const snapshot: QuotaSnapshot = { version: 6, providers, resetNotices, generatedAtMs: nowMs };
    if (model && (model.id || model.providerID) && source.providerIdsForModel) {
      const shown = new Set(providers.map((provider) => provider.providerId));
      snapshot.currentModelProviderIds = source
        .providerIdsForModel(model)
        .filter((id) => shown.has(id));
    }
    return snapshot;
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
    const kept =
      gotRows && result.error && previous ? rowsOfMissingAccounts(previous.rows, result.rows) : [];
    const rows = gotRows ? [...result.rows, ...kept] : (previous?.rows ?? []);
    const found = gotRows && previous ? findResets(previous, result.rows, nowMs) : [];
    const notices = joinNotices(
      (previous?.notices ?? []).filter((notice) => nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS),
      found,
    );
    const okAtMs = gotRows ? nowMs : previous?.okAtMs;
    entries.set(where.key, {
      providerId: provider.id,
      persist: where.persist,
      rows,
      ...(okAtMs === undefined ? {} : { okAtMs }),
      checkedAtMs: nowMs,
      ...(error === undefined ? {} : { error }),
      // Any error backs off, also when only one of several logins failed.
      failures: error === undefined ? 0 : (previous?.failures ?? 0) + 1,
      debug: result.debug,
      notices,
      resetSeenAtMs: gotRows
        ? resetSeenTimes(previous, rows, nowMs)
        : (previous?.resetSeenAtMs ?? {}),
    });
    persist();
  }

  async function fetchProvider(provider: StoreProvider): Promise<ProviderFetch> {
    fetching.set(provider.id, (fetching.get(provider.id) ?? 0) + 1);
    try {
      return await provider.fetch();
    } catch (error) {
      return { rows: [], error: classifyError(errorMessage(error), now()), debug: [] };
    } finally {
      const left = (fetching.get(provider.id) ?? 1) - 1;
      if (left > 0) fetching.set(provider.id, left);
      else fetching.delete(provider.id);
    }
  }

  async function refreshProviderNow(
    provider: StoreProvider,
    reason: RefreshReason,
    source: StoreSource,
  ): Promise<void> {
    const startedIn = generation;
    const minIntervalMs = provider.minIntervalMs ?? source.minIntervalMs;
    const where = currentKeys.get(provider.id) ?? (await resolveKey(provider));
    if (!isDue(entries.get(where.key), reason, minIntervalMs, now())) return;
    const result = await fetchProvider(provider);
    // A fetch is stored only under the account it read: if the login changed meanwhile (even
    // when the key stays the same, as for memory-only rows), its answer is dropped.
    if (generation !== startedIn) return;
    const current = await resolveKey(provider);
    if (generation !== startedIn || current.key !== where.key) return;
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
    const run: Promise<void> = track(refreshProviderNow(provider, reason, source)).finally(() => {
      if (inFlight.get(provider.id) === run) inFlight.delete(provider.id);
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
    return buildSnapshot(source, options.model);
  }

  return {
    async snapshot(options = {}) {
      const source = await prepare();
      if (!disposed) {
        track(runRefresh(source, { reason: "poll" })).catch((error) => {
          log(`background quota refresh failed: ${errorMessage(error)}`);
        });
      }
      return buildSnapshot(source, options.model);
    },

    refresh,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    invalidateIdentity() {
      if (disposed) return;
      generation += 1;
      currentKeys.clear();
      inFlight.clear();
      for (const [key, entry] of entries) {
        if (!entry.persist) entries.delete(key);
      }
      // Subscribers see the new account's rows (or none) before any fetch, then fresh ones.
      track(
        prepare().then(async (source) => {
          emit(source);
          await runRefresh(source, { reason: "poll" });
        }),
      ).catch((error) => {
        log(`quota refresh after a login change failed: ${errorMessage(error)}`);
      });
    },

    async dispose() {
      disposed = true;
      listeners.clear();
      while (tasks.size > 0) await Promise.allSettled([...tasks]);
      await flush();
    },
  };
}
