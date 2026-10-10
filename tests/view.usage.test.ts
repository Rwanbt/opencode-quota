import { describe, expect, it } from "vitest";

import type {
  UsageDayRow,
  UsageModelRow,
  UsageProviderRow,
  UsageReport,
} from "../src/core/usage.js";
import { formatShare, formatTokens, formatUsd } from "../src/view/numbers.js";
import { type UsageLine, type UsageViewOptions, usageText, usageView } from "../src/view/usage.js";

const M = 1_000_000;
/** The report's "now": 3 pm on Saturday 2026-10-10, local time. */
const NOW = new Date(2026, 9, 10, 15).getTime();

/** [cost in USD, processed tokens, tokens without a price] */
type Amounts = [costUsd: number, tokens: number, unpricedTokens?: number];

type ReportSpec = {
  range?: UsageReport["range"];
  sessions: number;
  providers: [providerID: string, sessions: number, ...Amounts][];
  models: [providerID: string, modelID: string, ...Amounts][];
  /** One entry per day, oldest first, ending on `lastDay`. */
  days: Amounts[];
  lastDay?: Date;
  tokens: { cachedInput: number; uncachedInput: number; output: number };
  costByType: UsageReport["totals"]["costByType"];
  cacheSavingsUsd: number;
};

/** A hand-built report: totals and shares come from the provider rows. */
function buildReport(spec: ReportSpec): UsageReport {
  const costUsd = spec.providers.reduce((sum, [, , cost]) => sum + cost, 0);
  const tokens = spec.providers.reduce((sum, [, , , count]) => sum + count, 0);
  const unpricedTokens = spec.providers.reduce((sum, [, , , , unpriced = 0]) => sum + unpriced, 0);
  const row = ([cost, count, unpriced = 0]: Amounts) => ({
    costUsd: cost,
    costShare: costUsd > 0 ? cost / costUsd : 0,
    tokens: count,
    tokenShare: tokens > 0 ? count / tokens : 0,
    unpricedTokens: unpriced,
  });
  const lastDay = spec.lastDay ?? new Date(2026, 9, 10);
  const days: UsageDayRow[] = spec.days.map((amounts, index) => {
    const day = new Date(
      lastDay.getFullYear(),
      lastDay.getMonth(),
      lastDay.getDate() - (spec.days.length - 1 - index),
    );
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    return { date, ...row(amounts) };
  });
  const providers: UsageProviderRow[] = spec.providers.map(
    ([providerID, sessions, ...amounts]) => ({
      providerID,
      sessions,
      ...row(amounts),
    }),
  );
  const models: UsageModelRow[] = spec.models.map(([providerID, modelID, ...amounts]) => ({
    providerID,
    modelID,
    priced: (amounts[2] ?? 0) === 0,
    ...row(amounts),
  }));
  return {
    range: spec.range ?? "30d",
    generatedAtMs: NOW,
    totals: {
      costUsd,
      sessions: spec.sessions,
      tokens: { processed: tokens, ...spec.tokens },
      costByType: spec.costByType,
      cacheSavingsUsd: spec.cacheSavingsUsd,
      unpricedTokens,
      unpricedShare: tokens > 0 ? unpricedTokens / tokens : 0,
    },
    providers,
    models,
    days,
  };
}

/** 30 days of cost, Sep 11 to Oct 10: quiet at first, a spike on Sep 26, two days off. */
const DAILY_COST = [
  0, 0.4, 0.8, 1.2, 0, 9.5, 2.1, 7.4, 3.3, 0.9, 4.2, 30.5, 180.3, 210.7, 260.9, 1371.2, 170.1,
  175.6, 268.4, 250.2, 95.7, 230.4, 299.8, 120.5, 98.3, 415.2, 430.8, 260.3, 120.6, 1004.9,
];
const DAILY_TOTAL = DAILY_COST.reduce((sum, cost) => sum + cost, 0);

/** Close to the maintainer's screenshot of T3 Code: one provider has almost all the cost. */
function t3Report(): UsageReport {
  return buildReport({
    sessions: 636,
    providers: [
      ["anthropic", 248, 5011, 12_900 * M],
      ["cursor", 316, 353.05, 368 * M],
      ["openai", 63, 47.3, 119 * M],
      ["opencode", 9, 4.06, 8.97 * M, 0.97 * M],
    ],
    models: [
      ["anthropic", "claude-opus-5-5", 4410.41, 12_500 * M],
      ["cursor", "composer-2", 353.05, 368 * M],
      ["anthropic", "claude-fable-5-1", 330.3, 270 * M],
      ["anthropic", "claude-sonnet-5", 270.29, 130 * M],
      ["openai", "gpt-6.1", 47.3, 119 * M],
      ["opencode", "gpt-6.1", 4.06, 8 * M],
      ["opencode", "exo-free", 0, 0.97 * M, 0.97 * M],
    ],
    days: DAILY_COST.map((cost) => [
      (cost / DAILY_TOTAL) * 5415.41,
      cost === 0 ? 0 : Math.round(cost * 2.47 * M),
    ]),
    tokens: { cachedInput: 13_200 * M, uncachedInput: 146 * M, output: 49.97 * M },
    costByType: { input: 369.53, cacheRead: 2749.39, cacheWrite: 1716.2, output: 580.29 },
    cacheSavingsUsd: 49_636.93,
  });
}

function textOf(line: UsageLine): string {
  return line.map((part) => part.text).join("");
}

function render(report: UsageReport, options: UsageViewOptions): string[] {
  return usageView(report, options).map(textOf);
}

/** The first line whose text holds `text`, and the lines after it. */
function from(lines: UsageLine[], text: string): UsageLine[] {
  const index = lines.findIndex((line) => textOf(line).includes(text));
  if (index < 0) throw new Error(`no line with ${JSON.stringify(text)}`);
  return lines.slice(index);
}

/** One provider with a price, one free model, one model without a price, over 7 days. */
function unpricedReport(): UsageReport {
  return buildReport({
    range: "7d",
    sessions: 3,
    providers: [
      ["anthropic", 2, 1.5, 3 * M],
      ["opencode", 1, 0, 2 * M, 1 * M],
    ],
    models: [
      ["anthropic", "claude-test", 1.5, 3 * M],
      ["opencode", "big-pickle", 0, 1 * M],
      ["opencode", "exo-free", 0, 1 * M, 1 * M],
    ],
    // Oct 4 to Oct 10: Oct 7 only used the free model, Oct 8 only the one without a price.
    days: [
      [0, 0],
      [0, 0],
      [1.5, 3 * M],
      [0, 1 * M],
      [0, 1 * M, 1 * M],
      [0, 0],
      [0, 0],
    ],
    tokens: { cachedInput: 2 * M, uncachedInput: 2.5 * M, output: 0.5 * M },
    costByType: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 1 },
    cacheSavingsUsd: 0,
  });
}

const EMPTY_REPORT = buildReport({
  range: "7d",
  sessions: 0,
  providers: [],
  models: [],
  days: Array.from({ length: 7 }, (): Amounts => [0, 0]),
  tokens: { cachedInput: 0, uncachedInput: 0, output: 0 },
  costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  cacheSavingsUsd: 0,
});

/** 400 days up to Oct 10, 2026, every one of them used: more days than a chart has columns. */
function longReport(): UsageReport {
  const days = Array.from({ length: 400 }, (_, index): Amounts => [index % 5, (index % 5) * M]);
  const cost = days.reduce((sum, [dayCost]) => sum + dayCost, 0);
  return buildReport({
    range: "all",
    sessions: 40,
    providers: [["anthropic", 40, cost, cost * M]],
    models: [["anthropic", "claude-test", cost, cost * M]],
    days,
    tokens: { cachedInput: 0, uncachedInput: cost * M, output: 0 },
    costByType: { input: cost, cacheRead: 0, cacheWrite: 0, output: 0 },
    cacheSavingsUsd: 0,
  });
}

describe("number formats", () => {
  it.each([
    [formatUsd, 0, "$0.00"],
    [formatUsd, 0.004, "<$0.01"],
    [formatUsd, 0.005, "$0.01"],
    [formatUsd, 1234.5, "$1,234.50"],
    [formatUsd, 49_636.93, "$49,636.93"],
    [formatTokens, 950, "950"],
    [formatTokens, 12_345, "12.3K"],
    [formatTokens, 8.97 * M, "8.97M"],
    [formatTokens, 146 * M, "146M"],
    [formatTokens, 13_396 * M, "13.4B"],
    [formatTokens, 999_950, "1M"],
    [formatShare, 0, "0%"],
    [formatShare, 0.0004, "<0.1%"],
    [formatShare, 0.009, "0.9%"],
    [formatShare, 0.925, "92.5%"],
    [formatShare, 0.05, "5%"],
    [formatShare, 1, "100%"],
  ])("%o(%d) is %s", (format, value, expected) => {
    expect(format(value)).toBe(expected);
  });
});

describe("usageView", () => {
  const reports = { t3: t3Report(), unpriced: unpricedReport(), long: longReport() };
  const cases = Object.entries(reports).flatMap(([name, report]) =>
    [10, 32, 64, 80, 109, 110, 160, 240].flatMap((width) =>
      (["cost", "tokens"] as const).flatMap((mode) =>
        (["model", "day"] as const).map((breakdown) => ({ name, report, width, mode, breakdown })),
      ),
    ),
  );

  it.each(cases)("$name at $width columns, $mode by $breakdown: every line fits", (testCase) => {
    const lines = usageView(testCase.report, testCase);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(textOf(line).length).toBeLessThanOrEqual(testCase.width);
      for (const part of line) expect(part.text).not.toMatch(/^$|\n/);
    }
  });

  it.each([
    { width: 109, beside: false },
    { width: 110, beside: true },
    { width: 160, beside: true },
  ])("puts the chart beside the total at $width columns: $beside", ({ width, beside }) => {
    const totalLine = render(t3Report(), { mode: "cost", breakdown: "model", width })[0];
    expect(totalLine.startsWith("$5,415.41  636 sessions · API estimate")).toBe(true);
    expect(totalLine.includes("Daily cost")).toBe(beside);
  });

  it.each([
    {
      mode: "cost" as const,
      title: "$5,415.41",
      detail: "  636 sessions · API estimate",
      provider: "$5,011.00",
      share: "  92.5% of cost · 12.9B tokens",
    },
    {
      mode: "tokens" as const,
      title: "13.4B tokens",
      detail: "  636 sessions · $5,415.41 API estimate",
      provider: "12.9B",
      share: "  96.3% of tokens · $5,011.00",
    },
  ])("$mode mode: the total, then a dominant provider", (expected) => {
    const lines = usageView(t3Report(), { mode: expected.mode, breakdown: "model", width: 80 });
    expect(lines[0]).toEqual([
      { text: expected.title, role: "title" },
      { text: expected.detail, role: "muted" },
    ]);
    const [anthropic, share] = from(lines, "Anthropic");
    expect(anthropic[0]).toEqual({ text: "● ", role: "provider:0" });
    expect(anthropic).toContainEqual({ text: "Anthropic", role: "text" });
    expect(anthropic).toContainEqual({ text: "  248 sessions", role: "muted" });
    expect(anthropic.at(-1)).toEqual({ text: expected.provider, role: "value" });
    expect(textOf(anthropic)).toHaveLength(48);
    expect(share).toEqual([{ text: expected.share, role: "muted" }]);
    // Each provider keeps its place in the report as its color slot.
    expect(from(lines, "OpenCode Zen")[0][0]).toEqual({ text: "● ", role: "provider:3" });
  });

  it("draws a daily chart: top value, 0, one column per day, first/middle/last dates", () => {
    const lines = from(
      usageView(t3Report(), { mode: "cost", breakdown: "model", width: 80 }),
      "Daily cost",
    );
    const rows = lines.slice(1, 7);
    expect(rows.map((row) => row.map((part) => part.role))).toEqual(
      Array.from({ length: 6 }, () => ["muted", "bar"]),
    );
    expect(rows[0][0].text).toBe("$1,232.63 ");
    expect(rows[5][0].text).toBe("        0 ");
    // Only the Sep 26 spike reaches the top row; Sep 11 and Sep 15 cost nothing, so no block.
    expect(rows[0][1].text.trim()).toMatch(/^█+$/);
    expect(rows[5][1].text).toMatch(/^ +▁+ +▁/);
    expect(textOf(lines[7]).trim()).toMatch(/^Sep 11 +Sep 26 +Oct 10$/);
  });

  it("charts many days a few to a column, with the year on dates outside this year", () => {
    const lines = from(
      usageView(longReport(), { mode: "cost", breakdown: "day", width: 64 }),
      "per",
    );
    expect(lines[0]).toEqual([{ text: "Cost per 8 days", role: "heading" }]);
    expect(textOf(lines[7]).trim()).toMatch(/^Sep 6, 2025 +.+ +Oct 10$/);
  });

  it.each([
    {
      name: "a range of one day",
      report: { ...t3Report(), range: "today" as const, days: t3Report().days.slice(-1) },
    },
    {
      name: "nothing priced",
      report: {
        ...unpricedReport(),
        days: unpricedReport().days.map((day) => ({ ...day, costUsd: 0 })),
      },
    },
  ])("draws no chart for $name", ({ report }) => {
    expect(render(report, { mode: "cost", breakdown: "model", width: 120 }).join("\n")).not.toMatch(
      /Daily cost|[▁▂▃▄▅▆▇]/,
    );
  });

  it("shows the totals as label-over-value cells", () => {
    const lines = from(
      usageView(t3Report(), { mode: "cost", breakdown: "model", width: 110 }),
      "Totals",
    );
    expect(textOf(lines[1]).split(/ {2,}/).filter(Boolean)).toEqual([
      "Processed tokens",
      "Cached input",
      "Uncached input",
      "Output",
      "Cache savings",
    ]);
    expect(lines[2].map((part) => [part.text.trim(), part.role])).toEqual([
      ["13.4B", "value"],
      ["13.2B", "value"],
      ["146M", "value"],
      ["50M", "value"],
      ["$49,636.93", "value"],
    ]);
  });

  it.each([
    {
      mode: "cost" as const,
      title: "Cost by type",
      parts: {
        "part:input": 369.53,
        "part:cacheRead": 2749.39,
        "part:cacheWrite": 1716.2,
        "part:output": 580.29,
      },
      legend: "▒ Input $369.53   ░ Cache read $2,749.39   ▓ Cache write $1,716.20",
    },
    {
      mode: "tokens" as const,
      title: "Tokens by type",
      parts: { "part:cacheRead": 13_200, "part:input": 146, "part:output": 49.97 },
      legend: "░ Cached input 13.2B   ▒ Uncached input 146M   █ Output 50M",
    },
  ])("$title: one bar across the width in proportion, then a legend", ({
    mode,
    title,
    parts,
    legend,
  }) => {
    const lines = from(usageView(t3Report(), { mode, breakdown: "model", width: 80 }), title);
    const bar = lines[1];
    expect(textOf(bar)).toHaveLength(80);
    const total = Object.values(parts).reduce((sum, amount) => sum + amount, 0);
    expect(bar.map((part) => part.role)).toEqual(Object.keys(parts));
    for (const part of bar) {
      const exact = (parts[part.role as keyof typeof parts] / total) * 80;
      // A part above 0 always shows, even when it would round to nothing.
      expect(part.text.length).toBeGreaterThanOrEqual(Math.max(1, Math.floor(exact) - 1));
      expect(part.text.length).toBeLessThanOrEqual(Math.ceil(exact) + 1);
    }
    expect(textOf(lines[2])).toBe(legend);
    expect(lines[2][0].role).toBe(bar[0].role);
  });

  it.each([
    {
      name: "cost by model",
      options: { mode: "cost" as const, breakdown: "model" as const },
      header: /^# {2}Model +Cost {2}Share {2}Tokens$/,
      rows: [
        /^1 {2}● claude-opus-5-5 +\$4,410\.41 {2}81\.4% {3}12\.5B$/,
        /^2 {2}● composer-2 +\$353\.05 {3}6\.5% {4}368M$/,
      ],
    },
    {
      name: "tokens by model",
      options: { mode: "tokens" as const, breakdown: "model" as const },
      header: /^# {2}Model +Tokens {2}Share {7}Cost$/,
      rows: [
        /^1 {2}● claude-opus-5-5 +12\.5B {2}93\.3% {2}\$4,410\.41$/,
        /^2 {2}● composer-2 +368M/,
      ],
    },
    {
      name: "cost by day",
      options: { mode: "cost" as const, breakdown: "day" as const },
      header: /^ # {2}Day +Cost {2}Share {2}Tokens$/,
      rows: [/^ 1 {2}Sat, Oct 10 +\$903\.35 {2}16\.7% {3}2\.48B$/, /^ 2 {2}Fri, Oct 9 /],
    },
  ])("breakdown, $name: right-aligned numbers, the mode's amount first", ({
    options,
    header,
    rows,
  }) => {
    const lines = from(usageView(t3Report(), { ...options, width: 80 }), "Breakdown");
    const texts = lines.map(textOf);
    expect(texts[1]).toMatch(header);
    for (const [index, row] of rows.entries()) expect(texts[index + 2]).toMatch(row);
    for (const text of texts.slice(1)) expect(text).toHaveLength(80);
  });

  it("breakdown by model: provider colors, no price, and the provider for a shared model id", () => {
    const lines = from(
      usageView(t3Report(), { mode: "cost", breakdown: "model", width: 80 }),
      "Breakdown",
    );
    expect(from(lines, "composer-2")[0][1]).toEqual({ text: "● ", role: "provider:1" });
    expect(from(lines, "openai/gpt-6.1")[0][1]).toEqual({ text: "● ", role: "provider:2" });
    expect(from(lines, "opencode/gpt-6.1")[0][1]).toEqual({ text: "● ", role: "provider:3" });
    expect(from(lines, "exo-free")[0]).toContainEqual({ text: "   no price", role: "muted" });
  });

  it("breakdown by day: newest first, used days only, $0.00 for free models, no price for unpriced", () => {
    const lines = from(
      usageView(unpricedReport(), { mode: "cost", breakdown: "day", width: 64 }),
      "Breakdown",
    );
    expect(lines.slice(2).map((line) => textOf(line).replace(/ {2,}/g, " | "))).toEqual([
      "1 | Thu, Oct 8 | no price | 0% | 1M",
      "2 | Wed, Oct 7 | $0.00 | 0% | 1M",
      "3 | Tue, Oct 6 | $1.50 | 100% | 3M",
    ]);
  });

  it.each([
    { name: "no unpriced tokens", report: longReport(), width: 80, note: null },
    {
      name: "a fifth unpriced",
      report: unpricedReport(),
      width: 80,
      note: ["20% of tokens have no price (exo-free); the cost leaves them out."],
    },
    {
      name: "many unpriced models, wrapped",
      report: {
        ...unpricedReport(),
        models: ["a-1", "b-2", "c-3", "d-4", "e-5"].map((modelID) => ({
          ...unpricedReport().models[2],
          modelID,
        })),
      },
      width: 40,
      note: ["20% of tokens have no price (a-1, b-2,", "c-3 +2 more); the cost leaves them out."],
    },
  ])("the unpriced note under the total: $name", ({ report, width, note }) => {
    const lines = usageView(report, { mode: "cost", breakdown: "model", width });
    const warnings = lines.filter((line) => line.some((part) => part.role === "warning"));
    expect(warnings.map(textOf)).toEqual(note ?? []);
    if (note) expect(lines.indexOf(warnings[0])).toBe(1);
  });

  it("says so in one line when the range has no usage", () => {
    expect(usageView(EMPTY_REPORT, { mode: "cost", breakdown: "model", width: 80 })).toEqual([
      [{ text: "No usage in this range.", role: "muted" }],
    ]);
  });
});

describe("usageText", () => {
  it("is plain text of at most 64 columns, with a range title, no chart and 10 breakdown rows", () => {
    const text = usageText(t3Report(), { mode: "cost", breakdown: "day", width: 200 });
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "Usage · last 30 days",
      "$5,415.41  636 sessions · API estimate",
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(64);
    expect(text).not.toMatch(/Daily cost|[▁▂▃▄▅▆▇]/);
    expect(text).toContain("▒ Input $369.53   ░ Cache read $2,749.39");
    expect(lines.filter((line) => /^ ?\d+ {2}\w{3}, /.test(line))).toHaveLength(10);
    expect(lines.at(-1)).toBe("and 18 more");
  });

  it.each([
    { report: { ...EMPTY_REPORT, range: "session" as const }, title: "Usage · this session" },
    {
      report: {
        ...EMPTY_REPORT,
        range: "between" as const,
        sinceMs: new Date(2025, 11, 20).getTime(),
        untilMs: new Date(2026, 0, 5, 23, 59).getTime(),
      },
      title: "Usage · Dec 20, 2025 to Jan 5",
    },
  ])("titles the range: $title", ({ report, title }) => {
    expect(usageText(report, { mode: "tokens", breakdown: "model" })).toBe(
      `${title}\nNo usage in this range.`,
    );
  });
});
