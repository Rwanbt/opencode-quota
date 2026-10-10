/**
 * The usage report: what OpenCode's own message history used and would cost at API list
 * prices, for one range, with every number the usage view shows: totals, cost by token type,
 * cache savings, the share of tokens without a price, and breakdowns by provider, model and
 * day. Plain JSON, because it travels over the RPC.
 *
 * Rules:
 * - Messages are OpenCode's assistant messages, picked by creation time. The copies OpenCode
 *   makes when a session is forked count once (`opencode-storage` drops them).
 * - Cost comes from the shared pricing resolver (models.dev snapshot, Cursor's own table). A
 *   model without a price adds tokens but no cost; its tokens are the unpriced share.
 * - Sessions count conversations: a subagent session counts as part of its top parent.
 * - Ranges and days are local calendar days: "7d" is today and the 6 days before it, and
 *   "between" includes both dates.
 * - Token kinds: cached input = cache reads; uncached input = input + cache writes;
 *   output = output + reasoning; processed = all three.
 */
import type { CostBuckets } from "../lib/modelsdev-pricing.js";
import {
  iterAssistantMessages,
  iterAssistantMessagesForSession,
  iterAssistantMessagesForSessions,
  type OpenCodeMessage,
  type OpenCodeSessionInfo,
  readAllSessionsIndex,
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

function localMidnight(ms: number, dayOffset: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset).getTime();
}

function localDate(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/** The local midnight that starts `text` ("2026-01-31"). */
function parseLocalDate(text: string | undefined, field: "from" | "to"): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(year, month - 1, day);
    // Rejects days that roll over (2026-02-31) and years Date reads as 19xx (0050).
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return date.getTime();
    }
  }
  throw new Error(`${field} must be a date like 2026-01-31`);
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

async function readMessages(query: UsageQuery, window: TimeWindow): Promise<OpenCodeMessage[]> {
  if (query.range === "session") {
    return iterAssistantMessagesForSession({ sessionID: requireSessionID(query) });
  }
  if (query.range === "session_tree") {
    const tree = await resolveSessionTree(requireSessionID(query));
    return iterAssistantMessagesForSessions({ sessionIDs: tree.map((node) => node.sessionID) });
  }
  return iterAssistantMessages(window);
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

export async function usageReport(
  query: UsageQuery,
  nowMs: number = Date.now(),
): Promise<UsageReport> {
  const window = resolveWindow(query, nowMs);
  const messages = await readMessages(query, window);
  const sessionsIndex = await readAllSessionsIndex();

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

  for (const message of messages) {
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
