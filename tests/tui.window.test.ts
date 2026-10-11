import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import { limitsLines } from "../src/tui/window/limits.js";
import { hintLines, tabStrip } from "../src/tui/window/shell.tsx";
import { usageControls } from "../src/tui/window/usage.tsx";
import {
  type NoticeBoard,
  noticeItems,
  noticeOptions,
  statusLines,
} from "../src/tui/window/views.tsx";
import { lineText } from "../src/view/text.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
/** Wide enough for every column on one line. */
const WIDE = 110;
function row(id: string, fields: Partial<QuotaRow> = {}): QuotaRow {
  const [providerId = "", key = ""] = id.split(".");
  return {
    id,
    providerId,
    label: key,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...fields,
  };
}

function provider(providerId: string, label: string, rows: QuotaRow[], extra = {}) {
  return {
    providerId,
    label,
    rows,
    okAtMs: NOW,
    checkedAtMs: NOW,
    refreshing: false,
    debug: [],
    ...extra,
  } satisfies ProviderSnapshot;
}

/** Half of the 5-hour window has passed, so even use would leave 50%. */
const FIVE_HOUR = row("anthropic.five_hour", {
  label: "5h",
  window: "five_hour",
  percentRemaining: 30,
  resetsAt: at(150),
});
const CLAUDE = provider("anthropic", "Claude", [
  FIVE_HOUR,
  row("anthropic.weekly_fable", {
    label: "Fable",
    percentRemaining: 90,
    prominence: "supplementary",
  }),
]);

function limitLines(providers: ProviderSnapshot[], width = WIDE, hidden: string[] = []) {
  const display = defaultDisplaySettings();
  display.surfaces.sidebar.hidden = hidden;
  const snapshot: QuotaSnapshot = { version: 6, providers, resetNotices: [], generatedAtMs: NOW };
  return limitsLines({ snapshot, display, nowMs: NOW, width });
}

function limits(providers: ProviderSnapshot[], width = WIDE, hidden: string[] = []) {
  return limitLines(providers, width, hidden).map(lineText);
}

const ZEN = provider("opencode", "OpenCode Zen", [
  row("opencode.balance", {
    label: "Balance",
    type: "balance",
    amount: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
  }),
]);

/** Where the label column ends and the bar starts: 2 + the widest label ("Balance") + 2. */
const BAR_COLUMN = 2 + "Balance".length + 2;

describe("quota window: Limits", () => {
  it("shows every row, hidden and supplementary ones too, with reset and pace", () => {
    const lines = limits([CLAUDE], WIDE, ["anthropic.five_hour"]);
    expect(lines[0]).toMatch(/^Claude +checked just now$/u);
    expect(lines[1]).toMatch(
      /^ {2}5h +[━─┃]+ {2}30% left {3}resets in 2h 30m {3}runs out in 1h 5m$/u,
    );
    expect(lines[2]).toMatch(/^ {2}Fable +[━─]+ {2}90% left$/u);
  });

  it("lines every provider up in one grid, its right edge where the checked times end", () => {
    const lines = limits([CLAUDE, ZEN]);
    const [claude, fiveHour, fable, gap, zen, balance] = lines;
    expect(gap).toBe("");
    // The bars start in one column, the percents and the balance end in one column.
    expect(fiveHour.indexOf("━")).toBe(BAR_COLUMN);
    expect(fable.indexOf("━")).toBe(BAR_COLUMN);
    const percentEnd = fiveHour.indexOf("30% left") + "30% left".length;
    expect(fable.length).toBe(percentEnd);
    expect(balance).toBe(
      `  Balance${" ".repeat(percentEnd - "  Balance".length - "$12.50 left".length)}$12.50 left`,
    );
    // The grid fills the window, and "checked …" ends at its right edge.
    expect(fiveHour.length).toBe(WIDE);
    expect(claude.length).toBe(WIDE);
    expect(zen).toMatch(/^OpenCode Zen +checked just now$/u);
    expect(zen.length).toBe(WIDE);
  });

  it("draws a thin bar in the level color with the even-use marker where even use would be", () => {
    const fiveHour = limitLines([CLAUDE])[1];
    const bar = fiveHour.segments.filter((segment) => /^[━─┃]+$/u.test(segment.text));
    expect(bar.map((segment) => segment.role)).toEqual(["bar", "empty", "label", "empty"]);
    const cells = bar.map((segment) => segment.text).join("");
    // 30% left; half of the 5-hour window has passed, so even use would leave 50%.
    expect(cells.indexOf("┃")).toBe(Math.round(cells.length / 2));
    expect(bar[0].text).toHaveLength(Math.round(cells.length * 0.3));
  });

  it.each([
    { width: 90, cells: 32 },
    { width: 110, cells: 52 },
    { width: 300, cells: 80 },
  ])("gives the bar the room the other columns leave, at most 80 cells ($width wide)", ({
    width,
    cells,
  }) => {
    const fable = limits([CLAUDE], width).find((line) => line.includes("Fable"));
    expect(fable?.match(/[━─]+/u)?.[0]).toHaveLength(cells);
  });

  it("shortens the reset to its first unit before the bar gets too short (80 columns)", () => {
    // 80 columns leave 72 inside the window: the session's padding, the border and the padding.
    const lines = limits([CLAUDE], 72);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(72);
    expect(lines[1]).toMatch(/^ {2}5h +[━─┃]+ {2}30% left {3}2h {3}runs out in 1h 5m$/u);
  });

  it("puts the reset and the pace under the bar when they leave it no room", () => {
    const lines = limits([CLAUDE], 50);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
    expect(lines.slice(1, 4)).toEqual([
      expect.stringMatching(/^ {2}5h +[━─┃]+ {2}30% left$/u),
      `${" ".repeat(2 + "Fable".length + 2)}resets in 2h 30m · runs out in 1h 5m`,
      expect.stringMatching(/^ {2}Fable +[━─]+ {2}90% left$/u),
    ]);
  });

  it("puts the pace on a line of its own when it doesn't fit after the reset", () => {
    const lines = limits([CLAUDE], 40);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines.slice(2, 4)).toEqual([
      `${" ".repeat(9)}resets in 2h 30m`,
      `${" ".repeat(9)}runs out in 1h 5m`,
    ]);
  });

  it.each([
    24, 30, 36, 44, 56, 64, 72, 80, 96, 120, 160, 240,
  ])("keeps every line inside a window %i wide", (width) => {
    const long = provider("copilot", "Copilot", [
      row("copilot.premium", {
        label: "Premium interactions",
        window: "month",
        percentRemaining: 80,
        resetsAt: at(30_000),
      }),
    ]);
    for (const line of limits([CLAUDE, ZEN, long], width)) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it.each([
    { extra: { refreshing: true }, state: /^Claude +checking…$/u },
    {
      extra: { checkedAtMs: undefined, okAtMs: undefined },
      state: /^Claude +not checked yet$/u,
    },
    { extra: { checkedAtMs: NOW - 5 * MINUTE }, state: /^Claude +checked 5m ago$/u },
  ])("says when the provider was checked", ({ extra, state }) => {
    expect(limits([provider("anthropic", "Claude", [FIVE_HOUR], extra)])[0]).toMatch(state);
  });

  it("puts a provider's error on its own line under its name", () => {
    const failed = provider("anthropic", "Claude", [], { error: { code: "login_expired" } });
    const lines = limitLines([failed]);
    expect(lines.map(lineText)).toEqual([
      expect.stringMatching(/^Claude +checked just now$/u),
      "  Sign in again",
    ]);
    expect(lines[1].segments[0].role).toBe("error");
  });

  it("lines balances up at their right ends when no row has a bar", () => {
    const lines = limits([ZEN]);
    expect(lines).toEqual([
      expect.stringMatching(/^OpenCode Zen +checked just now$/u),
      "  Balance  $12.50 left",
    ]);
  });

  it("says where to look when no provider is found", () => {
    expect(limits([])).toEqual(["No quota providers found. The Status tab says why."]);
  });
});

const BOARD: NoticeBoard = {
  enabled: true,
  home: true,
  notices: [
    { id: "a", message: "Copilot moves to AI Credits.", url: "https://example.com/a", read: false },
    { id: "b", message: "v6 is out.", read: true },
  ],
};

describe("quota window: Notices", () => {
  it("offers the switches and mark all read with the unread count", () => {
    expect(noticeOptions(BOARD).map(({ title, value }) => `${title}: ${value}`)).toEqual([
      "Maintainer notices: on",
      "Count on the Home screen: on",
      "Mark all as read: 1 unread",
    ]);
  });

  it("marks unread notices and says what a click does", () => {
    expect(noticeItems(BOARD).items.map(({ mark, action }) => `${mark} ${action}`)).toEqual([
      "● click: mark read",
      "○ read (click: unread)",
    ]);
  });

  it("says why there is no notice", () => {
    const off = { ...BOARD, enabled: false, notices: [] };
    expect(noticeOptions(off).map(({ id }) => id)).toEqual(["enabled", "home"]);
    expect(noticeItems(off).empty).toMatch(/Notices are off/u);
    expect(noticeItems({ ...BOARD, notices: [] }).empty).toBe("No notices right now.");
  });
});

describe("quota window: Status", () => {
  it("makes the title and section titles headings", () => {
    const text = "# Quota Status (opencode-quota)\n\nproviders:\n- copilot: ok\n  detail:";
    expect(
      statusLines(text)
        .filter((line) => line.heading)
        .map((line) => line.text),
    ).toEqual(["# Quota Status (opencode-quota)", "providers:"]);
  });
});

describe("quota window: tab bar", () => {
  const TITLES = ["Usage", "Limits", "Notices", "Status", "Sidebar", "Collapsed", "Status line"];
  /** The view tabs, then the Settings tabs from "Sidebar" on. */
  const SETTINGS_FROM = 4;
  // 5+6+7+6+7+9+11 titles, 6 gaps of 2, "Settings" and its gap.
  const FULL = 51 + 12 + 10;

  it("shows every tab and the Settings label when they fit", () => {
    expect(tabStrip(TITLES, SETTINGS_FROM, 0, FULL)).toEqual({
      first: 0,
      last: 6,
      settingsLabel: true,
    });
  });

  it("drops the Settings label (a │ stays) before it hides a tab", () => {
    expect(tabStrip(TITLES, SETTINGS_FROM, 0, FULL - 1)).toEqual({
      first: 0,
      last: 6,
      settingsLabel: false,
    });
  });

  it.each([
    0, 3, 4, 6,
  ])("shows the tabs around tab %i between ‹ and › when they don't fit", (active) => {
    const room = 40;
    const strip = tabStrip(TITLES, SETTINGS_FROM, active, room);
    expect(strip.settingsLabel).toBe(false);
    expect(strip.first).toBeLessThanOrEqual(active);
    expect(strip.last).toBeGreaterThanOrEqual(active);
    let width = 0;
    for (let index = strip.first; index <= strip.last; index += 1) {
      width += TITLES[index].length + (index > strip.first ? 2 : 0);
    }
    if (strip.first < SETTINGS_FROM && strip.last >= SETTINGS_FROM) width += 3;
    width += (strip.first > 0 ? 3 : 0) + (strip.last < TITLES.length - 1 ? 3 : 0);
    expect(width).toBeLessThanOrEqual(room);
    // One more tab on either side would not fit.
    expect(width + 3 + 7).toBeGreaterThan(room);
  });
});

describe("quota window: Usage top line", () => {
  it.each([
    { width: 140, expected: { allRanges: true, prices: true } },
    { width: 119, expected: { allRanges: true, prices: false } },
    { width: 100, expected: { allRanges: false, prices: true } },
    { width: 40, expected: { allRanges: false, prices: false } },
  ])("at $width columns: $expected", ({ width, expected }) => {
    expect(usageControls(width)).toEqual(expected);
  });
});

describe("quota window: keyboard hint", () => {
  it("breaks its lines between items, never inside one", () => {
    expect(hintLines("↑↓ select · tab next tab · esc close", 24)).toBe(
      "↑↓ select · tab next tab\nesc close",
    );
    expect(hintLines("↑↓ select · tab next tab · esc close", 23)).toBe(
      "↑↓ select\ntab next tab\nesc close",
    );
  });

  it("keeps one line when it fits", () => {
    expect(hintLines("tab next tab · esc close", 80)).toBe("tab next tab · esc close");
  });
});
