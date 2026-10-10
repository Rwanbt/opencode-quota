import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  formatMimoDashboardTimeZone,
  parseMimoBalanceResponse,
  parseMimoDetailResponse,
  parseMimoUsageResponse,
  queryMimoDashboard,
} from "../src/lib/mimo.js";

const cookie = "api-platform_serviceToken=service-secret; userId=user-secret";

type MockTimeoutOptions = {
  request: RequestInit;
  timeoutMs?: number;
  consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
};

function usagePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    message: "",
    data: {
      monthUsage: {
        percent: 0.0505,
        items: [
          { name: "plan_total_token", used: 1, limit: 2 },
          {
            name: "month_total_token",
            used: 10_100_158,
            limit: 200_000_000,
            percent: 0.0505,
            ...overrides,
          },
        ],
      },
    },
  };
}

function detailPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    message: "",
    data: {
      planName: "Standard",
      planCode: "standard_monthly",
      currentPeriodEnd: "2026-05-04 23:59:59",
      expired: false,
      ...overrides,
    },
  };
}

function balancePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    message: "",
    data: {
      balance: "50.00",
      cashBalance: "30.00",
      giftBalance: "20.00",
      currency: "USD",
      ...overrides,
    },
  };
}

function responseForUrl(url: string): Response {
  if (url.endsWith("/tokenPlan/usage")) return Response.json(usagePayload());
  if (url.endsWith("/tokenPlan/detail")) return Response.json(detailPayload());
  return Response.json(balancePayload());
}

/** Answers every endpoint normally, except `path` when given, which gets `respond`. */
function mockEndpoint(path?: string, respond?: () => Response | Promise<Response>): void {
  mocks.fetchWithTimeout.mockImplementation(async (url: string, options: MockTimeoutOptions) => {
    const response = path && respond && url.endsWith(path) ? await respond() : responseForUrl(url);
    return options.consume(response, new AbortController().signal);
  });
}

describe("MiMo response parsers", () => {
  it.each([
    ["the named month_total_token item", usagePayload(), { used: 10_100_158, limit: 200_000_000 }],
    ["zero usage", usagePayload({ used: 0, limit: 100 }), { used: 0, limit: 100 }],
    ["over-limit usage", usagePayload({ used: 120, limit: 100 }), { used: 120, limit: 100 }],
  ])("parses %s", (_label, payload, expected) => {
    expect(parseMimoUsageResponse(payload)).toEqual(expected);
  });

  it.each([
    ["missing named item", { code: 0, data: { monthUsage: { items: [] } } }],
    ["negative usage", usagePayload({ used: -1 })],
    ["zero limit", usagePayload({ limit: 0 })],
    ["string usage", usagePayload({ used: "10" })],
    ["non-finite usage", usagePayload({ used: Number.POSITIVE_INFINITY })],
  ])("rejects %s", (_label, payload) => {
    expect(() => parseMimoUsageResponse(payload)).toThrow();
  });

  it("uses plan labels and explicit expiry while ignoring currentPeriodEnd", () => {
    expect(
      parseMimoDetailResponse(
        detailPayload({
          currentPeriodEnd: "1999-01-01 00:00:00",
          expired: true,
        }),
      ),
    ).toEqual({
      planName: "Standard",
      planCode: "standard_monthly",
      expired: true,
    });
  });

  it.each([
    ["null data", { code: 0, data: null }],
    ["missing expired", { code: 0, data: { planCode: "standard" } }],
    ["wrong expired type", detailPayload({ expired: "false" })],
  ])("rejects detail with %s", (_label, payload) => {
    expect(() => parseMimoDetailResponse(payload)).toThrow();
  });

  it.each([
    ["all string balances", balancePayload(), { total: 50, cash: 30, gift: 20, currency: "USD" }],
    [
      "numbers, missing fields and a lowercase currency",
      { code: 0, data: { balance: 0, giftBalance: "2.50", currency: "eur" } },
      { total: 0, cash: null, gift: 2.5, currency: "EUR" },
    ],
    [
      "a non-ISO currency",
      { code: 0, data: { balance: "12.50", currency: "US$" } },
      { total: 12.5, cash: null, gift: null, currency: null },
    ],
    ["no balances", { code: 0, data: {} }, { total: null, cash: null, gift: null, currency: null }],
  ])("parses balance with %s", (_label, payload, expected) => {
    expect(parseMimoBalanceResponse(payload)).toEqual(expected);
  });

  it.each([
    ["negative", balancePayload({ balance: "-1" })],
    ["non-numeric", balancePayload({ cashBalance: "private" })],
    ["non-finite", balancePayload({ giftBalance: Number.NaN })],
  ])("rejects a present %s balance", (_label, payload) => {
    expect(() => parseMimoBalanceResponse(payload)).toThrow();
  });
});

describe("formatMimoDashboardTimeZone", () => {
  it.each([
    [0, "UTC+00:00"],
    [-60, "UTC+01:00"],
    [300, "UTC-05:00"],
    [-330, "UTC+05:30"],
  ])("formats offset %s as %s", (offset, expected) => {
    expect(formatMimoDashboardTimeZone(offset)).toBe(expected);
  });
});

describe("queryMimoDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEndpoint();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends three manual-redirect GETs and reads the timezone again on each call", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset")
      .mockReturnValueOnce(-60)
      .mockReturnValueOnce(-120);

    await queryMimoDashboard(cookie, { requestTimeoutMs: 4_321 });
    await queryMimoDashboard(cookie);

    const calls = mocks.fetchWithTimeout.mock.calls as [string, MockTimeoutOptions][];
    expect(calls.slice(0, 3).map(([url]) => url)).toEqual([
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail",
      "https://platform.xiaomimimo.com/api/v1/balance",
    ]);
    for (const [, options] of calls.slice(0, 3)) {
      expect(options.request).toEqual({
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: cookie,
          Origin: "https://platform.xiaomimimo.com",
          Referer: "https://platform.xiaomimimo.com/#/console/balance",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          "x-timeZone": "UTC+01:00",
        },
      });
      expect(options.timeoutMs).toBe(4_321);
    }
    expect(
      calls
        .slice(3)
        .map(([, options]) => (options.request.headers as Record<string, string>)["x-timeZone"]),
    ).toEqual(["UTC+02:00", "UTC+02:00", "UTC+02:00"]);
  });

  it.each([
    [
      "an HTTP error",
      "usage",
      () => new Response("private response body", { status: 503 }),
      "Xiaomi MiMo usage request failed (HTTP 503)",
    ],
    [
      "a redirect, which is not followed",
      "usage",
      () =>
        new Response("", {
          status: 302,
          headers: { Location: "https://example.test/private-login" },
        }),
      "Xiaomi MiMo usage request requires login",
    ],
    [
      "malformed JSON",
      "usage",
      () => new Response("{"),
      "Xiaomi MiMo usage response could not be parsed",
    ],
    [
      "an unexpected schema",
      "detail",
      () => Response.json({ code: 0, data: { expired: "no" } }),
      "Xiaomi MiMo detail response did not match the expected schema",
    ],
    [
      "a declared oversized body",
      "balance",
      () => new Response("{}", { headers: { "Content-Length": String(300 * 1024) } }),
      "Xiaomi MiMo balance response could not be parsed",
    ],
  ] as const)("reports %s on one endpoint and keeps the others", async (_label, endpoint, respond, error) => {
    mockEndpoint(endpoint === "balance" ? "/balance" : `/tokenPlan/${endpoint}`, respond);

    const result = await queryMimoDashboard(cookie);

    expect(result[endpoint]).toEqual({ state: "error", error });
    const others = (["usage", "detail", "balance"] as const).filter((name) => name !== endpoint);
    expect(others.map((name) => result[name].state)).toEqual(["success", "success"]);
    expect(JSON.stringify(result)).not.toMatch(/private|example\.test/);
  });

  it.each([
    ["is larger than the size limit", "oversized", false, "error"],
    ["fails while reading", "failing", false, "error"],
    ["is too large and cannot be cancelled", "oversized", true, "error"],
    ["is read successfully", "valid", false, "success"],
  ] as const)("handles a streamed body that %s", async (_label, body, cancelThrows, state) => {
    const cancel = vi.fn(() => {
      if (cancelThrows) throw new Error("private cancellation failure");
    });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (body === "failing") return controller.error(new Error("private read failure"));
        if (body === "oversized") return controller.enqueue(new Uint8Array(256 * 1024 + 1));
        controller.enqueue(new TextEncoder().encode(JSON.stringify(usagePayload())));
        controller.close();
      },
      cancel,
    });
    mockEndpoint("/tokenPlan/usage", () => new Response(stream));

    const result = await queryMimoDashboard(cookie);

    expect(result.usage).toEqual(
      state === "success"
        ? { state, data: { used: 10_100_158, limit: 200_000_000 } }
        : { state, error: "Xiaomi MiMo usage response could not be parsed" },
    );
    // Only a body we stopped reading early is cancelled; an errored stream has nothing to cancel.
    expect(cancel).toHaveBeenCalledTimes(body === "oversized" ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("sanitizes timeout errors and redacts the cookie and retained values", async () => {
    mockEndpoint("/tokenPlan/usage", () =>
      Promise.reject(
        new Error(`\u001b[31mtimeout for ${cookie}\nservice-secret user-secret retry\u001b[0m`),
      ),
    );

    const result = await queryMimoDashboard(cookie);
    const serialized = JSON.stringify(result);

    expect(result.usage).toEqual({
      state: "error",
      error: "Xiaomi MiMo usage request failed: timeout for [redacted] [redacted] [redacted] retry",
    });
    expect(serialized).not.toContain("service-secret");
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("\u001b");
    expect(serialized).not.toContain("\n");
  });

  it("times out a stalled body with the real timeout helper, cancelling only that body", async () => {
    const http = await vi.importActual<typeof import("../src/lib/http.js")>("../src/lib/http.js");
    mocks.fetchWithTimeout.mockImplementation(http.fetchWithTimeout);
    vi.useFakeTimers();
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.endsWith("/tokenPlan/usage")) return responseForUrl(url);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => {
                controller.error(new Error(`stalled body exposed ${cookie}`));
              });
            },
          }),
        );
      }),
    );

    const pending = queryMimoDashboard(cookie, { requestTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    await vi.advanceTimersByTimeAsync(0);

    expect(result.usage).toEqual({
      state: "error",
      error: "Xiaomi MiMo usage request failed: Request timeout after 1s",
    });
    expect([result.detail.state, result.balance.state]).toEqual(["success", "success"]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/secret|stalled body exposed/);
  });
});
