/**
 * The usage report: what OpenCode's own message history used and would cost at API list
 * prices, for one range, with every number the usage view shows: totals, cost by token type,
 * cache savings, the share of tokens without a price, and breakdowns by provider, model and
 * day. Plain JSON, because it travels over the RPC.
 *
 * Rules:
 * - Messages are OpenCode's assistant messages and the compactions that recorded usage, picked
 *   by creation time. A fork starts with copies of its parent's messages; only the parent
 *   counts them, in every range (`readUsageMessagePages` leaves them out).
 * - Cost comes from the shared pricing resolver (models.dev snapshot, Cursor's own table). A
 *   model without a price adds tokens but no cost; its tokens are the unpriced share. A failed
 *   compaction names no model, so its tokens are unpriced too (provider and model "unknown").
 * - Sessions count conversations: a subagent session counts as part of its top parent.
 * - Ranges and days are local calendar days: "7d" is today and the 6 days before it, and
 *   "between" includes both dates.
 * - Token kinds: cached input = cache reads; uncached input = input + cache writes;
 *   output = output + reasoning; processed = all three.
 * - The history is read in pages, and the plugin's other work runs between pages. Identical
 *   questions share one read: see `usageReport`.
 */
import { parseCalendarDate } from "../lib/calendar-date.js";
import { type CostBuckets, getPricingSnapshotSelection } from "../lib/modelsdev-pricing.js";
import { getOpenCodeDbPath } from "../lib/opencode-db-path.js";
import {
  type OpenCodeSessionInfo,
  readAllSessionsIndex,
  readUsageMessagePages,
  SessionNotFoundError,
} from "../lib/opencode-storage.js";
import { type ModelPricing, resolveModelPricing, resolveSessionTree } from "../lib/quota-stats.js";
import {
  emptyTokenBuckets,
  type TokenBuckets,
  tokenBucketsFromMessage,
} from "../lib/token-buckets.js";
import { calculateUsdFromTokenBuckets } from "../lib/token-cost.js";

export type UsageRange =
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "all"
  | "session"
  | "session_tree"
  | "between";

export type UsageQuery = {
  range: UsageRange;
  /** The session for "session" and "session_tree" (the session plus its subagents). */
  sessionID?: string;
  /** Local dates like "2026-01-31" for "between", both included. */
  from?: string;
  to?: string;
};

/** Token counts by kind; `processed` = `cachedInput` + `uncachedInput` + `output`. */
export type UsageTokens = {
  processed: number;
  cachedInput: number;
  uncachedInput: number;
  output: number;
};

export type UsageCostByType = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output and reasoning. */
  output: number;
};

/** One breakdown line. Shares are 0..1 of the report's total, and 0 when that total is 0. */
export type UsageRow = {
  costUsd: number;
  costShare: number;
  /** Processed tokens. */
  tokens: number;
  tokenShare: number;
  /** Processed tokens of models without a price; they add no cost. */
  unpricedTokens: number;
};

export type UsageProviderRow = UsageRow & {
  /** OpenCode's provider id, for example "anthropic" or "github-copilot". */
  providerID: string;
  sessions: number;
};

export type UsageModelRow = UsageRow & { providerID: string; modelID: string; priced: boolean };

/** `date` is a local day like "2026-01-31". */
export type UsageDayRow = UsageRow & { date: string };

export type UsageReport = {
  range: UsageRange;
  /** The time window (epoch ms, both included); absent for "all" and the session ranges. */
  sinceMs?: number;
  untilMs?: number;
  /** Present for the session ranges. */
  sessionID?: string;
  generatedAtMs: number;
  totals: {
    costUsd: number;
    sessions: number;
    tokens: UsageTokens;
    costByType: UsageCostByType;
    cacheSavingsUsd: number;
    unpricedTokens: number;
    /** `unpricedTokens` / `tokens.processed`. */
    unpricedShare: number;
  };
  /** Most cost first, then most tokens. */
  providers: UsageProviderRow[];
  /** Most cost first, then most tokens. */
  models: UsageModelRow[];
  /** Every local day of the range (or from the first to the last message), oldest first. */
  days: UsageDayRow[];
};

/** How many local days the rolling ranges cover, today included. */
const RANGE_DAYS: Partial<Record<UsageRange, number>> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

/** Rows read in one go: one page holds the event loop for a few milliseconds. */
const PAGE_ROWS = 250;

/** How long a report answers the same question again. */
const REPORT_REUSE_MS = 30_000;

type TimeWindow = { sinceMs?: number; untilMs?: number };

/** What one message adds to the report. */
type MessageUse = {
  priced: boolean;
  tokens: UsageTokens;
  costByType: UsageCostByType;
  costUsd: number;
  cacheSavingsUsd: number;
};

type Tally = { costUsd: number; tokens: number; unpricedTokens: number };

/**
 * The local midnight that starts a day; `day` may run past the month. Unlike
 * `new Date(year, month, day)`, it keeps years below 100 as they are.
 */
function localDayStart(year: number, monthIndex: number, day: number): number {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, monthIndex, day);
  return date.getTime();
}

function localMidnight(ms: number, dayOffset: number): number {
  const date = new Date(ms);
  return localDayStart(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
}

function localDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/** The local midnight that starts `text` ("2026-01-31"). */
function parseLocalDate(text: string | undefined, field: "from" | "to"): number {
  // The RPC checks dates with this same rule, so a date it lets through never fails here.
  const date = parseCalendarDate(text);
  if (!date) throw new Error(`${field} must be a date like 2026-01-31`);
  return localDayStart(date.year, date.month - 1, date.day);
}

function resolveWindow(query: UsageQuery, nowMs: number): TimeWindow {
  const rangeDays = RANGE_DAYS[query.range];
  if (rangeDays !== undefined) {
    return { sinceMs: localMidnight(nowMs, 1 - rangeDays), untilMs: nowMs };
  }
  if (query.range !== "between") return {};
  const fromMs = parseLocalDate(query.from, "from");
  const toMs = parseLocalDate(query.to, "to");
  if (toMs < fromMs) throw new Error(`to (${query.to}) is before from (${query.from})`);
  // The storage bounds are inclusive: end 1 ms before the next day starts.
  return { sinceMs: fromMs, untilMs: localMidnight(toMs, 1) - 1 };
}

function requireSessionID(query: UsageQuery): string {
  if (!query.sessionID) throw new Error(`sessionID is required for range ${query.range}`);
  return query.sessionID;
}

/** The sessions a session range reads; undefined for the other ranges, which read them all. */
async function sessionsToRead(
  query: UsageQuery,
  sessionsIndex: Record<string, OpenCodeSessionInfo>,
): Promise<string[] | undefined> {
  if (query.range === "session") {
    const sessionID = requireSessionID(query);
    if (!sessionsIndex[sessionID]) throw new SessionNotFoundError(sessionID, getOpenCodeDbPath());
    return [sessionID];
  }
  if (query.range === "session_tree") {
    const tree = await resolveSessionTree(requireSessionID(query));
    return tree.map((node) => node.sessionID);
  }
  return undefined;
}

/** The session at the top of `sessionID`'s parent chain (subagents belong to their parent). */
function topSessionID(sessionID: string, index: Record<string, OpenCodeSessionInfo>): string {
  const seen = new Set<string>([sessionID]);
  let current = sessionID;
  for (let parentID = index[current]?.parentID; parentID && !seen.has(parentID); ) {
    seen.add(parentID);
    current = parentID;
    parentID = index[current]?.parentID;
  }
  return current;
}

function messageUse(buckets: TokenBuckets, rates: CostBuckets | null): MessageUse {
  const tokens = {
    cachedInput: buckets.cache_read,
    uncachedInput: buckets.input + buckets.cache_write,
    output: buckets.output + buckets.reasoning,
  };
  const processed = tokens.cachedInput + tokens.uncachedInput + tokens.output;
  if (!rates) {
    return {
      priced: false,
      tokens: { processed, ...tokens },
      costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      costUsd: 0,
      cacheSavingsUsd: 0,
    };
  }
  // Each kind through the one cost formula, so its rate fallbacks apply (a missing cache rate
  // costs as input, a missing reasoning rate as output).
  const costOf = (bucket: keyof TokenBuckets, count: number) =>
    calculateUsdFromTokenBuckets(rates, { ...emptyTokenBuckets(), [bucket]: count });
  const costByType = {
    input: costOf("input", buckets.input),
    cacheRead: costOf("cache_read", buckets.cache_read),
    cacheWrite: costOf("cache_write", buckets.cache_write),
    output: costOf("output", buckets.output) + costOf("reasoning", buckets.reasoning),
  };
  return {
    priced: true,
    tokens: { processed, ...tokens },
    costByType,
    costUsd: costByType.input + costByType.cacheRead + costByType.cacheWrite + costByType.output,
    // Cache savings: the cache reads at the plain input price, minus what they cost as reads.
    cacheSavingsUsd: costOf("input", buckets.cache_read) - costByType.cacheRead,
  };
}

/** `map`'s value for `key`, created and stored first when missing. */
function entryFor<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function emptyTally(): Tally {
  return { costUsd: 0, tokens: 0, unpricedTokens: 0 };
}

function addUse(tally: Tally, use: MessageUse): void {
  tally.costUsd += use.costUsd;
  tally.tokens += use.tokens.processed;
  if (!use.priced) tally.unpricedTokens += use.tokens.processed;
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function toRow(tally: Tally, total: { costUsd: number; tokens: number }): UsageRow {
  return {
    costUsd: tally.costUsd,
    costShare: share(tally.costUsd, total.costUsd),
    tokens: tally.tokens,
    tokenShare: share(tally.tokens, total.tokens),
    unpricedTokens: tally.unpricedTokens,
  };
}

function byCostThenTokens(a: UsageRow, b: UsageRow): number {
  return b.costUsd - a.costUsd || b.tokens - a.tokens;
}

/** Every local day from the one holding `firstMs` to the one holding `lastMs`. */
function localDays(firstMs: number, lastMs: number): string[] {
  const days: string[] = [];
  for (let dayMs = localMidnight(firstMs, 0); dayMs <= lastMs; dayMs = localMidnight(dayMs, 1)) {
    days.push(localDate(dayMs));
  }
  return days;
}

type RecentReport = { startedMs: number; report: Promise<UsageReport> };

/** Reports started in the last `REPORT_REUSE_MS`, by question (see `usageReport`). */
const recentReports = new Map<string, RecentReport>();

function isRecent(recent: RecentReport, nowMs: number): boolean {
  const ageMs = nowMs - recent.startedMs;
  return ageMs >= 0 && ageMs < REPORT_REUSE_MS;
}

/**
 * The usage report for `query` at `nowMs`. Identical questions (same database, price list
 * choice, local day and query) share one read of the history: a request made while the same
 * report is being built waits for it, and a finished report answers again for 30 s, so its
 * numbers can be up to 30 s old. A failed report is not kept.
 */
export async function usageReport(
  query: UsageQuery,
  nowMs: number = Date.now(),
): Promise<UsageReport> {
  for (const [key, recent] of recentReports) {
    if (!isRecent(recent, nowMs)) recentReports.delete(key);
  }
  const { range, sessionID, from, to } = query;
  const priceList = getPricingSnapshotSelection();
  // The local day decides where the rolling ranges start: after midnight, a new report.
  const today = localDate(nowMs);
  const key = JSON.stringify([getOpenCodeDbPath(), priceList, today, range, sessionID, from, to]);
  const recent = recentReports.get(key);
  if (recent) return recent.report;

  const report = buildUsageReport(query, nowMs);
  recentReports.set(key, { startedMs: nowMs, report });
  report.catch(() => {
    if (recentReports.get(key)?.report === report) recentReports.delete(key);
  });
  return report;
}

async function buildUsageReport(query: UsageQuery, nowMs: number): Promise<UsageReport> {
  const window = resolveWindow(query, nowMs);
  const sessionsIndex = await readAllSessionsIndex();
  const sessionIDs = await sessionsToRead(query, sessionsIndex);

  const totalTokens: UsageTokens = { processed: 0, cachedInput: 0, uncachedInput: 0, output: 0 };
  const costByType: UsageCostByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const total = emptyTally();
  let cacheSavingsUsd = 0;
  const sessions = new Set<string>();
  const topSessionIDs = new Map<string, string>();
  const pricingByModel = new Map<string, ModelPricing>();
  const providers = new Map<string, { tally: Tally; sessions: Set<string> }>();
  const models = new Map<
    string,
    { providerID: string; modelID: string; priced: boolean; tally: Tally }
  >();
  const days = new Map<string, Tally>();
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;

  const pages = readUsageMessagePages({ ...window, sessionIDs, pageSize: PAGE_ROWS });
  for await (const page of pages) {
    for (const message of page) {
      // Storage always sets the creation time; it is what places a message on a day.
      const createdMs = message.time?.created;
      if (typeof createdMs !== "number") continue;
      const providerID = message.providerID ?? "unknown";
      const modelID = message.modelID ?? "unknown";
      const modelKey = `${providerID}\n${modelID}`;
      const pricing = entryFor(pricingByModel, modelKey, () =>
        resolveModelPricing({ providerID: message.providerID, modelID: message.modelID }),
      );
      const use = messageUse(
        tokenBucketsFromMessage(message),
        pricing.kind === "priced" ? pricing.rates : null,
      );
      const topSession = entryFor(topSessionIDs, message.sessionID, () =>
        topSessionID(message.sessionID, sessionsIndex),
      );

      addUse(total, use);
      for (const kind of ["processed", "cachedInput", "uncachedInput", "output"] as const) {
        totalTokens[kind] += use.tokens[kind];
      }
      for (const kind of ["input", "cacheRead", "cacheWrite", "output"] as const) {
        costByType[kind] += use.costByType[kind];
      }
      cacheSavingsUsd += use.cacheSavingsUsd;
      sessions.add(topSession);

      const provider = entryFor(providers, providerID, () => ({
        tally: emptyTally(),
        sessions: new Set<string>(),
      }));
      addUse(provider.tally, use);
      provider.sessions.add(topSession);
      const model = entryFor(models, modelKey, () => ({
        providerID,
        modelID,
        priced: use.priced,
        tally: emptyTally(),
      }));
      addUse(model.tally, use);
      addUse(entryFor(days, localDate(createdMs), emptyTally), use);
      firstMs = Math.min(firstMs, createdMs);
      lastMs = Math.max(lastMs, createdMs);
    }
    // Let the plugin's other work run before the next page: a long history must not stall it.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const rowTotal = { costUsd: total.costUsd, tokens: total.tokens };
  // A time window lists all its days; the other ranges the days from first to last message.
  const dayFirstMs = window.sinceMs ?? firstMs;
  const dayLastMs = window.untilMs ?? lastMs;
  const dayList = dayFirstMs <= dayLastMs ? localDays(dayFirstMs, dayLastMs) : [];
  const isSessionRange = query.range === "session" || query.range === "session_tree";

  return {
    range: query.range,
    ...(window.sinceMs === undefined ? {} : { sinceMs: window.sinceMs }),
    ...(window.untilMs === undefined ? {} : { untilMs: window.untilMs }),
    ...(isSessionRange ? { sessionID: requireSessionID(query) } : {}),
    generatedAtMs: nowMs,
    totals: {
      costUsd: total.costUsd,
      sessions: sessions.size,
      tokens: totalTokens,
      costByType,
      cacheSavingsUsd,
      unpricedTokens: total.unpricedTokens,
      unpricedShare: share(total.unpricedTokens, total.tokens),
    },
    providers: [...providers]
      .map(([providerID, provider]) => ({
        providerID,
        sessions: provider.sessions.size,
        ...toRow(provider.tally, rowTotal),
      }))
      .sort((a, b) => byCostThenTokens(a, b) || a.providerID.localeCompare(b.providerID)),
    models: [...models.values()]
      .map(({ tally, ...model }) => ({ ...model, ...toRow(tally, rowTotal) }))
      .sort(
        (a, b) =>
          byCostThenTokens(a, b) ||
          a.providerID.localeCompare(b.providerID) ||
          a.modelID.localeCompare(b.modelID),
      ),
    days: dayList.map((date) => ({ date, ...toRow(days.get(date) ?? emptyTally(), rowTotal) })),
  };
}
