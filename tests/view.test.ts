import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot, Words } from "../src/core/types.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import {
  amountText,
  barParts,
  DEFAULT_WORDS,
  fit as fitToWidth,
  formatDuration,
  levelOf,
  percentText,
  rowValueText,
} from "../src/view/format.js";
import { pickRow, type RowSettings, visibleGroups } from "../src/view/select.js";
import {
  bigStatusLine,
  collapsedLines,
  collapsedTitle,
  lineText,
  plainLines,
  type StatusInput,
  sidebarLines,
  statusLayout,
} from "../src/view/text.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

/** A provider whose rows were fetched and checked at NOW. */
const provider = (
  providerId: string,
  label: string,
  rows: QuotaRow[],
  extra: Partial<ProviderSnapshot> = {},
) => providerSnapshot(providerId, label, rows, { okAtMs: NOW, checkedAtMs: NOW, ...extra });

const CLAUDE = provider("anthropic", "Claude", [
  row("anthropic.five_hour", {
    label: "5h",
    window: "five_hour",
    percentRemaining: 58,
    resetsAt: at(134 * MINUTE),
  }),
  row("anthropic.weekly", {
    label: "Weekly",
    window: "week",
    percentRemaining: 12,
    resetsAt: at((3 * 24 * 60 + 4 * 60) * MINUTE),
  }),
  row("anthropic.weekly_fable", {
    label: "Fable",
    window: "week",
    percentRemaining: 90,
    prominence: "supplementary",
  }),
]);
const ZEN = provider("opencode", "OpenCode Zen", [
  row("opencode.balance", {
    label: "Balance",
    type: "balance",
    amount: { decimal: "1240.5", unit: { kind: "currency", code: "USD" } },
  }),
]);
const ROUTER = provider("openrouter", "OpenRouter", [], { error: { code: "login_expired" } });
/** Two accounts whose last check timed out, so both keep their rows from before. */
const TWO_ACCOUNTS = provider(
  "copilot",
  "Copilot",
  [
    row("copilot.allowance", {
      account: "work",
      label: "Plan",
      window: "month",
      percentRemaining: 40,
    }),
    row("copilot.allowance", {
      account: "home",
      label: "Plan",
      window: "month",
      percentRemaining: 90,
    }),
  ],
  { error: { code: "timeout" } },
);

function snapshot(providers: ProviderSnapshot[], extra: Partial<QuotaSnapshot> = {}) {
  return { version: 6, providers, resetNotices: [], generatedAtMs: NOW, ...extra } as const;
}

function settings(change: (settings: RowSettings) => void = () => {}): RowSettings {
  const display = defaultDisplaySettings();
  change(display);
  return display;
}

const words = (change: Partial<Words> = {}): Words => ({ ...DEFAULT_WORDS, ...change });

describe("view format", () => {
  it.each([
    { percent: "left", value: 58, withWord: true, expected: "58% left" },
    { percent: "remaining", value: 58, withWord: true, expected: "58% remaining" },
    { percent: "bare", value: 58, withWord: true, expected: "58%" },
    { percent: "used", value: 58, withWord: true, expected: "42% used" },
    { percent: "left", value: 58, withWord: false, expected: "58%" },
    { percent: "left", value: -12, withWord: true, expected: "0% left" },
    { percent: "used", value: 140, withWord: true, expected: "0% used" },
  ] as const)("percent $percent of $value is $expected", ({
    percent,
    value,
    withWord,
    expected,
  }) => {
    expect(percentText(words({ percent }), value, withWord)).toBe(expected);
  });

  it.each([
    { ms: 134 * MINUTE, style: "exact", expected: "2h 14m" },
    { ms: 134 * MINUTE, style: "compact", expected: "2h14m" },
    { ms: 134 * MINUTE, style: "short", expected: "2h" },
    { ms: 134 * MINUTE, style: "decimal", expected: "2.2h" },
    { ms: (2 * 1440 + 5) * MINUTE, style: "exact", expected: "2d 5m" },
    { ms: (2 * 1440 + 65) * MINUTE, style: "short", expected: "2d 1h" },
    { ms: 3 * 1440 * MINUTE, style: "decimal", expected: "3.0d" },
    { ms: 30_000, style: "exact", expected: "1m" },
    { ms: 0, style: "exact", expected: "now" },
    { ms: -MINUTE, style: "compact", expected: "now" },
  ] as const)("$ms ms in the $style style is $expected", ({ ms, style, expected }) => {
    expect(formatDuration(ms, style, 1)).toBe(expected);
  });

  it.each([
    { shape: "blocks", percent: 50, width: 8, expected: ["████", "░░░░"] },
    { shape: "dots", percent: 81, width: 5, expected: ["●●●●", "○"] },
    { shape: "line", percent: -5, width: 4, expected: ["", "────"] },
    { shape: "none", percent: 50, width: 8, expected: ["", ""] },
  ] as const)("a $shape bar at $percent%", ({ shape, percent, width, expected }) => {
    expect(barParts(shape, percent, width)).toEqual(expected);
  });

  it.each([
    { percent: 50, expected: "good" },
    { percent: 49, expected: "warning" },
    { percent: 19.6, expected: "warning" },
    { percent: 19, expected: "low" },
    { percent: -3, expected: "low" },
  ] as const)("$percent% left is $expected", ({ percent, expected }) => {
    expect(levelOf(percent, { warningBelow: 50, lowBelow: 20 })).toBe(expected);
  });

  it.each([
    {
      name: "dollars",
      value: row("x.a", {
        amount: { decimal: "1240.5", unit: { kind: "currency", code: "USD" } },
        type: "balance",
      }),
      expected: "$1,240.50 left",
    },
    {
      name: "euros used",
      value: row("x.a", {
        amount: { decimal: "-3", unit: { kind: "currency", code: "EUR" } },
        type: "usage",
      }),
      expected: "-3.00 EUR used",
    },
    {
      name: "a count",
      value: row("x.a", {
        remaining: { decimal: "1200", unit: { kind: "count", unit: "request" } },
      }),
      expected: "1,200 requests left",
    },
    {
      name: "used of a limit",
      value: row("x.a", {
        used: { decimal: "26", unit: { kind: "count", unit: "unit" } },
        limit: { decimal: "100", unit: { kind: "count", unit: "unit" } },
      }),
      expected: "26/100",
    },
    {
      name: "a custom unit",
      value: row("x.a", { amount: { decimal: "30.25", unit: { kind: "custom", symbol: "nano" } } }),
      expected: "30.25 nano",
    },
    { name: "a flag", value: row("x.a", { type: "status", flag: false }), expected: "Disabled" },
    { name: "a text", value: row("x.a", { text: "Unlimited" }), expected: "Unlimited" },
  ])("the value of $name", ({ value, expected }) => {
    expect(rowValueText(value)).toBe(expected);
  });

  it.each([
    { text: "Claude", width: 9, expected: "Claude   " },
    { text: "OpenRouter", width: 9, expected: "OpenRout…" },
    { text: "Copilot (pro)", width: 9, expected: "Copilot… " },
    // Wide characters take two columns; a letter with its accent is never split.
    { text: "日本語プロバイダ", width: 9, expected: "日本語プ…" },
    { text: "日本語", width: 7, expected: "日本語 " },
    { text: "e\u0301e\u0301e\u0301e\u0301", width: 3, expected: "e\u0301e\u0301…" },
  ])("fits $text in $width columns", ({ text, width, expected }) => {
    expect(fitToWidth(text, width)).toBe(expected);
  });

  it("shows exact amounts without float noise", () => {
    expect(amountText({ decimal: "0.1", unit: { kind: "count", unit: "unit" } })).toBe("0.1");
  });

  it.each([
    { decimal: "0", expected: "0 tokens used" },
    { decimal: "1", expected: "1 token used" },
    { decimal: "1.5", expected: "1.5 tokens used" },
    { decimal: "12345", expected: "12,345 tokens used" },
    { decimal: "-1", expected: "-1 token used" },
  ])("names a count of $decimal in the plural unless it is one", ({ decimal, expected }) => {
    const used = row("x.a", {
      type: "usage",
      amount: { decimal, unit: { kind: "count", unit: "token" } },
    });
    expect(rowValueText(used)).toBe(expected);
  });
});

describe("view select", () => {
  const all = snapshot([CLAUDE, ZEN, ROUTER]);
  const ids = (groups: ReturnType<typeof visibleGroups>) =>
    groups.map((group) => [group.title, group.rows.map((item) => item.label)]);

  it.each([
    {
      name: "the snapshot's order, primary rows only",
      settings: settings(),
      words: words(),
      expected: [
        ["Claude", ["5h", "Weekly"]],
        ["OpenCode Zen", ["Balance"]],
        ["OpenRouter", []],
      ],
    },
    {
      name: "supplementary rows in the detailed words",
      settings: settings(),
      words: words({ detail: "detailed" }),
      expected: [
        ["Claude", ["5h", "Weekly", "Fable"]],
        ["OpenCode Zen", ["Balance"]],
        ["OpenRouter", []],
      ],
    },
    {
      name: "your order, names and hidden ids",
      settings: settings((value) => {
        value.surfaces.sidebar.providerOrder = ["openrouter"];
        value.surfaces.sidebar.rowOrder = { anthropic: ["anthropic.weekly"] };
        value.surfaces.sidebar.hidden = ["opencode", "anthropic.five_hour"];
        value.labels = { "anthropic.weekly": "Week" };
      }),
      words: words(),
      expected: [
        ["OpenRouter", []],
        ["Claude", ["Week"]],
      ],
    },
    {
      name: "a provider whose every row is hidden, unless it has an error",
      settings: settings((value) => {
        value.surfaces.sidebar.hidden = [
          "opencode.balance",
          "anthropic.five_hour",
          "anthropic.weekly",
        ];
      }),
      words: words(),
      expected: [["OpenRouter", []]],
    },
  ])("$name", ({ settings: rowSettings, words: rowWords, expected }) => {
    expect(ids(visibleGroups(all, rowSettings, "sidebar", rowWords))).toEqual(expected);
  });

  it("shows only the providers of the current model when the words say so", () => {
    const current = snapshot([CLAUDE, ZEN], { currentModelProviderIds: ["opencode"] });
    expect(
      ids(visibleGroups(current, settings(), "toast", words({ onlyCurrentModel: true }))),
    ).toEqual([["OpenCode Zen", ["Balance"]]]);
  });

  it("makes one group per account, in the order the accounts appear", () => {
    const copilot = provider("copilot", "Copilot", [
      row("copilot.allowance", { account: "work", label: "Plan", percentRemaining: 40 }),
      row("copilot.allowance", { account: "home", label: "Plan", percentRemaining: 90 }),
    ]);
    const groups = visibleGroups(snapshot([copilot]), settings(), "sidebar", words());
    expect(groups.map((group) => [group.id, group.title])).toEqual([
      ["copilot (work)", "Copilot (work)"],
      ["copilot (home)", "Copilot (home)"],
    ]);
  });

  it("shows the error of a provider with several accounts once, on its first account", () => {
    const groups = visibleGroups(snapshot([TWO_ACCOUNTS]), settings(), "sidebar", words());
    expect(groups.map((group) => [group.title, group.rows.length, group.error?.code])).toEqual([
      ["Copilot (work)", 1, "timeout"],
      ["Copilot (home)", 1, undefined],
    ]);
    expect(collapsedTitle(groups)).toBe("▶ Quota (1 provider, 1 error)");
  });

  it.each([
    { choice: undefined, expected: "Weekly" },
    { choice: "five_hour", expected: "5h" },
    { choice: "month", expected: "Weekly" },
  ] as const)("picks $expected for the $choice window", ({ choice, expected }) => {
    const [claude] = visibleGroups(all, settings(), "collapsed", words());
    expect(pickRow(claude!, choice)?.label).toBe(expected);
  });
});

describe("view text", () => {
  const display = defaultDisplaySettings();
  const groups = (
    surface: "sidebar" | "collapsed" | "statusLine" | "toast",
    providers = [CLAUDE, ZEN, ROUTER],
  ) => visibleGroups(snapshot(providers), display, surface, DEFAULT_WORDS);
  /** What every drawing takes besides its groups. */
  const drawn = { layout: display.layout, words: DEFAULT_WORDS, nowMs: NOW };
  const statusInput = (providers = [CLAUDE, ZEN, ROUTER]): StatusInput => ({
    groups: groups("statusLine", providers),
    ...drawn,
    window: {},
  });

  it("draws the expanded sidebar with bars, percents, reset times and session tokens", () => {
    const lines = sidebarLines({
      groups: groups("sidebar"),
      ...drawn,
      width: 40,
      sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 },
    });
    expect(lines.map(lineText)).toEqual([
      "Claude",
      " 5h       █████░░░  58% left 2h 14m",
      " Weekly   █░░░░░░░  12% left  3d 4h",
      "OpenCode Zen",
      " Balance  $1,240.50 left",
      "OpenRouter  Sign in again",
      "Session  12.3K in · 2.10K out",
    ]);
    // The bar of the row with 12% left is drawn in the "low" level color.
    const weekly = lines.find((line) => line.id === "anthropic.weekly");
    expect(weekly?.segments.find((segment) => segment.role === "bar")).toMatchObject({
      percent: 12,
    });
  });

  it("shortens the bar, then drops it and the percent word, when the sidebar is narrow", () => {
    const line = (width: number) =>
      lineText(sidebarLines({ groups: groups("sidebar", [CLAUDE]), ...drawn, width })[1]!);
    expect([line(40), line(30), line(22)]).toEqual([
      " 5h       █████░░░  58% left 2h 14m",
      " 5h       ██░  58% left 2h 14m",
      " 5h         58% 2h 14m",
    ]);
  });

  it.each([
    { providers: [CLAUDE], expected: "▶ Quota (1 provider)" },
    { providers: [CLAUDE, ZEN, ROUTER], expected: "▶ Quota (3 providers, 1 error)" },
  ])("titles the collapsed panel $expected", ({ providers, expected }) => {
    expect(collapsedTitle(groups("collapsed", providers))).toBe(expected);
  });

  it("draws one collapsed line per provider with its preferred window", () => {
    const lines = collapsedLines({
      groups: groups("collapsed"),
      ...drawn,
      width: 40,
      window: { anthropic: "five_hour" },
    });
    expect(lines.map(lineText)).toEqual([
      "Claude    5h   █████░░░  58%  2h 14m",
      "OpenCode… $1,240.50 left",
      "OpenRout… Sign in again",
    ]);
  });

  it("shows the error next to the rows kept from before, collapsed and on the status line", () => {
    const expired = { ...CLAUDE, error: { code: "login_expired" } } as const;
    const collapsed = collapsedLines({
      groups: groups("collapsed", [expired]),
      ...drawn,
      width: 50,
      window: {},
    });
    expect(collapsed.map(lineText)).toEqual(["Claude    7d   █░░░░░░░  12%  Sign in again"]);
    const status = statusInput([expired]);
    expect(
      ["full", "numbers"].map((level) =>
        lineText(statusLayout(status, 200, 0, level as "full").shown[0]!),
      ),
    ).toEqual(["Claude █░░░░ 12% Sign in again", "Claude 12% ⚠"]);
    expect(lineText(bigStatusLine(status)!)).toBe("Claude 7d █░░░░░░░░░ 12% left · Sign in again");
  });

  it("shows the error of a provider with several accounts on the big bar and the status line", () => {
    const input = statusInput([TWO_ACCOUNTS]);
    expect(lineText(bigStatusLine(input)!)).toBe(
      "Copilot (work) 30d ████░░░░░░ 40% left · Timed out",
    );
    expect(statusLayout(input, 30, 0, "auto").shown.map(lineText)).toEqual([
      "Copilot (work) 40% ⚠",
    ]);
    // Cut short, the line keeps the error's mark.
    expect(statusLayout(input, 9, 0, "auto").shown.map(lineText)).toEqual(["C… ⚠"]);
  });

  it("cuts the big bar to the status line's room, keeping the error's mark", () => {
    const expired = statusInput([{ ...CLAUDE, error: { code: "login_expired" } }]);
    expect([40, 30].map((width) => lineText(bigStatusLine(expired, width)!))).toEqual([
      "Claude 7d █░░░░░░░░░ 12% left · Sign in…",
      "Claude 7d █░░░░░░░░░ 12% le… ⚠",
    ]);
    expect(lineText(bigStatusLine(statusInput([ROUTER]), 8)!)).toBe("OpenR… ⚠");
  });

  it("cuts the first provider short when it does not fit, so the arrows stay", () => {
    const layout = statusLayout(statusInput(), 14, 0, "auto");
    expect([layout.shown.map(lineText), layout.hiddenAfter]).toEqual([["Clau… 12%"], 2]);
  });

  it("measures the status line in terminal columns", () => {
    const wide = provider("kimi", "月之暗面", [
      row("kimi.week", { window: "week", percentRemaining: 70 }),
    ]);
    const layout = statusLayout(statusInput([wide, CLAUDE]), 24, 0, "numbers");
    expect([layout.shown.map(lineText), layout.hiddenAfter]).toEqual([["月之暗面 70%"], 1]);
  });

  it.each([
    { room: 200, level: "full", first: "Claude █░░░░ 12% 3d 4h", shown: 3 },
    { room: 75, level: "bar", first: "Claude █░░░░ 12%", shown: 3 },
    { room: 70, level: "numbers", first: "Claude 12%", shown: 3 },
    { room: 40, level: "numbers", first: "Claude 12%", shown: 1 },
  ])("fits the status line in $room columns at the $level level", ({
    room,
    level,
    first,
    shown,
  }) => {
    const layout = statusLayout(statusInput(), room, 0, "auto");
    expect(layout.level).toBe(level);
    expect(layout.shown.map(lineText)[0]).toBe(first);
    // Every provider shows its least-left row; the rest wait behind "+N ›".
    expect([layout.shown.length, layout.hiddenAfter]).toEqual([shown, 3 - shown]);
  });

  it("scrolls the status line, keeping room for the markers", () => {
    const layout = statusLayout(statusInput(), 40, 1, "auto");
    expect([layout.start, layout.shown.map(lineText), layout.hiddenAfter]).toEqual([
      1,
      ["OpenCode Zen $1,240.50 left"],
      1,
    ]);
  });

  it("names a provider's account on the status line only when it shows several", () => {
    const copilot = (account: string, percentRemaining: number) =>
      row("copilot.allowance", { account, label: "Plan", percentRemaining });
    const segments = (rows: QuotaRow[]) =>
      statusLayout(statusInput([provider("copilot", "Copilot", rows)]), 200, 0, "auto").shown.map(
        lineText,
      );
    expect(segments([copilot("work", 40)])).toEqual(["Copilot ██░░░ 40%"]);
    expect(segments([copilot("work", 40), copilot("home", 90)])).toEqual([
      "Copilot (work) ██░░░ 40%",
      "Copilot (home) █████ 90%",
    ]);
  });

  it("draws the one-provider status line with a big bar", () => {
    expect(lineText(bigStatusLine(statusInput())!)).toBe("Claude 7d █░░░░░░░░░ 12% left · 3d 4h");
    // Without a percent row it shows the error (or value) instead of a bar.
    expect(lineText(bigStatusLine(statusInput([ROUTER]))!)).toBe("OpenRouter Sign in again");
    expect(bigStatusLine(statusInput([]))).toBeUndefined();
  });

  it("adds runs out in each place only where it is on, for a limit used faster than it refills", () => {
    // The weekly limit has 12% left with 45% of its week still to come; the 5h one has spare.
    const base = { layout: display.layout, words: DEFAULT_WORDS, nowMs: NOW, window: {} };
    const sidebar = (runsOut: boolean) =>
      sidebarLines({ ...base, groups: groups("sidebar", [CLAUDE]), width: 40, runsOut });
    const status = { ...statusInput([CLAUDE]), runsOut: true };
    expect({
      sidebar: sidebar(true).map(lineText),
      off: sidebar(false).length,
      collapsed: collapsedLines({
        ...base,
        groups: groups("collapsed", [CLAUDE]),
        width: 40,
        runsOut: true,
      }).map(lineText),
      status: lineText(statusLayout(status, 200, 0, "full").shown[0]!),
      big: lineText(bigStatusLine(status)!),
      plain: plainLines({ ...base, groups: groups("toast", [CLAUDE]), runsOut: true }),
    }).toEqual({
      sidebar: [
        "Claude",
        " 5h       █████░░░  58% left 2h 14m",
        " Weekly   █░░░░░░░  12% left  3d 4h",
        "          runs out in 12h 33m",
      ],
      off: 3,
      collapsed: ["Claude    7d   █░░░░░░░  12%   3d 4h", "          runs out in 12h 33m"],
      status: "Claude █░░░░ 12% 3d 4h (runs out in 12h 33m)",
      big: "Claude 7d █░░░░░░░░░ 12% left · 3d 4h · runs out in 12h 33m",
      plain: [
        "Claude 5h           58% left      2h 14m",
        "Claude Weekly       12% left      3d 4h  runs out in 12h 33m",
      ],
    });
  });

  it("writes plain lines for toasts and the CLI, errors and session tokens last", () => {
    expect(
      plainLines({
        groups: groups("toast"),
        words: DEFAULT_WORDS,
        nowMs: NOW,
        sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 },
      }),
    ).toEqual([
      "Claude 5h           58% left      2h 14m",
      "Claude Weekly       12% left      3d 4h",
      "OpenCode Zen Balan… $1,240.50 left",
      "OpenRouter          Sign in again",
      "Session  12.3K in · 2.10K out",
    ]);
  });
});
