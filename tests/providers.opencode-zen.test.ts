import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext } from "../src/lib/entries.js";
import { expectNotAttempted } from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOpenCodeZenQuota: vi.fn(),
  resolveOpenCodeConsoleAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-zen.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-zen.js")>()),
  queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
}));

vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuth: mocks.resolveOpenCodeConsoleAuth,
}));

import { opencodeZenProvider } from "../src/providers/opencode-zen.js";

const LOGIN_HINT = "Run `opencode auth login opencode`.";
const USD = { kind: "currency", code: "USD" } as const;
const balanceAccounting = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const consoleCredential = {
  accessToken: "st_secret-token",
  orgId: "wrk_123",
  orgName: "Acme",
};

function balanceEntry(prominence: "primary" | "supplementary") {
  return {
    accounting: balanceAccounting,
    kind: "quantity",
    name: "zen-current-balance",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "current_balance" },
      prominence,
    },
    quantity: { decimal: "42.5", unit: USD },
  } as const;
}

function autoReloadEntry(value = false) {
  return {
    accounting: { ...balanceAccounting, resultType: "status" },
    kind: "boolean",
    name: "zen-auto-reload",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "auto_reload" },
      prominence: "supplementary",
    },
    value,
  } as const;
}

function budgetEntry(
  options: {
    percentRemaining?: number;
    used?: string;
    limit?: string;
    remaining?: string;
    limitAuthority?: "provider_reported" | "user_configured";
    resetTimeIso?: string;
  } = {},
) {
  return {
    accounting: { ...balanceAccounting, resultType: "budget", authority: "locally_derived" },
    name: "zen-monthly-budget",
    group: "OpenCode Zen",
    percentRemaining: options.percentRemaining ?? 94.25,
    ...(options.resetTimeIso ? { resetTimeIso: options.resetTimeIso } : {}),
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
    basis: {
      used: {
        quantity: { decimal: options.used ?? "5.75", unit: USD },
        authority: "provider_reported",
      },
      limit: {
        quantity: { decimal: options.limit ?? "100", unit: USD },
        authority: options.limitAuthority ?? "provider_reported",
      },
      remaining: {
        quantity: { decimal: options.remaining ?? "94.25", unit: USD },
        authority: "locally_derived",
      },
    },
  } as const;
}

const userBudgetEntry = budgetEntry({
  percentRemaining: 97.125,
  limit: "200",
  remaining: "194.25",
  limitAuthority: "user_configured",
});

function success(overrides: Record<string, unknown> = {}, errors: string[] = []): void {
  mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
    success: true,
    errors,
    data: {
      balance: 4_250_000_000,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
      reload: false,
      reloadAmount: null,
      reloadTrigger: null,
      budgetResetIso: null,
      budgetSource: "credit_limit",
      ...overrides,
    },
  });
}

function context(config: Record<string, unknown> = {}): QuotaProviderContext {
  return { config } as unknown as QuotaProviderContext;
}

describe("opencode Zen provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValue({
      state: "configured",
      credential: consoleCredential,
    });
  });

  it.each([
    [{ state: "configured", credential: consoleCredential }, "auto", true],
    [{ state: "expired", credential: consoleCredential }, "auto", true],
    [{ state: "invalid", error: "refresh_failed: boom" }, "auto", true],
    [{ state: "none" }, "auto", false],
    [{ state: "none" }, ["opencode"], true],
    [{ state: "none" }, ["openai"], false],
    [{ state: "none", reason: "not_oauth" }, "auto", false],
    [{ state: "none", reason: "not_oauth" }, ["opencode"], true],
  ])("reports availability for %j with enabledProviders %j -> %j", async (resolution, enabledProviders, expected) => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce(resolution);
    await expect(opencodeZenProvider.isAvailable(context({ enabledProviders }))).resolves.toBe(
      expected,
    );
  });

  it.each([
    ["opencode/gpt-5", true],
    ["opencode-zen/claude-opus", true],
    ["OPENCODE/gemini", true],
    ["openai/gpt-5", false],
    ["opencode-go/model", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeZenProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("returns attempted:false in auto mode without a Console sign-in", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({ state: "none" });

    const result = await opencodeZenProvider.fetch(context({ enabledProviders: "auto" }));

    expectNotAttempted(result);
    expect(result.statusDetails).toEqual([{ key: "console_auth_state", value: "none" }]);
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no sign-in while Zen is explicitly enabled",
      { state: "none", reason: "not_oauth" },
      `No OpenCode Console sign-in found. ${LOGIN_HINT}`,
      "none",
    ],
    [
      "a failed sign-in, with the scrubbed reason",
      { state: "invalid", error: `refresh_failed: token ${"a".repeat(40)} was rejected` },
      `OpenCode Console sign-in failed: refresh_failed: token [redacted] was rejected. ${LOGIN_HINT}`,
      "invalid",
    ],
    [
      "an expired sign-in",
      { state: "expired", credential: consoleCredential },
      `OpenCode Console sign-in failed: the sign-in expired. ${LOGIN_HINT}`,
      "expired",
    ],
  ])("shows %s as an attempted error", async (_name, resolution, message, authState) => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce(resolution);

    const result = await opencodeZenProvider.fetch(context({ enabledProviders: ["opencode"] }));

    expect(result).toEqual({
      attempted: true,
      entries: [],
      errors: [{ label: "OpenCode Zen", message }],
      statusDetails: [{ key: "console_auth_state", value: authState }],
    });
    expect(JSON.stringify(result)).not.toContain("a".repeat(40));
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("projects Console failures as attempted errors with the server and org, never the token", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "configured",
      credential: { accessToken: "st_secret-token", server: "https://console.self-hosted.example" },
    });
    const error =
      "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.";
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: false, error });

    const result = await opencodeZenProvider.fetch(context());

    expect(result).toEqual({
      attempted: true,
      entries: [],
      errors: [{ label: "OpenCode Zen", message: error }],
      statusDetails: [
        { key: "console_auth_state", value: "configured" },
        { key: "console_server", value: "https://console.self-hosted.example" },
        { key: "console_org", value: "(none)" },
        { key: "live_fetch_error", value: error },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it.each([
    ["no monthly budget", {}],
    ["a last payment, which is never a monthly limit", { lastPayment: 50 }],
    ["no monthly usage", { monthlyLimit: 100, monthlyUsage: null }],
    ["a zero page limit, instead of emitting NaN", { monthlyLimit: 0 }],
  ])("makes the structured balance primary with %s", async (_name, data) => {
    success(data);

    const result = await opencodeZenProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
    expect(result.errors).toEqual([]);
    expect(result.presentation).toBeUndefined();
    expect(result.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auto_reload", value: "false" },
        { key: "auto_reload_amount_raw", value: "(none)" },
        { key: "auto_reload_trigger_raw", value: "(none)" },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("NaN");
    expect(JSON.stringify(result)).not.toContain("last_payment_usd");
  });

  it("shows current-month spend next to the balance when there is no monthly limit", async () => {
    success({ monthlyLimit: null, monthlyUsage: 1_182_020_000 });

    const result = await opencodeZenProvider.fetch(context());

    expect(result.entries).toEqual([
      {
        accounting: { ...balanceAccounting, resultType: "spend" },
        kind: "quantity",
        name: "zen-monthly-spend",
        group: "OpenCode Zen",
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        quantity: { decimal: "11.8202", unit: USD },
      },
      balanceEntry("primary"),
      autoReloadEntry(),
    ]);
    expect(result.statusDetails).toContainEqual({
      key: "monthly_usage_usd",
      value: "USD 11.8202",
    });
  });

  it("calculates monthly-limit remaining from monthly usage, with only the reload boolean as an entry", async () => {
    success({
      monthlyLimit: 100,
      monthlyUsage: 575_000_000,
      reload: true,
      reloadAmount: 20,
      reloadTrigger: 5,
    });

    const result = await opencodeZenProvider.fetch(context());

    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      budgetEntry(),
      balanceEntry("supplementary"),
      autoReloadEntry(true),
    ]);
    // The ambiguous reload amount and trigger stay diagnostic.
    expect(result.statusDetails).toEqual([
      { key: "console_auth_state", value: "configured" },
      { key: "console_server", value: "https://opencode.ai/console" },
      { key: "console_org", value: "Acme" },
      { key: "balance_usd", value: "USD 42.5" },
      { key: "monthly_limit_usd", value: "USD 100" },
      { key: "monthly_usage_usd", value: "USD 5.75" },
      { key: "budget_source", value: "credit_limit" },
      { key: "auto_reload", value: "true" },
      { key: "auto_reload_amount_raw", value: "20" },
      { key: "auto_reload_trigger_raw", value: "5" },
    ]);
  });

  it.each([
    [
      "the org budget reset date",
      {
        monthlyLimit: 60,
        monthlyUsage: 617_355_570,
        budgetResetIso: "2026-10-01T00:00:00.000Z",
        budgetSource: "org_budget",
      },
      {},
      budgetEntry({
        percentRemaining: Math.min(100, ((60 - 6.1735557) / 60) * 100),
        used: "6.1735557",
        limit: "60",
        remaining: "53.8264443",
        resetTimeIso: "2026-10-01T00:00:00.000Z",
      }),
    ],
    [
      "the positive plugin monthly-limit override",
      { monthlyLimit: 100, monthlyUsage: 575_000_000 },
      { opencodeMonthlyLimit: 200 },
      userBudgetEntry,
    ],
    [
      "the plugin monthly limit when the Console credit-limit request fails",
      { monthlyLimit: null, monthlyUsage: 575_000_000 },
      { opencodeMonthlyLimit: 200 },
      userBudgetEntry,
    ],
    [
      "monthly usage above the limit clamped to zero remaining",
      { monthlyLimit: 100, monthlyUsage: 20_000_000_000 },
      {},
      budgetEntry({ percentRemaining: 0, used: "200", remaining: "0" }),
    ],
  ])("builds the monthly budget from %s", async (_name, data, config, expectedBudget) => {
    success(data);

    const result = await opencodeZenProvider.fetch(context(config));

    expect(result.entries).toEqual([
      expectedBudget,
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
  });

  it("keeps the balance and reports failed optional Console routes", async () => {
    success({ reload: null }, [
      "OpenCode Console billing/auto-recharge error 500",
      "OpenCode Console usage/cost-by-day error 500",
    ]);

    const result = await opencodeZenProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([balanceEntry("primary")]);
    expect(result.errors).toEqual([
      { label: "OpenCode Zen", message: "OpenCode Console billing/auto-recharge error 500" },
      { label: "OpenCode Zen", message: "OpenCode Console usage/cost-by-day error 500" },
    ]);
    expect(result.statusDetails).toContainEqual({ key: "auto_reload", value: "(unknown)" });
    expect(result.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value:
        "OpenCode Console billing/auto-recharge error 500 | OpenCode Console usage/cost-by-day error 500",
    });
  });

  it.each([
    [true, 7_654],
    [false, undefined],
  ])("passes the timeout only when the user configured it (%s)", async (requestTimeoutMsConfigured, requestTimeoutMs) => {
    success();

    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 7_654, requestTimeoutMsConfigured }),
    );

    expect(mocks.queryOpenCodeZenQuota).toHaveBeenCalledWith(consoleCredential, {
      requestTimeoutMs,
    });
  });
});
