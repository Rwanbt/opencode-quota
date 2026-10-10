import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveApiKey: vi.fn(), fetchWithTimeout: vi.fn() }));

vi.mock("../src/lib/http.js", () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  resolveApiKey: mocks.resolveApiKey,
}));

import { queryKiloQuota } from "../src/lib/kilo.js";

/** Queue one reply; a string body is sent as-is, anything else as JSON. */
function mockResponse(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  mocks.fetchWithTimeout.mockImplementationOnce(async (_url, options) =>
    options.consume(new Response(text, { status })),
  );
}

function statePayload(overrides: Record<string, unknown> = {}) {
  return [
    {
      result: {
        data: {
          json: {
            subscription: {
              currentPeriodBaseCreditsUsd: 19,
              currentPeriodUsageUsd: 2.76,
              currentPeriodBonusCreditsUsd: 9.5,
              nextBillingAt: "2099-02-01T00:00:00.000Z",
              ...overrides,
            },
          },
        },
      },
    },
  ];
}

const NO_SUBSCRIPTION = [{ result: { data: { json: { subscription: null } } } }];

function passResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    mode: "kilo_pass",
    baseCreditsUsd: 19,
    usageUsd: 2.76,
    bonusCreditsUsd: 9.5,
    remainingUsd: 25.74,
    overageUsd: 0,
    resetTimeIso: "2099-02-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Kilo Gateway API client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveApiKey.mockResolvedValue({ key: "kilo-secret-key", source: "env:KILO_API_KEY" });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveApiKey.mockResolvedValueOnce(null);

    await expect(queryKiloQuota()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the batched tRPC state request with Bearer auth", async () => {
    mockResponse(statePayload());

    await queryKiloQuota({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer kilo-secret-key",
            "Content-Type": "application/json",
          },
          redirect: "manual",
        },
        timeoutMs: 1234,
        consume: expect.any(Function),
      }),
    );
  });

  it.each([
    ["the batched tRPC json envelope", statePayload(), passResult()],
    [
      "an active pass with zero total credits",
      statePayload({
        currentPeriodBaseCreditsUsd: 0,
        currentPeriodUsageUsd: 0,
        currentPeriodBonusCreditsUsd: 0,
      }),
      passResult({ baseCreditsUsd: 0, usageUsd: 0, bonusCreditsUsd: 0, remainingUsd: 0 }),
    ],
    [
      "the unwrapped envelope with no bonus and only a renewal time",
      {
        result: {
          data: {
            subscription: {
              currentPeriodBaseCreditsUsd: 5,
              currentPeriodUsageUsd: 1,
              nextRenewalAt: "2099-03-01T00:00:00.000Z",
            },
          },
        },
      },
      passResult({
        baseCreditsUsd: 5,
        usageUsd: 1,
        bonusCreditsUsd: 0,
        remainingUsd: 4,
        resetTimeIso: "2099-03-01T00:00:00.000Z",
      }),
    ],
    [
      "overage with an invalid billing time",
      statePayload({
        currentPeriodBaseCreditsUsd: 10,
        currentPeriodUsageUsd: 12,
        currentPeriodBonusCreditsUsd: 0,
        nextBillingAt: "not-a-date",
        nextRenewalAt: "2099-03-01T00:00:00.000Z",
      }),
      passResult({
        baseCreditsUsd: 10,
        usageUsd: 12,
        bonusCreditsUsd: 0,
        remainingUsd: 0,
        overageUsd: 2,
        resetTimeIso: "2099-03-01T00:00:00.000Z",
      }),
    ],
    ["a date-only reset", statePayload({ nextBillingAt: "2099-02-01" }), passResult()],
  ])("parses %s without calling the balance endpoint", async (_name, payload, expected) => {
    mockResponse(payload);

    await expect(queryKiloQuota()).resolves.toEqual(expected);
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it.each([
    [statePayload({ currentPeriodBaseCreditsUsd: -1 }), "invalid currentPeriodBaseCreditsUsd"],
    [statePayload({ currentPeriodUsageUsd: "2.76" }), "invalid currentPeriodUsageUsd"],
    [statePayload({ currentPeriodBonusCreditsUsd: -1 }), "invalid currentPeriodBonusCreditsUsd"],
    [[{ result: { data: { json: { subscription: 7 } } } }], "an invalid Kilo Pass subscription"],
    [null, "an unexpected response shape"],
    [[{ result: { data: { json: "invalid" } } }], "an unexpected response shape"],
  ])("does not hide the bad state %j behind a balance fallback", async (payload, error) => {
    mockResponse(payload);

    await expect(queryKiloQuota()).resolves.toEqual({
      success: false,
      error: `Kilo Gateway state API returned ${error}`,
    });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("falls back to the documented Gateway balance for a valid no-subscription response", async () => {
    mockResponse(NO_SUBSCRIPTION);
    mockResponse({ balance: 12.5 });

    await expect(queryKiloQuota({ requestTimeoutMs: 2345 })).resolves.toEqual({
      success: true,
      mode: "gateway_balance",
      balanceUsd: 12.5,
    });
    expect(mocks.resolveApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://api.kilo.ai/api/profile/balance",
      expect.objectContaining({
        request: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer kilo-secret-key" }),
        }),
        timeoutMs: 2345,
      }),
    );
  });

  const FALLBACK_FAILED =
    "Kilo Gateway has no active Kilo Pass subscription; balance fallback failed";
  it.each([
    [
      "a state envelope without subscription",
      [{ result: { data: { json: {} } } }],
      { balance: 4.5 },
      200,
      { success: true, mode: "gateway_balance", balanceUsd: 4.5 },
    ],
    [
      "an invalid balance",
      NO_SUBSCRIPTION,
      { balance: -1 },
      200,
      {
        success: false,
        error: `${FALLBACK_FAILED}: Kilo Gateway balance API returned an invalid balance`,
      },
    ],
    [
      "a failed balance request, sanitized",
      NO_SUBSCRIPTION,
      "down\nkilo-secret-key\u001b[31m",
      503,
      {
        success: false,
        error: `${FALLBACK_FAILED}: Kilo Gateway balance API error 503: down [redacted]`,
      },
    ],
  ])("handles the balance fallback after %s", async (_name, state, balance, status, expected) => {
    mockResponse(state);
    mockResponse(balance, status);

    await expect(queryKiloQuota()).resolves.toEqual(expected);
  });

  it("does not fall back after a Kilo Pass HTTP failure", async () => {
    mockResponse("Unauthorized\nkilo-secret-key\u001b[31m", 401);

    await expect(queryKiloQuota()).resolves.toEqual({
      success: false,
      error: "Kilo Gateway state API error 401: Unauthorized [redacted]",
    });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("stops reading oversized responses before parsing", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(32 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
        throw new Error("cancel failed");
      },
    });
    mocks.fetchWithTimeout.mockImplementationOnce(async (_url, options) =>
      options.consume({ ok: true, status: 200, body }),
    );

    await expect(queryKiloQuota()).resolves.toEqual({
      success: false,
      error: "Kilo Gateway state API response exceeded 65536 bytes",
    });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("sanitizes parse and transport errors without leaking the key", async () => {
    mockResponse("not json kilo-secret-key\nnext");

    const malformed = await queryKiloQuota();
    expect(malformed && !malformed.success ? malformed.error : "").toContain("Unexpected token");
    expect(JSON.stringify(malformed)).not.toContain("kilo-secret-key");

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout kilo-secret-key\nnext"));
    await expect(queryKiloQuota()).resolves.toEqual({
      success: false,
      error: "timeout [redacted] next",
    });
  });
});
