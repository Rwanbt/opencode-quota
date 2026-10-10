import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryChutesQuota } from "../src/lib/chutes.js";
import { queryDeepSeekBalance } from "../src/lib/deepseek.js";
import { queryNanoGptQuota } from "../src/lib/nanogpt.js";
import { querySyntheticQuota } from "../src/lib/synthetic.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(async () => ({})),
  getCredentialDatabasePaths: vi.fn(() => []),
}));

const mocks = vi.hoisted(() => ({ resolveNanoGptApiKey: vi.fn() }));

// Only the NanoGPT key is faked; every other vendor uses the real resolver.
vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api-key-resolver.js")>();
  return {
    ...actual,
    resolveApiKey: (spec: Parameters<typeof actual.resolveApiKey>[0]) =>
      spec === actual.API_KEY_VENDORS.nanogpt
        ? mocks.resolveNanoGptApiKey()
        : actual.resolveApiKey(spec),
  };
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function stubJsonFetch(body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Answers NanoGPT's usage and balance endpoints; a plain object becomes a JSON 200. */
function stubNanoGpt(usage: unknown, balance: unknown): void {
  mocks.resolveNanoGptApiKey.mockResolvedValueOnce({
    key: "nano-key",
    source: "env:NANOGPT_API_KEY",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const reply = String(input).includes("/subscription/v1/usage") ? usage : balance;
      return reply instanceof Response ? reply : jsonResponse(reply);
    }),
  );
}

const syntheticPayload = (overrides: Record<string, unknown> = {}) => ({
  rollingFiveHourLimit: {
    max: 100,
    remaining: 74.5,
    nextTickAt: "2026-01-20T18:12:03.000Z",
  },
  weeklyTokenLimit: {
    maxCredits: "$24.00",
    remainingCredits: "$2.02",
    nextRegenAt: "2026-01-27T18:12:03.000Z",
    percentRemaining: 8.4552365,
  },
  ...overrides,
});

describe("simple API-key provider queries", () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-provider-queries-"));
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir,
      XDG_CACHE_HOME: tempDir,
      XDG_STATE_HOME: tempDir,
    };
    for (const name of ["CHUTES_API_KEY", "SYNTHETIC_API_KEY", "DEEPSEEK_API_KEY"]) {
      delete process.env[name];
    }
    mocks.resolveNanoGptApiKey.mockReset().mockResolvedValue(null);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["Chutes", queryChutesQuota],
    ["Synthetic", querySyntheticQuota],
    ["NanoGPT", queryNanoGptQuota],
    ["DeepSeek", queryDeepSeekBalance],
  ] as const)("returns null when %s is not configured", async (_name, query) => {
    await expect(query()).resolves.toBeNull();
  });

  it.each([
    ["Chutes", "CHUTES_API_KEY", queryChutesQuota, "Chutes API error 401: Unauthorized"],
    [
      "Synthetic",
      "SYNTHETIC_API_KEY",
      querySyntheticQuota,
      "Synthetic API error 401: Unauthorized",
    ],
    ["DeepSeek", "DEEPSEEK_API_KEY", queryDeepSeekBalance, "DeepSeek API error 401: Unauthorized"],
  ] as const)("sanitizes %s HTTP errors", async (_name, envName, query, error) => {
    process.env[envName] = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized\u001b[31m", { status: 401 })),
    );
    await expect(query()).resolves.toEqual({ success: false, error });
  });

  describe("Chutes", () => {
    beforeEach(() => {
      process.env.CHUTES_API_KEY = "test-key";
    });

    it("maps quota data, reset time, endpoint, and authorization", async () => {
      const fetchMock = stubJsonFetch({ quota: 1000, used: 250 });

      await expect(queryChutesQuota()).resolves.toEqual({
        success: true,
        percentRemaining: 75,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.chutes.ai/users/me/quota_usage/me",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        }),
      );
    });

    it("handles zero quota safely", async () => {
      stubJsonFetch({ quota: 0, used: 0 });
      await expect(queryChutesQuota()).resolves.toMatchObject({
        success: true,
        percentRemaining: 0,
      });
    });
  });

  describe("Synthetic", () => {
    beforeEach(() => {
      process.env.SYNTHETIC_API_KEY = "test-key";
    });

    it("maps both top-level quota windows, ignores legacy fields, and calls the endpoint", async () => {
      const fetchMock = stubJsonFetch(
        syntheticPayload({
          freeToolCalls: { max: 250, remaining: 220 },
          subscription: { limit: 10, requests: 9, renewsAt: "2027-01-01T00:00:00.000Z" },
        }),
      );

      await expect(querySyntheticQuota()).resolves.toEqual({
        success: true,
        windows: {
          fiveHour: {
            limit: 100,
            used: 25.5,
            percentRemaining: 75,
            resetTimeIso: "2026-01-20T18:12:03.000Z",
          },
          weekly: {
            limit: 24,
            used: 21.98,
            percentRemaining: 8,
            resetTimeIso: "2026-01-27T18:12:03.000Z",
          },
        },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.synthetic.new/v2/quotas",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        }),
      );
    });

    it.each([
      "bad-value",
      -5,
      150,
    ] as const)("derives weekly percent when percentRemaining is invalid (%s)", async (percentRemaining) => {
      stubJsonFetch(
        syntheticPayload({
          weeklyTokenLimit: {
            maxCredits: "$24.00",
            remainingCredits: "$2.02",
            percentRemaining,
          },
        }),
      );
      const result = await querySyntheticQuota();
      expect(result?.success ? result.windows.weekly.percentRemaining : -1).toBe(8);
    });

    it("drops malformed reset timestamps", async () => {
      stubJsonFetch(
        syntheticPayload({
          rollingFiveHourLimit: { max: 100, remaining: 74.5, nextTickAt: "\u001b[31mbad" },
          weeklyTokenLimit: {
            maxCredits: "$24.00",
            remainingCredits: "$2.02",
            nextRegenAt: "\u001b[31mbad",
            percentRemaining: 8.4552365,
          },
        }),
      );

      const invalid = await querySyntheticQuota();
      expect(invalid?.success ? invalid.windows.fiveHour.resetTimeIso : "missing").toBeUndefined();
      expect(invalid?.success ? invalid.windows.weekly.resetTimeIso : "missing").toBeUndefined();
    });

    it("reports zero percent when both top-level windows are exhausted", async () => {
      stubJsonFetch(
        syntheticPayload({
          rollingFiveHourLimit: { max: 100, remaining: 0 },
          weeklyTokenLimit: {
            maxCredits: "$24.00",
            remainingCredits: "$0.00",
            percentRemaining: 0,
          },
        }),
      );
      const result = await querySyntheticQuota();
      expect(result?.success ? result.windows : null).toMatchObject({
        fiveHour: { used: 100, percentRemaining: 0 },
        weekly: { used: 24, percentRemaining: 0 },
      });
    });

    it("treats an authenticated HTTP 200 empty object as no quota data", async () => {
      stubJsonFetch({});
      await expect(querySyntheticQuota()).resolves.toEqual({
        success: false,
        error: "Synthetic returned no quota data for this account.",
      });
    });

    it.each([
      ["an empty array", [], "rollingFiveHourLimit"],
      ["null", null, "rollingFiveHourLimit"],
      ["a nonempty object without quota windows", { foo: true }, "rollingFiveHourLimit"],
      [
        "malformed rollingFiveHourLimit payloads",
        syntheticPayload({ rollingFiveHourLimit: { max: "1350", remaining: "20" } }),
        "rollingFiveHourLimit",
      ],
      [
        "malformed weeklyTokenLimit credit strings",
        syntheticPayload({
          weeklyTokenLimit: { maxCredits: "24.00", remainingCredits: "$2.02", percentRemaining: 8 },
        }),
        "weeklyTokenLimit",
      ],
      [
        "a missing weekly top-level window",
        { rollingFiveHourLimit: syntheticPayload().rollingFiveHourLimit },
        "weeklyTokenLimit",
      ],
      [
        "legacy subscription-only payloads",
        { subscription: { limit: 200, requests: 50 } },
        "rollingFiveHourLimit",
      ],
    ] as const)("rejects %s as a missing quota window", async (_name, payload, window) => {
      stubJsonFetch(payload);
      await expect(querySyntheticQuota()).resolves.toEqual({
        success: false,
        error: `Synthetic API response missing ${window} quota window`,
      });
    });
  });

  describe("NanoGPT", () => {
    it("maps usage and balance from both authenticated endpoints", async () => {
      mocks.resolveNanoGptApiKey.mockResolvedValueOnce({
        key: "nano-key",
        source: "env:NANOGPT_API_KEY",
      });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("nano-key");
        if (String(input).includes("/subscription/v1/usage")) {
          expect(init).toMatchObject({ method: "GET" });
          return jsonResponse({
            active: true,
            limits: { daily: 5000, monthly: 60000 },
            enforceDailyLimit: true,
            daily: { used: 50, remaining: 4950, percentUsed: 0.01, resetAt: 1_738_540_800_000 },
            monthly: {
              used: 1000,
              remaining: 59000,
              percentUsed: 0.0167,
              resetAt: 1_739_404_800_000,
            },
            period: { currentPeriodEnd: "2025-02-13T23:59:59.000Z" },
            state: "active",
            graceUntil: null,
          });
        }
        expect(init).toMatchObject({ method: "POST" });
        return jsonResponse({ usd_balance: "129.46956147", nano_balance: "26.71801147" });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: true,
        subscription: {
          active: true,
          state: "active",
          enforceDailyLimit: true,
          daily: {
            used: 50,
            limit: 5000,
            remaining: 4950,
            percentRemaining: 99,
            resetTimeIso: "2025-02-03T00:00:00.000Z",
            reportedBasis: { used: 50, limit: 5000, remaining: 4950 },
          },
          monthly: {
            used: 1000,
            limit: 60000,
            remaining: 59000,
            percentRemaining: 98,
            resetTimeIso: "2025-02-13T00:00:00.000Z",
            reportedBasis: { used: 1000, limit: 60000, remaining: 59000 },
          },
          currentPeriodEndIso: "2025-02-13T23:59:59.000Z",
          graceUntilIso: undefined,
        },
        balance: {
          usdBalanceRaw: "129.46956147",
          nanoBalanceRaw: "26.71801147",
        },
        endpointErrors: undefined,
      });
    });

    it("keeps derived fallback arithmetic out of provider-reported basis facts", async () => {
      stubNanoGpt(
        { active: true, daily: { used: 25, remaining: 75 }, state: "active" },
        { usd_balance: "12.50" },
      );

      const result = await queryNanoGptQuota();
      expect(result).toMatchObject({
        success: true,
        subscription: {
          daily: {
            used: 25,
            limit: 100,
            remaining: 75,
            reportedBasis: { used: 25, remaining: 75 },
          },
        },
      });
      if (!result || !result.success) throw new Error("Expected NanoGPT success");
      expect(result.subscription?.daily?.reportedBasis).not.toHaveProperty("limit");
    });

    it("uses the billing-period end only as the missing monthly reset fallback", async () => {
      stubNanoGpt(
        {
          active: true,
          limits: { monthly: 1000 },
          monthly: { used: 100, remaining: 900 },
          period: { currentPeriodEnd: "2030-02-01T12:34:56.000Z" },
          state: "active",
        },
        { usd_balance: "12.50" },
      );

      await expect(queryNanoGptQuota()).resolves.toMatchObject({
        success: true,
        subscription: {
          monthly: { resetTimeIso: "2030-02-01T12:34:56.000Z" },
        },
      });
    });

    it("returns partial success when usage succeeds and balance fails", async () => {
      stubNanoGpt(
        {
          active: false,
          limits: { daily: 100, monthly: 1000 },
          enforceDailyLimit: true,
          daily: { used: 100, remaining: 0, percentUsed: 1, resetAt: 1_735_776_000_000 },
          state: "grace",
          graceUntil: "2026-01-09T00:00:00.000Z",
        },
        new Response("Unauthorized", { status: 401 }),
      );
      await expect(queryNanoGptQuota()).resolves.toMatchObject({
        success: true,
        subscription: { active: false, state: "grace", daily: { percentRemaining: 0 } },
        balance: undefined,
        endpointErrors: [{ endpoint: "balance", message: "NanoGPT API error 401: Unauthorized" }],
      });
    });

    it.each([
      [
        "a failed usage endpoint",
        new Response("bad gateway", { status: 502 }),
        { usd_balance: "12.50", nano_balance: "3.25" },
        { usdBalanceRaw: "12.50", nanoBalanceRaw: "3.25" },
        "NanoGPT API error 502: bad gateway",
      ],
      [
        "an unexpected usage response shape",
        { nope: true },
        { usd_balance: "5.00" },
        { usdBalanceRaw: "5.00" },
        "NanoGPT usage response returned an unexpected response shape",
      ],
    ])("keeps the balance despite %s", async (_name, usage, balance, expectedBalance, message) => {
      stubNanoGpt(usage, balance);
      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: true,
        subscription: undefined,
        balance: expectedBalance,
        endpointErrors: [{ endpoint: "usage", message }],
      });
    });

    it.each([
      [
        "USD",
        { usd_balance: "12junk", nano_balance: "26.71801147" },
        { nanoBalanceRaw: "26.71801147" },
        "usd_balance",
      ],
      [
        "NANO",
        { usd_balance: "12.50", nano_balance: "anything" },
        { usdBalanceRaw: "12.50" },
        "nano_balance",
      ],
    ] as const)("validates the full %s decimal and preserves a valid sibling", async (_label, balancePayload, expectedBalance, invalidField) => {
      stubNanoGpt(
        {
          active: true,
          limits: { daily: 100 },
          daily: { used: 25, remaining: 75, resetAt: 1_735_776_000_000 },
          state: "active",
        },
        balancePayload,
      );

      await expect(queryNanoGptQuota()).resolves.toMatchObject({
        success: true,
        subscription: { daily: { used: 25, limit: 100, remaining: 75 } },
        balance: expectedBalance,
        endpointErrors: [
          {
            endpoint: "balance",
            message: `NanoGPT balance response returned an invalid ${invalidField} decimal`,
          },
        ],
      });
    });

    it("keeps valid usage when every returned balance decimal is malformed", async () => {
      stubNanoGpt(
        {
          active: true,
          limits: { monthly: 1000 },
          monthly: { used: 100, remaining: 900 },
          state: "active",
        },
        { usd_balance: "12junk", nano_balance: "anything" },
      );

      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: true,
        subscription: {
          active: true,
          state: "active",
          enforceDailyLimit: false,
          daily: undefined,
          monthly: {
            used: 100,
            limit: 1000,
            remaining: 900,
            percentRemaining: 90,
            resetTimeIso: undefined,
            reportedBasis: { used: 100, limit: 1000, remaining: 900 },
          },
          currentPeriodEndIso: undefined,
          graceUntilIso: undefined,
        },
        balance: undefined,
        endpointErrors: [
          {
            endpoint: "balance",
            message:
              "NanoGPT balance response returned an invalid usd_balance decimal; NanoGPT balance response returned an invalid nano_balance decimal",
          },
        ],
      });
    });

    it.each([
      [
        "HTTP errors from both endpoints",
        async (input: RequestInfo | URL) =>
          String(input).includes("/usage")
            ? new Response("usage failed", { status: 500 })
            : new Response("balance failed", { status: 403 }),
        "Usage: NanoGPT API error 500: usage failed; Balance: NanoGPT API error 403: balance failed",
      ],
      [
        "caught transport errors without leaking request data",
        async () => Promise.reject(new Error("network down")),
        "Usage: network down; Balance: network down",
      ],
    ])("returns a combined retryable error for %s", async (_name, fetchImpl, error) => {
      mocks.resolveNanoGptApiKey.mockResolvedValueOnce({
        key: "nano-key",
        source: "env:NANOGPT_API_KEY",
      });
      vi.stubGlobal("fetch", vi.fn(fetchImpl));
      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: false,
        error,
        retryable: true,
      });
    });

    it("preserves non-retryable HTTP status when error bodies cannot be read", async () => {
      mocks.resolveNanoGptApiKey.mockResolvedValueOnce({
        key: "nano-key",
        source: "env:NANOGPT_API_KEY",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 403,
          text: vi.fn().mockRejectedValue(new Error("body unavailable")),
        })),
      );

      await expect(queryNanoGptQuota()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("NanoGPT API error 403: body unavailable"),
        retryable: false,
      });
    });
  });

  describe("DeepSeek", () => {
    beforeEach(() => {
      process.env.DEEPSEEK_API_KEY = "test-key";
    });

    it("maps balance data, supported headers, endpoint, and timeout signal", async () => {
      const fetchMock = stubJsonFetch({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "12.34",
            granted_balance: "2.00",
            topped_up_balance: "10.34",
          },
        ],
      });

      await expect(queryDeepSeekBalance({ requestTimeoutMs: 1234 })).resolves.toEqual({
        success: true,
        isAvailable: true,
        balanceInfos: [
          {
            currency: "USD",
            totalBalance: "12.34",
            grantedBalance: "2.00",
            toppedUpBalance: "10.34",
          },
        ],
        parseIssues: [],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.deepseek.com/user/balance",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
            "User-Agent": "OpenCode-Quota-Toast/1.0",
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("preserves exact valid components and reports malformed decimals without zero coercion", async () => {
      stubJsonFetch({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "12.34\u001b[31m",
            granted_balance: "1.2345678901234567890",
            topped_up_balance: "not-a-number",
          },
        ],
      });
      await expect(queryDeepSeekBalance()).resolves.toEqual({
        success: true,
        isAvailable: true,
        balanceInfos: [{ currency: "USD", grantedBalance: "1.2345678901234567890" }],
        parseIssues: [
          { currency: "USD", field: "total_balance" },
          { currency: "USD", field: "topped_up_balance" },
        ],
      });
    });

    it.each([
      ["missing availability as undefined", {}, undefined, []],
      ["malformed availability as undefined", { is_available: "false" }, undefined, []],
      [
        "only supported currencies, including CNY",
        {
          is_available: false,
          balance_infos: [
            { currency: "EUR", total_balance: "9.99" },
            { currency: "cny", total_balance: "88.00" },
          ],
        },
        false,
        [{ currency: "CNY", totalBalance: "88.00" }],
      ],
    ])("keeps %s", async (_name, payload, isAvailable, balanceInfos) => {
      stubJsonFetch(payload);
      await expect(queryDeepSeekBalance()).resolves.toEqual({
        success: true,
        isAvailable,
        balanceInfos,
        parseIssues: [],
      });
    });

    it("reports unexpected response shapes as sanitized errors", async () => {
      stubJsonFetch([]);
      await expect(queryDeepSeekBalance()).resolves.toEqual({
        success: false,
        error: "DeepSeek balance response returned an unexpected response shape",
      });
    });
  });
});
