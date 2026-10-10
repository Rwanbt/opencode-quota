import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot, Words } from "../src/core/types.js";
import type { UsageProviderRow, UsageReport } from "../src/core/usage.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import { columnsOf } from "../src/view/columns.js";
import { DEFAULT_WORDS } from "../src/view/format.js";
import {
  type QuickLookInput,
  type QuickLookLine,
  quickLookRanges,
  quickLookText,
  quickLookView,
  quotaProviderIdsOfUsage,
  stepRange,
} from "../src/view/quick-look.js";

const NOW = new Date(2026, 9, 10, 15).getTime();
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
/** The dialog's room in a 100-column terminal. */
const WIDTH_100 = 93;

const text = (line: QuickLookLine) => line.map((part) => part.text).join("");

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

/** Half of the 5-hour window has passed with 30% left: even use would leave 50%. */
const ZAI = provider("zai", "Z.ai", [
  row("zai.five_hour", {
    label: "5h",
    window: "five_hour",
    percentRemaining: 30,
    resetsAt: at(150),
  }),
]);
const COPILOT = provider("copilot", "Copilot", [
  row("copilot.premium", { label: "Premium", percentRemaining: 80 }),
]);
const OPENROUTER = provider("openrouter", "OpenRouter", [], {
  error: { code: "provider_error", status: 500 },
});

function snapshot(providers: ProviderSnapshot[], words?: Words): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices: [],
    generatedAtMs: NOW,
    ...(words ? { words } : {}),
  };
}

function usageRow(providerID: string, costUsd: number, tokens: number, sessions: number) {
  return { providerID, sessions, costUsd, costShare: 0, tokens, tokenShare: 0, unpricedTokens: 0 };
}

/** A report whose shares and totals come from its provider rows (most cost first). */
function report(rows: UsageProviderRow[], range: UsageReport["range"] = "7d"): UsageReport {
  const costUsd = rows.reduce((sum, item) => sum + item.costUsd, 0);
  const tokens = rows.reduce((sum, item) => sum + item.tokens, 0);
  const providers = rows.map((item) => ({
    ...item,
    costShare: costUsd > 0 ? item.costUsd / costUsd : 0,
    tokenShare: tokens > 0 ? item.tokens / tokens : 0,
  }));
  const days = [3, 0, 5, 9, 2, 4, 7].map((share, index) => ({
    date: `2026-10-0${index + 4}`,
    costUsd: (costUsd * share) / 30,
    costShare: share / 30,
    tokens: Math.round((tokens * share) / 30),
    tokenShare: share / 30,
    unpricedTokens: 0,
  }));
  return {
    range,
    generatedAtMs: NOW,
    totals: {
      costUsd,
      sessions: rows.reduce((sum, item) => sum + item.sessions, 0),
      tokens: {
        processed: tokens,
        cachedInput: tokens * 0.6,
        uncachedInput: tokens * 0.3,
        output: tokens * 0.1,
      },
      costByType: {
        input: costUsd * 0.2,
        cacheRead: costUsd * 0.3,
        cacheWrite: costUsd * 0.1,
        output: costUsd * 0.4,
      },
      cacheSavingsUsd: 98.7,
      unpricedTokens: 0,
      unpricedShare: 0,
    },
    providers,
    models: [],
    days,
  };
}

/** OpenCode used Z.ai (as "zai-coding-plan") and Anthropic; quota checks Z.ai, Copilot, OpenRouter. */
const USAGE = report([
  usageRow("anthropic", 190.42, 2_900_000, 9),
  usageRow("zai-coding-plan", 12.5, 4_100_000, 3),
]);

function view(fields: Partial<QuickLookInput> = {}) {
  const display = defaultDisplaySettings();
  return quickLookView({
    snapshot: snapshot([ZAI, COPILOT, OPENROUTER]),
    usage: USAGE,
    range: "7d",
    mode: "cost",
    settings: display,
    thresholds: display.thresholds,
    nowMs: NOW,
    width: WIDTH_100,
    ...fields,
  });
}

const bodyText = (fields: Partial<QuickLookInput> = {}) => view(fields).body.map(text);

describe("quick look: providers", () => {
  it("matches OpenCode's provider ids to quota providers", () => {
    expect(quotaProviderIdsOfUsage("zai-coding-plan")).toContain("zai");
    expect(quotaProviderIdsOfUsage("github-copilot")).toContain("copilot");
    expect(quotaProviderIdsOfUsage("team-gateway")).toEqual(["team-gateway"]);
  });

  it("lists used providers first, each with its limits, then quota providers OpenCode didn't use", () => {
    const lines = bodyText();
    const blocks = lines.filter((line) => line.startsWith("● ")).map((line) => line.slice(2, 14));
    expect(blocks).toEqual(["Anthropic   ", "Z.ai        ", "Copilot     ", "OpenRouter  "]);
    const zai = lines.findIndex((line) => line.startsWith("● Z.ai"));
    expect(lines[zai]).toBe("● Z.ai            $12.50  6.2% of cost · 4.10M tokens · 3 sessions");
    expect(lines[zai + 1]).toMatch(
      /^ {4}5h {6}[█░│]{20} {3}30% left · resets in 2h 30m · runs out in 1h 5m$/u,
    );
    expect(lines[zai + 2]).toBe("");
  });

  it("shows only the cost line for a provider quota doesn't check", () => {
    const lines = bodyText();
    const anthropic = lines.findIndex((line) => line.startsWith("● Anthropic"));
    expect(lines[anthropic]).toBe(
      "● Anthropic      $190.42  93.8% of cost · 2.90M tokens · 9 sessions",
    );
    expect(lines[anthropic + 1]).toBe("");
  });

  it("says when OpenCode didn't use a quota provider, and shows its error", () => {
    const lines = bodyText();
    const copilot = lines.findIndex((line) => line.startsWith("● Copilot"));
    expect(lines[copilot]).toBe("● Copilot              —  no usage in OpenCode");
    expect(lines[copilot + 1]).toMatch(/^ {4}Premium [█░]{20} {3}80% left$/u);
    const openrouter = lines.findIndex((line) => line.startsWith("● OpenRouter"));
    expect(lines[openrouter + 1]).toBe("    Provider error 500");
  });

  it("puts the even-use mark where even use would be", () => {
    const zai = bodyText().find((line) => line.startsWith("    5h"));
    // The label column is as wide as the longest label, "Premium".
    expect(zai?.slice(12, 32)).toBe(`${"█".repeat(6)}░░░░│${"░".repeat(9)}`);
    const marker = view()
      .body.flat()
      .find((part) => part.text === "│");
    expect(marker?.role).toBe("marker");
  });

  it("puts the pace words under the bar when the line would be too wide", () => {
    const lines = bodyText({ width: 80 });
    const bar = lines.findIndex((line) => line.startsWith("    5h"));
    expect(lines[bar]).toMatch(/30% left · resets in 2h 30m$/u);
    expect(lines[bar + 1]).toBe(`${" ".repeat(34)}runs out in 1h 5m`);
  });

  it("lists the most tokens first in Tokens and swaps the amounts", () => {
    const lines = bodyText({ mode: "tokens" });
    const first = lines.find((line) => line.startsWith("● "));
    expect(first).toBe("● Z.ai             4.10M  58.6% of tokens · $12.50 · 3 sessions");
  });
});

describe("quick look: header, totals and keys", () => {
  it("shows the range and marks the picked mode and range as chips", () => {
    const { header } = view();
    expect(text(header)).toMatch(/^Quota {2}last 7 days +Cost {3}Tokens {5}‹ {2}7 days {2}›$/u);
    expect(columnsOf(text(header))).toBe(WIDTH_100);
    const chips = header.filter((part) => part.role === "chip").map((part) => part.text);
    expect(chips).toEqual([" Cost ", " 7 days "]);
    expect(
      view({ mode: "tokens" })
        .header.filter((part) => part.role === "chip")
        .map((part) => part.text),
    ).toEqual([" Tokens ", " 7 days "]);
  });

  it("shows the totals beside the daily chart, and cost by type", () => {
    const lines = bodyText();
    expect(lines[0]).toMatch(/^\$202\.92 +Daily cost$/u);
    expect(lines[1]).toMatch(/^12 sessions · API estimate +\$\d/u);
    expect(lines[2]).toMatch(/^7\.00M tokens · cache saved \$98\.70 +[▁-█]/u);
    expect(lines[3]).toMatch(/^ {41,}0 ─+$/u);
    expect(lines).toContain("Cost by type");
    expect(text(view().keys)).toBe(
      "c/t cost or tokens · ←/→ range · u full usage · s settings · esc close",
    );
  });

  it.each([
    { fields: { usage: undefined }, first: "Loading usage…" },
    {
      fields: { usage: undefined, usageNote: "Couldn't load usage: boom" },
      first: "Couldn't load usage: boom",
    },
    { fields: { usage: report([]) }, first: "No usage in this range." },
  ])("says when there is no usage to show ($first)", ({ fields, first }) => {
    const lines = bodyText(fields);
    expect(lines[0]).toBe(first);
    expect(lines).toContain("● Z.ai                 —  no usage in OpenCode");
    expect(lines).not.toContain("Cost by type");
  });

  it.each([60, WIDTH_100, 111])("keeps every line within %i columns", (width) => {
    const { header, body, keys } = view({ width });
    for (const line of [header, ...body, keys]) {
      expect(columnsOf(text(line))).toBeLessThanOrEqual(width);
    }
  });
});

describe("quick look: ranges", () => {
  it("offers the usage ranges without 'between', and the session ones only in a session", () => {
    expect(quickLookRanges(true)).not.toContain("between");
    expect(quickLookRanges(true)).toEqual(expect.arrayContaining(["7d", "session"]));
    expect(quickLookRanges(false)).not.toContain("session");
    expect(quickLookRanges(false)).not.toContain("session_tree");
  });

  it("steps through the ranges and stops at both ends", () => {
    const ranges = quickLookRanges(false);
    const index = ranges.indexOf("7d");
    expect(stepRange("7d", 1, false)).toBe(ranges[index + 1]);
    expect(stepRange("7d", -1, false)).toBe(ranges[index - 1]);
    expect(stepRange(ranges[0], -1, false)).toBe(ranges[0]);
    const last = ranges[ranges.length - 1];
    expect(stepRange(last, 1, false)).toBe(last);
  });
});

describe("quick look: short text", () => {
  const settings = defaultDisplaySettings();

  it("writes the range and totals, then one line per provider", () => {
    const lines = quickLookText({
      snapshot: snapshot([ZAI, COPILOT, OPENROUTER]),
      usage: USAGE,
      settings,
      nowMs: NOW,
    }).split("\n");
    expect(lines[0]).toBe("Quota · 7 days · $202.92 · 7.00M tokens");
    expect(lines.slice(1)).toEqual([
      "● Anthropic   $190.42",
      "● Z.ai        5h 30%  $12.50",
      "● Copilot     Premium 80%",
      "● OpenRouter  Provider error 500",
    ]);
  });

  it("adds the pace words only when the server's words ask for them", () => {
    const words = { ...DEFAULT_WORDS, runsOut: true };
    const message = quickLookText({
      snapshot: snapshot([ZAI], words),
      usage: undefined,
      settings,
      nowMs: NOW,
    });
    expect(message).toBe("Quota\n● Z.ai  5h 30% runs out in 1h 5m");
  });

  it("says when quota found no provider", () => {
    expect(quickLookText({ snapshot: snapshot([]), usage: report([]), settings, nowMs: NOW })).toBe(
      "Quota · 7 days · no usage\nNo quota providers found. Run /quota_status to see why.",
    );
  });
});
