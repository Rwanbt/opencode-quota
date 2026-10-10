import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  resolveMimoConfigCached: vi.fn(),
  queryMimoDashboard: vi.fn(),
}));

vi.mock("../src/lib/mimo-config.js", () => ({
  resolveMimoConfigCached: mocks.resolveMimoConfigCached,
  getMimoConfigDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    error: null,
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/mimo.js", () => ({
  queryMimoDashboard: mocks.queryMimoDashboard,
}));

import { xiaomiProvider } from "../src/providers/mimo.js";

const cookie = "api-platform_serviceToken=service-secret; userId=user-secret";
const quotaAccounting = {
  resultType: "quota",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const balanceAccounting = { ...quotaAccounting, resultType: "balance" } as const;

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

function configured(): void {
  mocks.resolveMimoConfigCached.mockResolvedValueOnce({
    state: "configured",
    source: "env:MIMO_USAGE_COOKIE",
    config: { cookie },
  });
}

function dashboard(overrides: Record<string, unknown> = {}): void {
  mocks.queryMimoDashboard.mockResolvedValueOnce({
    usage: { state: "success", data: { used: 10_100_158, limit: 200_000_000 } },
    detail: {
      state: "success",
      data: { planName: "Standard", planCode: "standard_monthly", expired: false },
    },
    balance: {
      state: "success",
      data: { total: 50, cash: 30, gift: 20, currency: "USD" },
    },
    ...overrides,
  });
}

function monthlyEntry(group: string) {
  return {
    accounting: quotaAccounting,
    name: `${group} Monthly`,
    group,
    percentRemaining: 94.949921,
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
    basis: {
      used: {
        quantity: { decimal: "10100158", unit: { kind: "count", unit: "token" } },
        authority: "provider_reported",
      },
      limit: {
        quantity: { decimal: "200000000", unit: { kind: "count", unit: "token" } },
        authority: "provider_reported",
      },
    },
  };
}

function balanceEntry(component: string, prominence: string, quantity: Record<string, unknown>) {
  return {
    accounting: balanceAccounting,
    kind: "quantity",
    name: `xiaomi-mimo-${component}`,
    group: "Xiaomi MiMo: Standard [standard_monthly]",
    semantic: { metric: { kind: "component", component }, prominence },
    quantity,
  };
}

describe("Xiaomi MiMo provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ state: "configured", config: { cookie: "filtered" }, source: "env" }, true],
    [{ state: "invalid", source: "env", error: "Invalid cookie header" }, false],
    [{ state: "none" }, false],
  ])("reports availability for config state %j", async (configState, expected) => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce(configState);
    await expect(xiaomiProvider.isAvailable(context())).resolves.toBe(expected);
  });

  it.each([
    ["xiaomi/mimo-v2", true],
    ["xiaomi-token-plan-cn/mimo-v2", true],
    ["XIAOMI/MIMO-V2", true],
    ["xiaomi-mimo/mimo-v2", false],
    ["openai/gpt-5", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(xiaomiProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce({ state: "none" });

    expectNotAttempted(await xiaomiProvider.fetch(context()));
    expect(mocks.queryMimoDashboard).not.toHaveBeenCalled();
  });

  it("projects invalid configuration as a safe attempted error", async () => {
    mocks.resolveMimoConfigCached.mockResolvedValueOnce({
      state: "invalid",
      source: "/tmp/config/opencode-quota/mimo.json",
      error: "Invalid cookie header",
    });

    const result = await xiaomiProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "Xiaomi MiMo");
    expect(result.errors[0]?.message).toBe(
      "Invalid config (/tmp/config/opencode-quota/mimo.json): Invalid cookie header",
    );
    expect(JSON.stringify(result)).not.toMatch(/api-platform_serviceToken|userId/);
  });

  it("maps the named monthly quota and provider-reported balances", async () => {
    configured();
    dashboard();

    const result = await xiaomiProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    const usd = { kind: "currency", code: "USD" };
    expect(result.entries).toEqual([
      monthlyEntry("Xiaomi MiMo: Standard [standard_monthly]"),
      balanceEntry("total_balance", "primary", { decimal: "50", unit: usd }),
      balanceEntry("cash_balance", "supplementary", { decimal: "30", unit: usd }),
      balanceEntry("gift_balance", "supplementary", { decimal: "20", unit: usd }),
    ]);
    visibleEntries(result.entries, "xiaomi");
  });

  it("uses sanitized plan labels only as display enrichment", async () => {
    configured();
    dashboard({
      detail: {
        state: "success",
        data: {
          planName: "\u001b]2;title\u0007Premium\nPlan",
          planCode: "premium\u0007",
          expired: false,
        },
      },
      balance: { state: "success", data: { total: 1, cash: null, gift: null, currency: "EUR" } },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result.entries[0]?.group).toBe("Xiaomi MiMo: Premium Plan [premium]");
    expect(result.entries[1]).toMatchObject({
      kind: "quantity",
      quantity: { decimal: "1", unit: { kind: "currency", code: "EUR" } },
    });
    expect(JSON.stringify(result)).not.toContain("\u001b");
    expect(JSON.stringify(result)).not.toContain("\u0007");
  });

  it("suppresses an explicitly expired plan without hiding balances", async () => {
    configured();
    dashboard({
      detail: {
        state: "success",
        data: { planName: "Old plan", planCode: "old", expired: true },
      },
    });

    const result = await xiaomiProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.accounting.resultType === "balance")).toBe(true);
    expect(result.entries.every((entry) => entry.group === "Xiaomi MiMo")).toBe(true);
  });

  it("keeps monthly quota when detail fails and returns a partial result", async () => {
    configured();
    dashboard({
      detail: {
        state: "error",
        error: "Xiaomi MiMo detail response did not match the expected schema",
      },
      balance: {
        state: "error",
        error: "Xiaomi MiMo balance request failed (HTTP 503)",
      },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([monthlyEntry("Xiaomi MiMo")]);
    expect(result.errors).toEqual([
      {
        label: "Xiaomi MiMo",
        message: "Xiaomi MiMo detail response did not match the expected schema",
      },
      {
        label: "Xiaomi MiMo",
        message: "Xiaomi MiMo balance request failed (HTTP 503)",
      },
    ]);
  });

  it("preserves zero optional balances and their deterministic order", async () => {
    configured();
    dashboard({
      usage: { state: "error", error: "usage unavailable" },
      balance: {
        state: "success",
        data: { total: 0, cash: null, gift: 0, currency: null },
      },
    });

    const result = await xiaomiProvider.fetch(context());

    const credit = { kind: "count", unit: "credit" };
    expect(result.entries).toEqual([
      balanceEntry("total_balance", "primary", { decimal: "0", unit: credit }),
      balanceEntry("gift_balance", "supplementary", { decimal: "0", unit: credit }),
    ]);
    expect(result.errors).toEqual([{ label: "Xiaomi MiMo", message: "usage unavailable" }]);
  });

  it("returns all endpoint errors in fixed order when no data is available", async () => {
    configured();
    mocks.queryMimoDashboard.mockResolvedValueOnce({
      usage: { state: "error", error: "usage failed" },
      detail: { state: "error", error: "detail failed" },
      balance: { state: "error", error: "balance failed" },
    });

    const result = await xiaomiProvider.fetch(context());

    expect(result).toEqual({
      attempted: true,
      entries: [],
      errors: [
        { label: "Xiaomi MiMo", message: "usage failed" },
        { label: "Xiaomi MiMo", message: "detail failed" },
        { label: "Xiaomi MiMo", message: "balance failed" },
      ],
      statusDetails: [
        { key: "config_state", value: "none" },
        { key: "config_source", value: "(none)" },
        { key: "config_checked_paths", value: "(none)" },
      ],
    });
  });

  it.each([
    [{ requestTimeoutMs: 7_654, requestTimeoutMsConfigured: true }, 7_654],
    [{ requestTimeoutMs: 5_000, requestTimeoutMsConfigured: false }, undefined],
  ])("passes only a configured timeout to the client (%j)", async (config, expected) => {
    configured();
    dashboard();

    await xiaomiProvider.fetch(context(config));

    expect(mocks.queryMimoDashboard).toHaveBeenLastCalledWith(cookie, {
      requestTimeoutMs: expected,
    });
  });
});
