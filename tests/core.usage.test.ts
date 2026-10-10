import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UsageQuery, type UsageRow, usageReport } from "../src/core/usage.js";
import {
  type SessionDatabaseMessage,
  type SessionDatabaseSession,
  writeSessionDatabase,
} from "./helpers/session-database.js";

const M = 1_000_000;

/** Test prices in USD per 1M tokens. `claude-plain` has no cache rates: cache tokens cost as input. */
const TEST_PRICES = {
  "claude-test": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-plain": { input: 1, output: 4 },
};

/** A local time relative to the tests' "now", noon on Sunday 2026-03-15. */
function at(dayOffset: number, hours: number, minutes = 0, seconds = 0, ms = 0): number {
  return new Date(2026, 2, 15 + dayOffset, hours, minutes, seconds, ms).getTime();
}

const NOW = at(0, 12);

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-quota-usage-"));
  // OpenCode's database and the downloaded price list live under these roots.
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OPENCODE_DB", undefined);
  // A downloaded price list newer than the bundled one wins, so the test prices apply.
  const pricesFile = join(
    root,
    "cache",
    "opencode",
    "opencode-quota",
    "modelsdev-pricing.runtime.min.json",
  );
  await mkdir(dirname(pricesFile), { recursive: true });
  await writeFile(
    pricesFile,
    JSON.stringify({
      _meta: {
        source: "test",
        generatedAt: Date.now(),
        providers: ["anthropic"],
        units: "USD per 1M tokens",
      },
      providers: { anthropic: TEST_PRICES },
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let messageCount = 0;

/** A finished `claude-test` message from Anthropic in `ses_main`, with `fields` on top. */
function message(
  fields: Partial<SessionDatabaseMessage> & { created: number },
): SessionDatabaseMessage {
  messageCount += 1;
  return {
    id: `msg_${String(messageCount).padStart(4, "0")}`,
    sessionID: "ses_main",
    providerID: "anthropic",
    modelID: "claude-test",
    completed: fields.created + 1_000,
    ...fields,
  };
}

/** Writes OpenCode's database: `sessions`, plus a plain session for every other session id. */
function writeHistory(
  messages: SessionDatabaseMessage[],
  sessions: SessionDatabaseSession[] = [],
): void {
  const listed = new Set(sessions.map((session) => session.id));
  const unlisted = [...new Set(messages.map((item) => item.sessionID))]
    .filter((id) => !listed.has(id))
    .map((id) => ({ id, created: 0 }));
  writeSessionDatabase(join(root, "data", "opencode", "opencode.db"), {
    sessions: [...sessions, ...unlisted],
    messages,
  });
}

function sum(rows: UsageRow[], field: "costShare" | "tokenShare" | "tokens"): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

describe("usage report ranges", () => {
  // Output tokens tell the messages apart: each one has its own power of two.
  const history = () => [
    message({ created: at(0, 9), tokens: { output: 1 } }),
    message({ created: at(-1, 23, 59, 59, 999), tokens: { output: 2 } }),
    message({ created: at(-6, 0), tokens: { output: 4 } }),
    message({ created: at(-7, 23, 59, 59, 999), tokens: { output: 8 } }),
    message({ created: at(-29, 0), tokens: { output: 16 } }),
    message({ created: at(-30, 12), tokens: { output: 32 } }),
    message({ created: at(-89, 0), tokens: { output: 64 } }),
    message({ created: at(-90, 12), tokens: { output: 128 } }),
  ];

  const cases: Array<{ query: UsageQuery; tokens: number; days: [string, string, number] }> = [
    { query: { range: "today" }, tokens: 1, days: ["2026-03-15", "2026-03-15", 1] },
    { query: { range: "7d" }, tokens: 1 + 2 + 4, days: ["2026-03-09", "2026-03-15", 7] },
    { query: { range: "30d" }, tokens: 31, days: ["2026-02-14", "2026-03-15", 30] },
    { query: { range: "90d" }, tokens: 127, days: ["2025-12-16", "2026-03-15", 90] },
    // All time runs from the first to the last message.
    { query: { range: "all" }, tokens: 255, days: ["2025-12-15", "2026-03-15", 91] },
    {
      query: { range: "between", from: "2026-03-08", to: "2026-03-14" },
      tokens: 2 + 4 + 8,
      days: ["2026-03-08", "2026-03-14", 7],
    },
  ];

  it.each(cases)("$query.range counts the messages of its local days", async (item) => {
    writeHistory(history());

    const report = await usageReport(item.query, NOW);

    expect(report.totals.tokens.processed).toBe(item.tokens);
    const [firstDay, lastDay, dayCount] = item.days;
    expect(report.days).toHaveLength(dayCount);
    expect(report.days[0]?.date).toBe(firstDay);
    expect(report.days.at(-1)?.date).toBe(lastDay);
    expect(sum(report.days, "tokens")).toBe(item.tokens);
  });

  it("puts each message on its local day across midnight", async () => {
    writeHistory([
      message({ created: at(-1, 23, 59, 59, 999), tokens: { output: 1 } }),
      message({ created: at(0, 0), tokens: { output: 2 } }),
    ]);

    const week = await usageReport({ range: "7d" }, NOW);
    expect(week.days.slice(-2).map(({ date, tokens }) => ({ date, tokens }))).toEqual([
      { date: "2026-03-14", tokens: 1 },
      { date: "2026-03-15", tokens: 2 },
    ]);

    // A date range ends just before the next day starts: the midnight message is not in it.
    const oneDay = await usageReport(
      { range: "between", from: "2026-03-14", to: "2026-03-14" },
      NOW,
    );
    expect(oneDay).toMatchObject({ sinceMs: at(-1, 0), untilMs: at(0, 0) - 1 });
    expect(oneDay.totals.tokens.processed).toBe(1);
  });

  it("reports zeros, not an error, before OpenCode has any history", async () => {
    const all = await usageReport({ range: "all" }, NOW);
    expect(all.totals).toEqual({
      costUsd: 0,
      sessions: 0,
      tokens: { processed: 0, cachedInput: 0, uncachedInput: 0, output: 0 },
      costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
      unpricedTokens: 0,
      unpricedShare: 0,
    });
    expect(all.providers).toEqual([]);
    expect(all.days).toEqual([]);

    const week = await usageReport({ range: "7d" }, NOW);
    expect(week.days.map((day) => [day.tokens, day.costShare, day.tokenShare])).toEqual(
      Array.from({ length: 7 }, () => [0, 0, 0]),
    );
  });

  it.each<{ query: UsageQuery; error: string }>([
    {
      query: { range: "between", from: "2026-03-14", to: "2026-03-08" },
      error: "to (2026-03-08) is before from (2026-03-14)",
    },
    {
      query: { range: "between", from: "2026-02-31", to: "2026-03-08" },
      error: "from must be a date like 2026-01-31",
    },
    { query: { range: "between", from: "2026-03-01" }, error: "to must be a date like 2026-01-31" },
    { query: { range: "session" }, error: "sessionID is required for range session" },
    {
      query: { range: "session_tree", sessionID: "ses_missing" },
      error: "Session not found: ses_missing",
    },
  ])("rejects $query.range: $error", async ({ query, error }) => {
    writeHistory([message({ created: at(0, 8) })]);

    await expect(usageReport(query, NOW)).rejects.toThrow(error);
  });
});

describe("usage report sessions", () => {
  const sessions = [
    { id: "ses_root", created: 1 },
    { id: "ses_child", parentID: "ses_root", created: 2 },
    { id: "ses_grandchild", parentID: "ses_child", created: 3 },
    { id: "ses_other", created: 4 },
  ];
  const history = () => [
    message({ sessionID: "ses_root", created: at(0, 8), tokens: { output: 1 } }),
    message({ sessionID: "ses_child", created: at(0, 9), tokens: { output: 2 } }),
    message({ sessionID: "ses_grandchild", created: at(0, 10), tokens: { output: 4 } }),
    message({ sessionID: "ses_other", created: at(0, 11), tokens: { output: 8 } }),
  ];

  it.each<{ query: UsageQuery; tokens: number; sessions: number }>([
    { query: { range: "session", sessionID: "ses_root" }, tokens: 1, sessions: 1 },
    { query: { range: "session_tree", sessionID: "ses_root" }, tokens: 1 + 2 + 4, sessions: 1 },
    { query: { range: "session_tree", sessionID: "ses_child" }, tokens: 2 + 4, sessions: 1 },
    // Subagent sessions count as part of their top session.
    { query: { range: "today" }, tokens: 15, sessions: 2 },
  ])("$query.range $query.sessionID counts $sessions session(s)", async (item) => {
    writeHistory(history(), sessions);

    const report = await usageReport(item.query, NOW);

    expect(report.totals.tokens.processed).toBe(item.tokens);
    expect(report.totals.sessions).toBe(item.sessions);
    expect(report.providers.map((provider) => provider.sessions)).toEqual([item.sessions]);
    expect(report.sessionID).toBe(item.query.sessionID);
  });

  it.each([
    { forkAddsWork: false, tokens: 1 + 2, sessions: 1 },
    { forkAddsWork: true, tokens: 1 + 2 + 4, sessions: 2 },
  ])("counts a fork's copied messages once (fork adds work: $forkAddsWork)", async (item) => {
    const parent = [
      message({ sessionID: "ses_parent", created: at(0, 8), tokens: { output: 1 } }),
      message({ sessionID: "ses_parent", created: at(0, 9), tokens: { output: 2 } }),
    ];
    // OpenCode copies the parent's finished messages into a fork, with new ids.
    const copies = parent.map((original, index) => ({
      ...original,
      id: `msg_fork_copy_${index}`,
      sessionID: "ses_fork",
    }));
    const added = item.forkAddsWork
      ? [message({ sessionID: "ses_fork", created: at(0, 10), tokens: { output: 4 } })]
      : [];
    writeHistory([...parent, ...copies, ...added]);

    const report = await usageReport({ range: "all" }, NOW);

    expect(report.totals.tokens.processed).toBe(item.tokens);
    expect(report.totals.sessions).toBe(item.sessions);
  });
});

describe("usage report cost", () => {
  it("prices known models, leaves the rest unpriced, and breaks cost down by provider and model", async () => {
    writeHistory([
      message({ created: at(0, 8), tokens: { input: M } }),
      // The same model through Copilot is priced at its maker's price.
      message({ providerID: "github-copilot", created: at(0, 9), tokens: { output: M } }),
      message({
        providerID: "acme",
        modelID: "mystery-1",
        created: at(0, 10),
        tokens: { input: 3 * M },
      }),
    ]);

    const report = await usageReport({ range: "today" }, NOW);

    expect(report.totals).toMatchObject({
      costUsd: expect.closeTo(12, 10),
      sessions: 1,
      unpricedTokens: 3 * M,
      unpricedShare: 0.6,
    });
    const row = (costUsd: number, tokens: number, unpricedTokens: number) => ({
      costUsd: expect.closeTo(costUsd, 10),
      costShare: expect.closeTo(costUsd / 12, 10),
      tokens,
      tokenShare: tokens / (5 * M),
      unpricedTokens,
    });
    expect(report.providers).toEqual([
      { providerID: "github-copilot", sessions: 1, ...row(10, M, 0) },
      { providerID: "anthropic", sessions: 1, ...row(2, M, 0) },
      { providerID: "acme", sessions: 1, ...row(0, 3 * M, 3 * M) },
    ]);
    expect(report.models).toEqual([
      { providerID: "github-copilot", modelID: "claude-test", priced: true, ...row(10, M, 0) },
      { providerID: "anthropic", modelID: "claude-test", priced: true, ...row(2, M, 0) },
      { providerID: "acme", modelID: "mystery-1", priced: false, ...row(0, 3 * M, 3 * M) },
    ]);
    // Plain JSON: the report travels over the RPC as it is.
    expect(report).toStrictEqual(JSON.parse(JSON.stringify(report)));
  });

  const allKinds = { input: M, cacheRead: M, cacheWrite: M, output: M, reasoning: M };

  it.each([
    {
      providerID: "anthropic",
      modelID: "claude-test",
      costByType: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 + 10 },
      cacheSavingsUsd: 2 - 0.2,
    },
    // Without cache rates, cache tokens cost as plain input, so the cache saves nothing.
    {
      providerID: "anthropic",
      modelID: "claude-plain",
      costByType: { input: 1, cacheRead: 1, cacheWrite: 1, output: 4 + 4 },
      cacheSavingsUsd: 0,
    },
    {
      providerID: "acme",
      modelID: "mystery-1",
      costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
    },
  ])("splits $modelID cost by token type and counts cache savings", async (item) => {
    writeHistory([
      message({
        providerID: item.providerID,
        modelID: item.modelID,
        created: at(0, 8),
        tokens: allKinds,
      }),
    ]);

    const { totals } = await usageReport({ range: "today" }, NOW);

    expect(totals.tokens).toEqual({
      processed: 5 * M,
      cachedInput: M,
      uncachedInput: 2 * M,
      output: 2 * M,
    });
    const { input, cacheRead, cacheWrite, output } = item.costByType;
    expect(totals.costByType).toEqual({
      input: expect.closeTo(input, 10),
      cacheRead: expect.closeTo(cacheRead, 10),
      cacheWrite: expect.closeTo(cacheWrite, 10),
      output: expect.closeTo(output, 10),
    });
    expect(totals.costUsd).toBeCloseTo(input + cacheRead + cacheWrite + output, 10);
    expect(totals.cacheSavingsUsd).toBeCloseTo(item.cacheSavingsUsd, 10);
  });

  const mixedHistory = () => [
    message({ created: at(0, 8), tokens: { input: M } }),
    message({ providerID: "github-copilot", created: at(-1, 9), tokens: { output: M } }),
    message({ modelID: "claude-plain", created: at(-2, 10), tokens: { output: M / 2 } }),
    message({ providerID: "acme", modelID: "mystery-1", created: at(0, 11), tokens: { input: M } }),
  ];
  const unpricedHistory = () => [
    message({ providerID: "acme", modelID: "mystery-1", created: at(0, 8), tokens: { input: M } }),
    message({ providerID: "acme", modelID: "mystery-2", created: at(-1, 8), tokens: { input: M } }),
  ];

  it.each([
    { history: "priced and unpriced", messages: mixedHistory, costShares: 1 },
    // With nothing priced there is no cost to share: every cost share is 0.
    { history: "unpriced only", messages: unpricedHistory, costShares: 0 },
  ])("gives shares of 100% across providers, models and days ($history)", async (item) => {
    writeHistory(item.messages());

    const report = await usageReport({ range: "7d" }, NOW);

    for (const rows of [report.providers, report.models, report.days]) {
      expect(sum(rows, "costShare")).toBeCloseTo(item.costShares, 10);
      expect(sum(rows, "tokenShare")).toBeCloseTo(1, 10);
    }
  });
});
