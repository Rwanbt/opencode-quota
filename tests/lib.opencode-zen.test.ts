import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse(url);
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import type { OpenCodeConsoleCredential } from "../src/lib/opencode-console-auth.js";
import { queryOpenCodeZenQuota } from "../src/lib/opencode-zen.js";

const CONSOLE_API = "https://opencode.ai/console/api";
const SESSION_ERROR =
  "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.";
const ROUTES = [
  "billing/account",
  "billing/auto-recharge",
  "billing/status",
  "budgets/org",
  "usage/cost-by-day",
];

const credential: OpenCodeConsoleCredential = {
  accessToken: "st_secret-token",
  orgId: "wrk_abc",
};

// Payloads captured from a real account by the maintainer (org id replaced).
const STATUS = {
  billingMode: "prepaid",
  mode: "pay-as-you-go",
  balanceMicroCents: "0",
  creditLimitMicroCents: null,
  availableMicroCents: "0",
  canPurchaseCredits: true,
  canEnableAutoRecharge: true,
  canEnrollInPrepaid: false,
};
const ACCOUNT = {
  orgId: "wrk_ABC",
  creditLimitMicroCents: null,
  createdAt: "2026-05-15T16:03:51.000Z",
  updatedAt: "2026-06-15T16:07:20.000Z",
};
const AUTO_RECHARGE = {
  enabled: false,
  thresholdDollars: 5,
  rechargeAmountDollars: 20,
  pending: false,
  failureReason: null,
};
const ORG_BUDGET = {
  limitMicroCents: "6000000000",
  spentMicroCents: "617355570",
  exceeded: false,
  resetsAt: "2026-10-01T00:00:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const serverError = () => new Response("server error", { status: 500 });

function routes(overrides: Record<string, () => Response> = {}, consoleApi = CONSOLE_API): void {
  const payloads: Record<string, () => Response> = {
    "billing/status": () => json(STATUS),
    "billing/account": () => json(ACCOUNT),
    "billing/auto-recharge": () => json(AUTO_RECHARGE),
    "budgets/org": () => json(ORG_BUDGET),
    "usage/cost-by-day": () => json([]),
    ...overrides,
  };
  mocks.fetchResponse.mockImplementation(async (url: string) => {
    if (!url.startsWith(`${consoleApi}/`)) throw new Error(`unexpected url ${url}`);
    const payload = payloads[url.slice(`${consoleApi}/`.length)];
    if (!payload) throw new Error(`unexpected url ${url}`);
    return payload();
  });
}

/** A funded account with a credit limit and this month's usage. */
function creditLimitRoutes(overrides: Record<string, () => Response>): void {
  routes({
    "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
    "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
    "usage/cost-by-day": () => json([{ date: "2026-09-24", totalCostMicroCents: "75000000" }]),
    ...overrides,
  });
}

/** What `creditLimitRoutes` yields when the org budget is not used. */
const CREDIT_LIMIT_DATA = {
  balance: 4_250_000_000,
  monthlyLimit: 100,
  monthlyUsage: 75_000_000,
  lastPayment: null,
  reload: false,
  reloadAmount: 20,
  reloadTrigger: 5,
  budgetResetIso: null,
  budgetSource: "credit_limit",
};
const ORG_BUDGET_DATA = {
  ...CREDIT_LIMIT_DATA,
  monthlyLimit: 60,
  monthlyUsage: 617_355_570,
  budgetResetIso: "2026-10-01T00:00:00.000Z",
  budgetSource: "org_budget",
};
const HEADERS = {
  Accept: "application/json",
  Authorization: "Bearer st_secret-token",
  "x-org-id": "wrk_abc",
};

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchResponse.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["the Bearer token and org id", credential, { requestTimeoutMs: 4_000 }, CONSOLE_API, 4_000],
    [
      "the Console server saved with the sign-in",
      { ...credential, server: "https://console.self-hosted.example" },
      {},
      "https://console.self-hosted.example/api",
      10_000,
    ],
  ])("calls the five Console routes with %s", async (_name, signIn, options, consoleApi, timeoutMs) => {
    routes({}, consoleApi);

    await expect(queryOpenCodeZenQuota(signIn, options)).resolves.toMatchObject({ success: true });
    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url).sort()).toEqual(
      ROUTES.map((route) => `${consoleApi}/${route}`),
    );
    for (const [, request] of mocks.fetchWithTimeout.mock.calls) {
      expect(request).toMatchObject({ request: { method: "GET", redirect: "manual" }, timeoutMs });
      expect(request.request.headers).toEqual(HEADERS);
    }
  });

  it("sends no x-org-id header when the sign-in has no org", async () => {
    routes();

    await queryOpenCodeZenQuota({ accessToken: "st_secret-token" });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(5);
    for (const [, request] of mocks.fetchWithTimeout.mock.calls) {
      expect(request.request.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer st_secret-token",
      });
    }
  });

  it("parses the real empty-account payloads", async () => {
    routes();

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: true,
      data: { ...ORG_BUDGET_DATA, balance: 0 },
      errors: [],
    });
  });

  it("prefers the org budget for the monthly limit, spend, and reset date", async () => {
    creditLimitRoutes({});

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: true,
      data: ORG_BUDGET_DATA,
      errors: [],
    });
  });

  it.each([
    [
      "has no limit",
      () => json({ limitMicroCents: null, spentMicroCents: null, resetsAt: null }),
      [],
    ],
    ["returns a null body", () => json(null), []],
    [
      "returns an empty body",
      () => new Response("", { headers: { "content-type": "application/json" } }),
      [],
    ],
    ["returns an empty object", () => json({}), []],
    ["has a negative spend", () => json({ ...ORG_BUDGET, spentMicroCents: "-5" }), []],
    ["fails", serverError, ["OpenCode Console budgets/org error 500"]],
    [
      "is forbidden",
      () => new Response("forbidden", { status: 403 }),
      ["OpenCode Console budgets/org error 403"],
    ],
  ])("falls back to the credit limit and usage costs when the org budget %s", async (_name, orgBudget, errors) => {
    creditLimitRoutes({ "budgets/org": orgBudget });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: true,
      data: CREDIT_LIMIT_DATA,
      errors,
    });
  });

  it("keeps micro-cents as billing units and sums only the current month's costs", async () => {
    creditLimitRoutes({
      "billing/auto-recharge": () => json({ ...AUTO_RECHARGE, enabled: true }),
      "budgets/org": () => json({ limitMicroCents: null, spentMicroCents: null, resetsAt: null }),
      "usage/cost-by-day": () =>
        json([
          { date: "2026-08-31", totalCostMicroCents: "900000000" },
          { date: "2026-09-01", totalCostMicroCents: "500000000" },
          { date: "2026-09-24", totalCostMicroCents: "75000000" },
        ]),
    });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: true,
      data: { ...CREDIT_LIMIT_DATA, monthlyUsage: 575_000_000, reload: true },
      errors: [],
    });
  });

  it("lists every failed optional route while keeping the balance", async () => {
    routes({
      "billing/account": serverError,
      "billing/auto-recharge": serverError,
      "budgets/org": serverError,
      "usage/cost-by-day": serverError,
    });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: null,
        monthlyUsage: null,
        lastPayment: null,
        reload: null,
        reloadAmount: null,
        reloadTrigger: null,
        budgetResetIso: null,
        budgetSource: "credit_limit",
      },
      errors: [
        "OpenCode Console billing/account error 500",
        "OpenCode Console billing/auto-recharge error 500",
        "OpenCode Console budgets/org error 500",
        "OpenCode Console usage/cost-by-day error 500",
      ],
    });
  });

  it("clamps a negative balance to zero", async () => {
    routes({ "billing/status": () => json({ ...STATUS, balanceMicroCents: "-14496" }) });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toMatchObject({
      success: true,
      data: { balance: 0 },
    });
  });

  it.each([
    // Normalized to canonical ISO so downstream result validation never drops the result.
    ["2026-10-01T00:00:00", new Date("2026-10-01T00:00:00").toISOString()],
    ["not-a-date", null],
  ])("keeps a usable org budget with reset %s as %s", async (resetsAt, budgetResetIso) => {
    routes({ "budgets/org": () => json({ ...ORG_BUDGET, resetsAt }) });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toMatchObject({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: 60,
        monthlyUsage: 617_355_570,
        budgetResetIso,
        budgetSource: "org_budget",
      },
      errors: [],
    });
  });

  it.each([
    [
      "a 302 redirect",
      "billing/status",
      () => new Response(null, { status: 302, headers: { location: "/console/login" } }),
    ],
    [
      "a login page",
      "budgets/org",
      () =>
        new Response("<html>Sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ],
    ...ROUTES.map((route) => ["a 401", route, () => new Response("unauthorized", { status: 401 })]),
  ] as Array<
    [string, string, () => Response]
  >)("reports an expired session for %s from %s", async (_name, route, sessionResponse) => {
    routes({ [route]: sessionResponse });

    const result = await queryOpenCodeZenQuota(credential);

    expect(result).toEqual({ success: false, error: SESSION_ERROR });
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it.each([
    [403, "forbidden"],
    [500, "private-body-session-secret"],
  ])("fails on a required billing/status %i without exposing the body", async (status, body) => {
    routes({ "billing/status": () => new Response(body, { status }) });

    const result = await queryOpenCodeZenQuota(credential);

    expect(result).toEqual({
      success: false,
      error: `OpenCode Console billing/status error ${status}`,
    });
    expect(JSON.stringify(result)).not.toContain(body);
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it.each([
    ["missing balance", () => json({ ...STATUS, balanceMicroCents: undefined })],
    ["non-JSON", () => new Response("not json", { status: 200 })],
    ["overflowing balance", () => json({ ...STATUS, balanceMicroCents: "9".repeat(309) })],
  ])("returns a stable parse error for a %s billing/status response", async (_name, payload) => {
    routes({ "billing/status": payload });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: false,
      error: "Could not parse OpenCode Console billing/status response",
    });
  });

  it.each([
    ["billing/account", () => json({ orgId: "wrk_ABC" })],
    ["billing/auto-recharge", () => json({ ...AUTO_RECHARGE, enabled: "no" })],
    ["budgets/org", () => json([])],
    ["budgets/org", () => json("none")],
    ["budgets/org", () => json({ spentMicroCents: "0" })],
    ["budgets/org", () => json({ limitMicroCents: "abc", spentMicroCents: "0" })],
    ["budgets/org", () => json({ limitMicroCents: "6000000000", resetsAt: 7 })],
    ["usage/cost-by-day", () => json({ days: [] })],
    ["usage/cost-by-day", () => json([{ date: "2026-09-01", totalCostMicroCents: "abc" }])],
    [
      "usage/cost-by-day",
      () =>
        json([
          { date: "2026-09-01", totalCostMicroCents: "9".repeat(308) },
          { date: "2026-09-02", totalCostMicroCents: "9".repeat(308) },
        ]),
    ],
  ])("lists a stable parse error for a malformed %s response", async (route, payload) => {
    routes({ [route]: payload });

    await expect(queryOpenCodeZenQuota(credential)).resolves.toMatchObject({
      success: true,
      data: { balance: 0 },
      errors: [`Could not parse OpenCode Console ${route} response`],
    });
  });

  it("sanitizes network and timeout errors and redacts the Bearer token and org id", async () => {
    mocks.fetchResponse.mockRejectedValue(
      new Error("\u001b[31mtimeout for wrk_abc with st_secret-token\nretry\u001b[0m"),
    );

    await expect(queryOpenCodeZenQuota(credential)).resolves.toEqual({
      success: false,
      error:
        "OpenCode Console billing/status request failed: timeout for [redacted] with [redacted] retry",
    });
  });
});
