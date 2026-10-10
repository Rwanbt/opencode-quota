import { describe, expect, it } from "vitest";

import { accountFromGroup, rowsFromLegacyResult } from "../src/core/rows.js";
import type { QuotaRow } from "../src/core/types.js";
import type {
  AccountingMetadata,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../src/lib/entries.js";
import { getProviders } from "../src/providers/registry.js";
import { isLedgerRowKey, PROVIDER_ROW_KEYS } from "./helpers/provider-assertions.js";

const NOW_MS = Date.parse("2026-10-10T12:00:00.000Z");

function accounting(overrides: Partial<AccountingMetadata> = {}): AccountingMetadata {
  return {
    resultType: "quota",
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
    ...overrides,
  };
}

const REMOTE = accounting();
const RESET = "2026-10-11T00:00:00.000Z";

function windowEntry(group: string, label: string, extra: Partial<QuotaToastEntry> = {}) {
  return {
    accounting: REMOTE,
    name: `${group} ${label}`,
    group,
    label: `${label}:`,
    percentRemaining: 50,
    resetTimeIso: RESET,
    ...extra,
  } as QuotaToastEntry;
}

function usd(decimal: string) {
  return { decimal, unit: { kind: "currency" as const, code: "USD" } };
}

function fetchRows(providerId: string, entries: QuotaToastEntry[]) {
  return rowsFromLegacyResult(providerId, { attempted: true, entries, errors: [] }, NOW_MS);
}

/** [id, account, label, window] per row: the parts users' settings and the TUI rely on. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [row.id, row.account ?? null, row.label, row.window ?? null]);
}

type Case = {
  providerId: string;
  entries: QuotaToastEntry[];
  rows: Array<[string, string | null, string, string | null]>;
};

/** Sample results per provider, shaped like each adapter's output in its own tests. */
const CASES: Case[] = [
  {
    providerId: "anthropic",
    entries: [
      windowEntry("Claude", "5h"),
      windowEntry("Claude", "Weekly"),
      {
        ...windowEntry("Claude", "Fable"),
        name: "Claude Fable Weekly",
        semantic: { metric: { kind: "named", name: "Fable weekly" }, prominence: "primary" },
      },
      { ...windowEntry("Claude Usage Credits", "Monthly"), name: "Claude Usage Credits" },
      windowEntry("[Claude Work] (active)", "5h"),
      {
        ...windowEntry("[Claude Work] (active) Usage Credits", "Monthly"),
        name: "[Claude Work] (active) Usage Credits",
      },
    ],
    rows: [
      ["anthropic.five_hour", null, "5h", "five_hour"],
      ["anthropic.weekly", null, "Weekly", "week"],
      ["anthropic.weekly_fable", null, "Fable", "week"],
      ["anthropic.extra_usage", null, "Extra usage", "month"],
      ["anthropic.five_hour", "Work", "5h", "five_hour"],
      ["anthropic.extra_usage", "Work", "Extra usage", "month"],
    ],
  },
  {
    providerId: "copilot",
    entries: [
      {
        ...windowEntry("Copilot (pro)", "Quota"),
        name: "Copilot Premium Requests",
        right: "60/300",
      },
      {
        ...windowEntry("Copilot (pro)", "Budget"),
        accounting: accounting({ resultType: "budget", authority: "locally_derived" }),
        name: "Copilot Additional Usage",
        right: "$0.20/$1.00",
      },
      {
        kind: "value",
        accounting: accounting({ resultType: "usage" }),
        name: "Copilot AI Credits",
        group: "Copilot (business)",
        label: "Credits:",
        value: "Used 100 | Included 80",
      },
      {
        kind: "value",
        accounting: REMOTE,
        name: "Copilot",
        group: "[Copilot alice] (enterprise)",
        label: "Plan:",
        value: "Usage needs billing token",
      },
    ],
    rows: [
      ["copilot.allowance", "pro", "Premium requests", "month"],
      ["copilot.additional_budget", "pro", "Budget", "month"],
      ["copilot.allowance", "business", "Credits", "month"],
      ["copilot.allowance", "alice (enterprise)", "Plan", null],
    ],
  },
  {
    providerId: "openai",
    entries: [
      ...["5h", "Weekly", "Monthly", "Code Review"].map((label) =>
        windowEntry("OpenAI (Pro)", label, {
          accounting: accounting({ resultType: "rate_limit" }),
        }),
      ),
      windowEntry("[OpenAI Work] (Business) (active)", "Weekly"),
      {
        kind: "value",
        accounting: accounting({
          resultType: "status",
          acquisitionMethod: "local_runtime_accounting",
          authority: "locally_derived",
        }),
        name: "[OpenAI Key]",
        group: "[OpenAI Key]",
        value: "ChatGPT quota unavailable for API key",
      },
    ],
    rows: [
      ["openai.five_hour", "Pro", "5h", "five_hour"],
      ["openai.weekly", "Pro", "Weekly", "week"],
      ["openai.monthly", "Pro", "Monthly", "month"],
      ["openai.code_review", "Pro", "Code review", "code_review"],
      ["openai.weekly", "Work (Business)", "Weekly", "week"],
      ["openai.status", "Key", "Status", null],
    ],
  },
  {
    providerId: "openrouter",
    entries: [
      {
        kind: "percent",
        accounting: accounting({ resultType: "budget" }),
        name: "OpenRouter budget",
        group: "OpenRouter",
        label: "Budget:",
        right: "$2.00/$10.00",
        percentRemaining: 80,
      },
    ],
    rows: [["openrouter.key", null, "Budget", null]],
  },
  {
    providerId: "kilo",
    entries: [
      {
        accounting: accounting({ authority: "locally_derived" }),
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        semantic: {
          metric: { kind: "component", component: "remaining_credits" },
          prominence: "primary",
        },
        percentRemaining: 40,
      },
      {
        kind: "quantity",
        accounting: accounting({ resultType: "balance" }),
        name: "kilo-gateway-total-balance",
        group: "Kilo Gateway",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: usd("8.25"),
      },
    ],
    rows: [
      ["kilo.pass_credits", null, "Pass credits", null],
      ["kilo.balance", null, "Balance", null],
    ],
  },
  {
    providerId: "cursor",
    entries: [
      {
        accounting: accounting({
          resultType: "budget",
          acquisitionMethod: "local_runtime_accounting",
          authority: "locally_derived",
        }),
        name: "Cursor API (Pro)",
        group: "Cursor (Pro)",
        percentRemaining: 75,
        resetTimeIso: RESET,
        semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
      },
      {
        kind: "quantity",
        accounting: accounting({
          resultType: "spend",
          acquisitionMethod: "local_runtime_accounting",
          authority: "locally_derived",
        }),
        name: "cursor-auto-composer-spend",
        group: "Cursor (Pro)",
        semantic: { metric: { kind: "named", name: "Auto+Composer" }, prominence: "supplementary" },
        quantity: usd("1.25"),
      },
    ],
    rows: [
      ["cursor.api", "Pro", "API", "month"],
      ["cursor.auto_composer", "Pro", "Auto+Composer", "month"],
    ],
  },
  {
    providerId: "alibaba-coding-plan",
    entries: ["5h", "Weekly", "Monthly"].map((label) =>
      windowEntry("Alibaba Coding Plan (Pro)", label, {
        accounting: accounting({
          acquisitionMethod: "local_estimation",
          authority: "locally_derived",
        }),
        right: "120/6000",
      }),
    ),
    rows: [
      ["alibaba-coding-plan.five_hour", "Pro", "5h", "five_hour"],
      ["alibaba-coding-plan.weekly", "Pro", "Weekly", "week"],
      ["alibaba-coding-plan.monthly", "Pro", "Monthly", "month"],
    ],
  },
  {
    providerId: "alibaba-token-plan",
    entries: [
      windowEntry("Alibaba Personal Token Plan", "5h"),
      windowEntry("Alibaba Personal Token Plan", "Weekly"),
    ],
    rows: [
      ["alibaba-token-plan.five_hour", null, "5h", "five_hour"],
      ["alibaba-token-plan.weekly", null, "Weekly", "week"],
    ],
  },
  {
    providerId: "synthetic",
    entries: [
      windowEntry("Synthetic", "5h", { right: "26/100" }),
      windowEntry("Synthetic", "Weekly", { right: "$22/$24" }),
    ],
    rows: [
      ["synthetic.five_hour", null, "5h", "five_hour"],
      ["synthetic.weekly", null, "Weekly", "week"],
    ],
  },
  {
    providerId: "chutes",
    entries: [{ accounting: REMOTE, name: "Chutes", percentRemaining: 75, resetTimeIso: RESET }],
    rows: [["chutes.daily", null, "Daily", "day"]],
  },
  {
    providerId: "google-gemini-cli",
    entries: [
      {
        ...windowEntry("Gemini CLI (ali…)", "Gemini Pro"),
        name: "Gemini Pro (ali…)",
        accounting: accounting({ sourceId: "alice@example.com" }),
      },
      {
        ...windowEntry("Gemini CLI (ali…)", "Gemini Flash Lite"),
        name: "Gemini Flash Lite (ali…)",
        accounting: accounting({ sourceId: "alice@example.com" }),
      },
      {
        ...windowEntry("Gemini CLI (ali…)", "Gemini 2.5 Experimental"),
        name: "Gemini 2.5 Experimental (ali…)",
        accounting: accounting({ sourceId: "alice@example.com" }),
      },
      windowEntry("[Gemini CLI Work] (active)", "Gemini Flash", {
        accounting: accounting({ sourceId: "row-1" }),
      }),
    ],
    rows: [
      ["google-gemini-cli.pro", "ali…", "Pro", null],
      ["google-gemini-cli.flash_lite", "ali…", "Flash Lite", null],
      ["google-gemini-cli.model.2_5_experimental", "ali…", "2.5 Experimental", null],
      ["google-gemini-cli.flash", "Work", "Flash", null],
    ],
  },
  {
    providerId: "google-agy",
    entries: [
      {
        ...windowEntry("AGY (ali…): Gemini", "Weekly"),
        name: "Gemini Models (ali…)",
        sortPriority: 0,
      },
      { ...windowEntry("AGY (ali…): Gemini", "5h"), name: "Gemini Models (ali…)", sortPriority: 1 },
      {
        ...windowEntry("AGY (ali…): Claude/GPT", "Weekly"),
        name: "Claude and GPT models (ali…)",
      },
      {
        ...windowEntry("[Google AGY Work] (active)", "5h"),
        name: "[Google AGY Work] (active) Quota Summary 5h",
        accounting: accounting({ sourceId: "row-1" }),
      },
    ],
    rows: [
      ["google-agy.gemini.weekly", "ali…", "Gemini Weekly", "week"],
      ["google-agy.gemini.five_hour", "ali…", "Gemini 5h", "five_hour"],
      ["google-agy.claude_gpt.weekly", "ali…", "Claude/GPT Weekly", "week"],
      ["google-agy.quota_summary.five_hour", "Work", "Quota Summary 5h", "five_hour"],
    ],
  },
  {
    providerId: "zai",
    entries: [
      windowEntry("Z.ai", "5h"),
      windowEntry("Z.ai", "Weekly"),
      windowEntry("Z.ai", "MCP"),
      windowEntry("[Z.ai Home]", "5h", { accounting: accounting({ sourceId: "row-1" }) }),
    ],
    rows: [
      ["zai.five_hour", null, "5h", "five_hour"],
      ["zai.weekly", null, "Weekly", "week"],
      ["zai.mcp", null, "MCP", "mcp"],
      ["zai.five_hour", "Home", "5h", "five_hour"],
    ],
  },
  {
    providerId: "zhipu",
    entries: [windowEntry("Zhipu", "Weekly")],
    rows: [["zhipu.weekly", null, "Weekly", "week"]],
  },
  {
    providerId: "nanogpt",
    entries: [
      {
        accounting: REMOTE,
        name: "nanogpt-day-quota",
        group: "NanoGPT",
        percentRemaining: 100,
        resetTimeIso: RESET,
        semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
      },
      {
        accounting: REMOTE,
        name: "nanogpt-month-quota",
        group: "NanoGPT",
        percentRemaining: 90,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
      },
      {
        kind: "quantity",
        accounting: accounting({ resultType: "balance" }),
        name: "nanogpt-current-balance",
        group: "NanoGPT",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "primary",
        },
        quantity: usd("12.34"),
      },
      {
        kind: "quantity",
        accounting: accounting({ resultType: "balance" }),
        name: "nanogpt-current-balance",
        group: "NanoGPT",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "primary",
        },
        quantity: { decimal: "5", unit: { kind: "custom", symbol: "NANO" } },
      },
    ],
    rows: [
      ["nanogpt.daily", null, "Daily", "day"],
      ["nanogpt.monthly", null, "Monthly", "month"],
      ["nanogpt.balance.usd", null, "Balance", null],
      ["nanogpt.balance.nano", null, "Balance", null],
    ],
  },
  {
    providerId: "minimax-coding-plan",
    entries: [
      { ...windowEntry("MiniMax Token Plan", "5h"), name: "minimax-token-plan-5h" },
      { ...windowEntry("MiniMax Token Plan", "Weekly"), name: "minimax-token-plan-week" },
      {
        ...windowEntry("[MiniMax Token Plan shared 2]", "5h"),
        name: "minimax-token-plan-5h",
        accounting: accounting({ sourceId: "row-2" }),
      },
    ],
    rows: [
      ["minimax-coding-plan.five_hour", null, "5h", "five_hour"],
      ["minimax-coding-plan.weekly", null, "Weekly", "week"],
      ["minimax-coding-plan.five_hour", "shared 2", "5h", "five_hour"],
    ],
  },
  {
    providerId: "minimax-china-coding-plan",
    entries: [{ ...windowEntry("MiniMax Token Plan (CN)", "5h"), name: "minimax-token-plan-5h" }],
    rows: [["minimax-china-coding-plan.five_hour", null, "5h", "five_hour"]],
  },
  {
    providerId: "kimi-code-plan-cn",
    entries: [
      windowEntry("Kimi Code (CN)", "Weekly limit", { right: "250/1000" }),
      windowEntry("Kimi Code (CN)", "5h limit", { right: "100/500" }),
    ],
    rows: [
      ["kimi-code-plan-cn.weekly", null, "Weekly limit", "week"],
      ["kimi-code-plan-cn.limit.5h", null, "5h limit", "five_hour"],
    ],
  },
  {
    providerId: "kimi-code-plan-global",
    entries: [windowEntry("[Kimi Code Work]", "Limit #2")],
    rows: [["kimi-code-plan-global.limit.limit_2", "Work", "Limit #2", null]],
  },
  {
    providerId: "deepseek",
    entries: [
      {
        kind: "quantity",
        accounting: accounting({ resultType: "balance" }),
        name: "deepseek-usd-total-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: usd("12.340000000000000001"),
      },
      {
        kind: "quantity",
        accounting: accounting({ resultType: "balance" }),
        name: "deepseek-cny-granted-balance",
        group: "DeepSeek",
        semantic: {
          metric: { kind: "component", component: "granted_balance" },
          prominence: "supplementary",
        },
        quantity: { decimal: "3", unit: { kind: "currency", code: "CNY" } },
      },
      {
        kind: "boolean",
        accounting: accounting({ resultType: "status" }),
        name: "deepseek-availability",
        group: "DeepSeek",
        semantic: { metric: { kind: "named", name: "Availability" }, prominence: "primary" },
        value: true,
      },
    ],
    rows: [
      ["deepseek.total_balance.usd", null, "Balance", null],
      ["deepseek.granted_balance.cny", null, "Granted", null],
      ["deepseek.available", null, "Available", null],
    ],
  },
  {
    providerId: "xai",
    entries: [
      windowEntry("xAI SuperGrok", "Weekly"),
      windowEntry("[xAI personal] (SuperGrok) (active)", "Monthly", {
        accounting: accounting({ sourceId: "row-1" }),
      }),
    ],
    rows: [
      ["xai.credits", "SuperGrok", "Weekly", "week"],
      ["xai.credits", "personal (SuperGrok)", "Monthly", "month"],
    ],
  },
  {
    providerId: "xiaomi",
    entries: [
      {
        accounting: accounting({ acquisitionMethod: "dashboard_scrape" }),
        name: "Xiaomi MiMo: Standard [standard_monthly] Monthly",
        group: "Xiaomi MiMo: Standard [standard_monthly]",
        percentRemaining: 94.949921,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
      },
      ...(["total", "cash", "gift"] as const).map(
        (part): QuotaToastEntry => ({
          kind: "quantity",
          accounting: accounting({ resultType: "balance", acquisitionMethod: "dashboard_scrape" }),
          name: `xiaomi-mimo-${part}_balance`,
          group: "Xiaomi MiMo: Standard [standard_monthly]",
          semantic: {
            metric: { kind: "component", component: `${part}_balance` },
            prominence: part === "total" ? "primary" : "supplementary",
          },
          quantity: usd("10"),
        }),
      ),
    ],
    rows: [
      ["xiaomi.monthly_tokens", "Standard", "Monthly", "month"],
      ["xiaomi.total_balance", "Standard", "Balance", null],
      ["xiaomi.cash_balance", "Standard", "Cash", null],
      ["xiaomi.gift_balance", "Standard", "Gift", null],
    ],
  },
  {
    providerId: "opencode-go",
    entries: [
      windowEntry("OpenCode Go", "5h", { accounting: accounting({ sourceId: "console:go" }) }),
      windowEntry("OpenCode Go", "Weekly", { accounting: accounting({ sourceId: "console:go" }) }),
      windowEntry("OpenCode Go", "Monthly", { accounting: accounting({ sourceId: "console:go" }) }),
    ],
    rows: [
      ["opencode-go.five_hour", null, "5h", "five_hour"],
      ["opencode-go.weekly", null, "Weekly", "week"],
      ["opencode-go.monthly", null, "Monthly", "month"],
    ],
  },
  {
    providerId: "opencode",
    entries: [
      {
        accounting: accounting({ resultType: "budget", authority: "locally_derived" }),
        name: "zen-monthly-budget",
        group: "OpenCode Zen",
        percentRemaining: 94.25,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
        basis: {
          used: { quantity: usd("5.75"), authority: "provider_reported" },
          limit: { quantity: usd("100"), authority: "user_configured" },
        },
      },
      {
        kind: "quantity",
        accounting: accounting({ resultType: "balance" }),
        name: "zen-current-balance",
        group: "OpenCode Zen",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "supplementary",
        },
        quantity: usd("42.5"),
      },
      {
        kind: "boolean",
        accounting: accounting({ resultType: "status" }),
        name: "zen-auto-reload",
        group: "OpenCode Zen",
        semantic: {
          metric: { kind: "component", component: "auto_reload" },
          prominence: "supplementary",
        },
        value: false,
      },
    ],
    rows: [
      ["opencode.monthly", null, "Monthly", "month"],
      ["opencode.balance", null, "Balance", null],
      ["opencode.auto_reload", null, "Auto reload", null],
    ],
  },
  {
    providerId: "ollama-cloud",
    entries: [
      windowEntry("Ollama Cloud", "Session"),
      windowEntry("Ollama Cloud", "Weekly"),
      windowEntry("Ollama Cloud", "Monthly"),
    ],
    rows: [
      ["ollama-cloud.session", null, "Session", "session"],
      ["ollama-cloud.weekly", null, "Weekly", "week"],
      ["ollama-cloud.monthly", null, "Monthly", "month"],
    ],
  },
  {
    providerId: "quota-providers",
    entries: [
      {
        kind: "percent",
        accounting: accounting({ ownership: "user_configured", sourceId: "source-one" }),
        name: "Source One Monthly",
        group: "Source One",
        label: "Remaining:",
        right: "108/100",
        percentRemaining: -8,
      },
      {
        kind: "value",
        accounting: accounting({
          resultType: "balance",
          ownership: "user_configured",
          sourceId: "source-one",
        }),
        name: "Source One Balance",
        group: "Source One",
        value: "$12.00",
      },
    ],
    rows: [
      ["quota-providers.custom.source_one.monthly", "Source One", "Remaining", "month"],
      ["quota-providers.custom.source_one.balance", "Source One", "Balance", null],
    ],
  },
];

function sampleEntries(providerId: string): QuotaToastEntry[] {
  const sample = CASES.find((item) => item.providerId === providerId);
  if (!sample) throw new Error(`no sample for ${providerId}`);
  return sample.entries;
}

describe("PROVIDER_ROW_KEYS", () => {
  it("lists every registered provider", () => {
    expect(Object.keys(PROVIDER_ROW_KEYS).sort()).toEqual(
      getProviders()
        .map((provider) => provider.id)
        .sort(),
    );
  });

  it("has a sample for every provider below", () => {
    expect(new Set(CASES.map((sample) => sample.providerId))).toEqual(
      new Set(Object.keys(PROVIDER_ROW_KEYS)),
    );
  });
});

describe("rowsFromLegacyResult", () => {
  it.each(CASES)("gives $providerId rows their stable ids", ({ providerId, entries, rows }) => {
    const result = fetchRows(providerId, entries);
    expect(summary(result.rows)).toEqual(rows);
    expect(result.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
    for (const row of result.rows) {
      expect(isLedgerRowKey(providerId, row.id.slice(providerId.length + 1))).toBe(true);
    }
  });

  it("maps values per ADR 0001 and keeps exact amounts", () => {
    const openai = fetchRows("openai", sampleEntries("openai"));
    expect(openai.rows[0]).toEqual({
      id: "openai.five_hour",
      providerId: "openai",
      account: "Pro",
      label: "5h",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      window: "five_hour",
      prominence: "primary",
      percentRemaining: 50,
      resetsAt: RESET,
    });
    expect(openai.rows[5]).toMatchObject({
      type: "status",
      method: "local_estimation",
      authority: "locally_derived",
      text: "ChatGPT quota unavailable for API key",
    });

    const cursor = fetchRows("cursor", sampleEntries("cursor"));
    expect(cursor.rows[1]).toMatchObject({
      type: "usage",
      method: "local_estimation",
      prominence: "supplementary",
      amount: usd("1.25"),
    });

    const zen = fetchRows("opencode", sampleEntries("opencode"));
    expect(zen.rows.map((row) => [row.type, row.used, row.limit, row.amount, row.flag])).toEqual([
      ["budget", usd("5.75"), usd("100"), undefined, undefined],
      ["balance", undefined, undefined, usd("42.5"), undefined],
      ["status", undefined, undefined, undefined, false],
    ]);

    const deepseek = fetchRows("deepseek", sampleEntries("deepseek"));
    expect(deepseek.rows[0]?.amount).toEqual(usd("12.340000000000000001"));
  });

  it("reads used and limit from a compact right text only when it is unambiguous", () => {
    const count = { kind: "count", unit: "unit" };
    const synthetic = fetchRows("synthetic", sampleEntries("synthetic"));
    expect(synthetic.rows.map((row) => [row.used, row.limit])).toEqual([
      [
        { decimal: "26", unit: count },
        { decimal: "100", unit: count },
      ],
      [usd("22"), usd("24")],
    ]);
    const copilot = fetchRows("copilot", sampleEntries("copilot"));
    expect(copilot.rows[1]).toMatchObject({ used: usd("0.2"), limit: usd("1") });

    for (const right of ["1,234 left", "$3/12", "12/", "abc"]) {
      const [row] = fetchRows("synthetic", [windowEntry("Synthetic", "5h", { right })]).rows;
      expect(row).not.toHaveProperty("used");
      expect(row).not.toHaveProperty("limit");
    }
  });

  it("keeps the window start for the pace marker", () => {
    const [row] = fetchRows("xai", [
      windowEntry("xAI SuperGrok", "Weekly", {
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2026-10-04T00:00:00.000Z",
          observedAtIso: "2026-10-10T00:00:00.000Z",
          endsAtIso: RESET,
          fullReset: true,
        },
      }),
    ]).rows;
    expect(row?.windowStartedAt).toBe("2026-10-04T00:00:00.000Z");
  });

  it("numbers two unnamed logins and drops a row repeated for one login", () => {
    const login = (sourceId: string) => accounting({ sourceId });
    const result = fetchRows("opencode-go", [
      windowEntry("[OpenCode Go] (active)", "5h", { accounting: login("a") }),
      windowEntry("[OpenCode Go]", "5h", { accounting: login("b") }),
      windowEntry("[OpenCode Go]", "Weekly", { accounting: login("b") }),
      windowEntry("[OpenCode Go]", "Weekly", { accounting: login("b") }),
    ]);
    expect(summary(result.rows)).toEqual([
      ["opencode-go.five_hour", null, "5h", "five_hour"],
      ["opencode-go.five_hour", "Account 2", "5h", "five_hour"],
      ["opencode-go.weekly", null, "Weekly", "week"],
    ]);
    expect(result.debug).toEqual([
      { key: "dropped_row", value: "opencode-go.weekly: repeated row" },
    ]);
  });

  it("drops entries it can't key or validate and keeps the rest", () => {
    const result = fetchRows("zai", [
      windowEntry("Z.ai", "5h"),
      // The window helper's fallback when a plan reports no windows.
      { accounting: REMOTE, name: "Z.ai", percentRemaining: 0 },
      windowEntry("Z.ai", "Weekly", { percentRemaining: Number.NaN }),
      windowEntry("Z.ai", "MCP", { resetTimeIso: "tomorrow" }),
    ]);
    expect(result.rows.map((row) => row.id)).toEqual(["zai.five_hour"]);
    expect(result.debug).toEqual([
      { key: "dropped_row", value: "Z.ai: no row key" },
      { key: "dropped_row", value: "zai.weekly: invalid percentRemaining" },
      { key: "dropped_row", value: "zai.mcp: invalid resetsAt" },
    ]);
    expect(result.error).toBeUndefined();
  });

  it("classifies the first real error and keeps every message for /quota_status", () => {
    const result: QuotaProviderResult = {
      attempted: true,
      entries: [windowEntry("[Claude Home]", "5h")],
      errors: [
        { label: "Claude", message: "Skipped (not the current model)", kind: "intentional-filter" },
        { label: "[Claude Work]", message: "Token expired" },
        { label: "[Claude Other]", message: "HTTP 500" },
      ],
      statusDetails: [{ key: "auth_source", value: "opencode_db" }],
      rawDetails: [{ key: "plan", value: "max" }],
    };
    const fetched = rowsFromLegacyResult("anthropic", result, NOW_MS);
    expect(fetched.rows.map((row) => row.account)).toEqual(["Home"]);
    expect(fetched.error).toEqual({ code: "login_expired", detail: "Token expired" });
    expect(fetched.debug).toEqual([
      { key: "auth_source", value: "opencode_db" },
      { key: "plan", value: "max" },
      { key: "note", value: "Claude: Skipped (not the current model)" },
      { key: "error", value: "[Claude Work]: Token expired" },
      { key: "error", value: "[Claude Other]: HTTP 500" },
    ]);
  });

  it("reports a provider that could not even try as not set up", () => {
    expect(
      rowsFromLegacyResult("chutes", { attempted: false, entries: [], errors: [] }, NOW_MS),
    ).toEqual({ rows: [], error: { code: "not_configured" }, debug: [] });
    expect(fetchRows("chutes", [])).toEqual({ rows: [], debug: [] });
  });

  it("scrubs control characters from provider text", () => {
    const [row] = fetchRows("quota-providers", [
      {
        kind: "value",
        accounting: accounting({ ownership: "user_configured", sourceId: "src" }),
        name: "Evil\u001b[31m Note",
        group: "Evil\u001b[31m",
        value: "red\u001b[0m text\nnext",
      },
    ]).rows;
    expect(row?.account).toBe("Evil");
    expect(row?.text).toBe("red text next");
  });
});

describe("accountFromGroup", () => {
  it.each([
    ["openai", "OpenAI", undefined],
    ["openai", "OpenAI (Business)", "Business"],
    ["openai", "[OpenAI] (active)", undefined],
    ["openai", "[OpenAI Work 2] (Business)", "Work 2 (Business)"],
    ["anthropic", "[Claude] (active) Usage Credits", undefined],
    ["copilot", "Copilot (personal)", "personal"],
    ["google-agy", "AGY (Account 2): Claude/GPT", "Account 2"],
    ["kimi-code-plan-cn", "[Kimi Code (CN) Work]", "Work"],
    ["xiaomi", "Xiaomi MiMo: standard_monthly", "standard_monthly"],
    ["chutes", undefined, undefined],
  ] as const)("%s %s → %s", (providerId, group, account) => {
    expect(accountFromGroup(providerId, group)).toBe(account);
  });
});
