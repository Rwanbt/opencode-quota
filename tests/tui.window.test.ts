import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import { limitsLines } from "../src/tui/window/limits.js";
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
/** Columns that leave a 20-cell bar after the label, percent, reset and pace columns. */
const WIDTH_FOR_BAR_20 = 110;

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

function limits(providers: ProviderSnapshot[], width = WIDTH_FOR_BAR_20, hidden: string[] = []) {
  const display = defaultDisplaySettings();
  display.surfaces.sidebar.hidden = hidden;
  const snapshot: QuotaSnapshot = { version: 6, providers, resetNotices: [], generatedAtMs: NOW };
  return limitsLines({ snapshot, display, nowMs: NOW, width }).map(lineText);
}

describe("quota window: Limits", () => {
  it("shows every row, hidden and supplementary ones too, with reset and pace", () => {
    const lines = limits([CLAUDE], WIDTH_FOR_BAR_20, ["anthropic.five_hour"]);
    expect(lines[0]).toBe(" Claude   checked just now");
    expect(lines[1]).toMatch(
      /^ {3}5h +[█░│]{20} {2}30% left +resets in 2h 30m +runs out in 1h 5m$/u,
    );
    expect(lines[2]).toMatch(/^ {3}Fable +[█░]{20} {2}90% left *$/u);
  });

  it("puts the even-use marker where even use would be", () => {
    const bar = limits([CLAUDE])[1]?.slice(3 + 16 + 1, 3 + 16 + 1 + 20);
    expect(bar).toBe(`${"█".repeat(6)}░░░░│${"░".repeat(9)}`);
  });

  it.each([
    { width: 40, cells: 8 },
    { width: 300, cells: 30 },
  ])("keeps the bar between 8 and 30 cells (window $width wide)", ({ width, cells }) => {
    const fable = limits([CLAUDE], width).find((line) => line.includes("Fable"));
    expect(fable?.match(/[█░]+/u)?.[0]).toHaveLength(cells);
  });

  it("puts the reset and the pace under the bar in an 80-column terminal", () => {
    // 80 columns leave 72 inside the window: the session's padding, the border and the padding.
    const lines = limits([CLAUDE], 72);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(72);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^ {3}5h +[█░│]{30} {2}30% left$/u),
      `${" ".repeat(20)}resets in 2h 30m · runs out in 1h 5m`,
      expect.stringMatching(/^ {3}Fable +[█░]{30} {2}90% left$/u),
    ]);
  });

  it("puts the pace on a line of its own when it doesn't fit after the reset", () => {
    const lines = limits([CLAUDE], 50);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
    expect(lines.slice(2, 4)).toEqual([
      `${" ".repeat(20)}resets in 2h 30m`,
      `${" ".repeat(20)}runs out in 1h 5m`,
    ]);
  });

  it.each([
    { extra: { error: { code: "login_expired" } }, state: /^ Claude {3}Sign in again$/u },
    { extra: { refreshing: true }, state: /^ Claude {3}checking…$/u },
    {
      extra: { checkedAtMs: undefined, okAtMs: undefined },
      state: /^ Claude {3}not checked yet$/u,
    },
    { extra: { checkedAtMs: NOW - 5 * MINUTE }, state: /^ Claude {3}checked 5m ago$/u },
  ])("says how the provider's check went", ({ extra, state }) => {
    expect(limits([provider("anthropic", "Claude", [FIVE_HOUR], extra)])[0]).toMatch(state);
  });

  it("shows a value row as its value, after a blank line between providers", () => {
    const zen = provider("opencode", "OpenCode Zen", [
      row("opencode.balance", {
        label: "Balance",
        type: "balance",
        amount: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
      }),
    ]);
    const lines = limits([CLAUDE, zen]);
    expect(lines.slice(3)).toEqual([
      "",
      " OpenCode Zen   checked just now",
      "   Balance          $12.50 left",
    ]);
  });

  it("says where to look when no provider is found", () => {
    expect(limits([])).toEqual([" No quota providers found. The Status tab says why."]);
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
