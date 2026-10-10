import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthFile, readAuthFileCached } from "../src/lib/opencode-auth.js";
import { deriveResolvedAuthIdentity } from "../src/lib/resolved-auth-identity.js";
import type { AuthData } from "../src/lib/types.js";
import {
  hasXaiOAuthCached,
  periodKindLabel,
  queryXaiQuota,
  resolveXaiAuthIdentity,
  resolveXaiOAuth,
} from "../src/lib/xai.js";
import heavySubscriptionFixture from "./fixtures/xai/subscriptions-heavy.sanitized.json";
import superGrokWeeklyFixture from "./fixtures/xai/supergrok-weekly.json";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(async () => `rai1_${"b".repeat(43)}`),
}));

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const FAILED_AUTH = {
  xai: { type: "oauth", resolveError: "refresh_failed: HTTP 401" },
} as AuthData;
const WEEKLY_WINDOW = {
  percentRemaining: 95,
  resetTimeIso: "2026-07-20T02:24:00.983Z",
  kind: "weekly",
};

function mockConfiguredAuth(): void {
  vi.mocked(readAuthFile).mockResolvedValueOnce({
    xai: { type: "oauth", access: "token-1", expires: Date.now() + 60_000 },
  });
}

/** A JSON payload, or a function that builds the reply (a Response, a rejection, a hang). */
type FetchReply = unknown | ((init: RequestInit) => Promise<Response>);

function stubXaiFetch(
  credits: FetchReply = superGrokWeeklyFixture,
  subscriptions: FetchReply = { subscriptions: [] },
) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const reply = url === SUBSCRIPTIONS_URL ? subscriptions : credits;
    return typeof reply === "function"
      ? reply(init)
      : new Response(JSON.stringify(reply), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const hang = () => new Promise<Response>(() => {});

/** One active subscription; `tierSuffix` completes `SUBSCRIPTION_TIER_SUPER_GROK`. */
function activeSubscription(tierSuffix: string, providerOfferId?: string) {
  return {
    subscriptions: [
      {
        tier: `SUBSCRIPTION_TIER_SUPER_GROK${tierSuffix}`,
        status: "SUBSCRIPTION_STATUS_ACTIVE",
        ...(providerOfferId ? { activeOffer: { providerOfferId } } : {}),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("xAI auth resolution", () => {
  it("derives cache identity from the direct access token used by quota", async () => {
    vi.mocked(readAuthFile).mockResolvedValueOnce({
      xai: { type: "oauth", access: "xai-access-secret" },
    });

    const identity = await resolveXaiAuthIdentity();

    expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "xai",
      principal: { kind: "credential", value: "xai-access-secret" },
    });
    expect(identity).not.toContain("xai-access-secret");
  });

  it.each([
    [123, 123],
    [Number.NaN, undefined],
  ])("resolves only the trimmed OAuth access token (expires %s)", (expires, expiresAt) => {
    expect(
      resolveXaiOAuth({
        xai: { type: "oauth", access: " token-1 ", refresh: "ignored", expires },
      }),
    ).toEqual({ state: "configured", accessToken: "token-1", expiresAt });
  });

  it.each([
    ["an API key", { xai: { type: "api", access: "token-1" } }],
    ["a blank access token", { xai: { type: "oauth", access: "   " } }],
    ["a grok entry", { grok: { type: "oauth", access: "token-1" } }],
    ["an x-ai entry", { "x-ai": { type: "oauth", access: "token-1" } }],
    ["no entry", {}],
  ])("ignores %s", (_name, auth) => {
    expect(resolveXaiOAuth(auth as AuthData)).toEqual({ state: "none" });
  });

  it("keeps a login OpenCode could not return present", async () => {
    vi.mocked(readAuthFileCached).mockResolvedValueOnce(FAILED_AUTH).mockResolvedValueOnce({});

    expect(resolveXaiOAuth(FAILED_AUTH)).toEqual({
      state: "failed",
      error: "refresh_failed: HTTP 401",
    });
    await expect(hasXaiOAuthCached()).resolves.toBe(true);
    await expect(hasXaiOAuthCached()).resolves.toBe(false);
  });
});

describe("queryXaiQuota", () => {
  it("returns null without a usable OAuth login", async () => {
    vi.mocked(readAuthFile).mockResolvedValueOnce({
      xai: { type: "oauth", refresh: "refresh-only" },
    });
    await expect(queryXaiQuota()).resolves.toBeNull();
  });

  it("reports a login OpenCode could not return without fetching", async () => {
    vi.mocked(readAuthFile).mockResolvedValueOnce(FAILED_AUTH).mockResolvedValueOnce(FAILED_AUTH);
    const fetchMock = stubXaiFetch();

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error:
        "xAI sign-in could not be refreshed: refresh_failed: HTTP 401. Run `opencode auth login xai`.",
    });
    await expect(resolveXaiAuthIdentity()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not refresh, fetch, or write an expired token", async () => {
    vi.mocked(readAuthFile).mockResolvedValueOnce({
      xai: {
        type: "oauth",
        access: "expired-token",
        refresh: "refresh-1",
        expires: Date.now() - 1,
      },
    });
    const fetchMock = stubXaiFetch();

    await expect(queryXaiQuota()).resolves.toEqual({
      success: false,
      error: "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the fresh OAuth entry and sends the Grok Build headers to both endpoints", async () => {
    vi.mocked(readAuthFileCached).mockResolvedValueOnce({
      xai: { type: "oauth", access: "stale-token", expires: Date.now() - 1_000 },
    });
    mockConfiguredAuth();
    const fetchMock = stubXaiFetch(superGrokWeeklyFixture, heavySubscriptionFixture);

    await expect(queryXaiQuota({ requestTimeoutMs: 3_210 })).resolves.toEqual({
      success: true,
      label: "xAI Heavy",
      window: WEEKLY_WINDOW,
    });

    expect(readAuthFileCached).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([CREDITS_URL, SUBSCRIPTIONS_URL]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual({
        method: "GET",
        headers: {
          Authorization: "Bearer token-1",
          Accept: "application/json",
          "User-Agent": "OpenCode-Quota-Toast/1.0",
          "x-grok-client-surface": "grok-build",
          "x-grok-client-version": "1.0.0",
        },
        signal: expect.any(AbortSignal),
      });
    }
  });

  it.each([
    ["Lite", activeSubscription("_LITE"), "xAI Lite"],
    ["standard SuperGrok", activeSubscription(""), "xAI SuperGrok"],
    ["PRO without a Heavy offer", activeSubscription("_PRO"), "xAI SuperGrok"],
    ["Heavy tier", activeSubscription("_HEAVY"), "xAI Heavy"],
    ["Heavy offer", heavySubscriptionFixture, "xAI Heavy"],
  ])("labels %s subscription evidence as %s", async (_name, subscriptions, label) => {
    mockConfiguredAuth();
    stubXaiFetch(superGrokWeeklyFixture, subscriptions);

    await expect(queryXaiQuota()).resolves.toEqual({ success: true, label, window: WEEKLY_WINDOW });
  });

  it.each([
    ["an empty subscription list", { subscriptions: [] }],
    [
      "an inactive subscription",
      { subscriptions: [{ tier: "SUBSCRIPTION_TIER_SUPER_GROK_LITE", status: "INACTIVE" }] },
    ],
    ["an unknown tier", activeSubscription("_PLUS")],
    ["a misleading Heavy offer prefix", activeSubscription("_PRO", "not-heavy-p3m-30-may2026")],
    [
      "a Heavy offer with an unverified suffix",
      activeSubscription("_PRO", "heavy-p3m-30-may2026-extra"),
    ],
    ["a changed root shape", { subscription: [] }],
    ["a subscription HTTP error", async () => new Response("denied token-1", { status: 403 })],
    ["a subscription JSON error", async () => new Response("not json", { status: 200 })],
    ["a subscription network error", async () => Promise.reject(new Error("failed for token-1"))],
  ])("keeps the standard label and the credits window for %s", async (_name, subscriptions) => {
    mockConfiguredAuth();
    stubXaiFetch(superGrokWeeklyFixture, subscriptions);

    await expect(queryXaiQuota()).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window: WEEKLY_WINDOW,
    });
  });

  it.each([
    [5_000, 2_000],
    [750, 750],
  ])("caps subscription metadata at %i ms with an effective timeout of %i ms", async (requestTimeoutMs, effectiveTimeoutMs) => {
    vi.useFakeTimers();
    mockConfiguredAuth();
    const fetchMock = stubXaiFetch(superGrokWeeklyFixture, hang);

    const resultPromise = queryXaiQuota({ requestTimeoutMs });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(effectiveTimeoutMs);

    await expect(resultPromise).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window: WEEKLY_WINDOW,
    });
  });

  it.each([
    [
      "an omitted protobuf percentage as 0% used when a period exists",
      {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-07-20T02:24:00.983423+00:00",
        },
      },
      { percentRemaining: 100, resetTimeIso: "2026-07-20T02:24:00.983Z", kind: "weekly" },
    ],
    [
      "explicit current-period start, observation, and end evidence",
      {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T00:00:00Z",
          end: "2026-07-20T00:00:00Z",
        },
        creditUsagePercent: 25,
      },
      {
        percentRemaining: 75,
        resetTimeIso: "2026-07-20T00:00:00.000Z",
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2026-07-13T00:00:00.000Z",
          observedAtIso: "2026-07-15T12:00:00.000Z",
          endsAtIso: "2026-07-20T00:00:00.000Z",
          fullReset: true,
        },
        kind: "weekly",
      },
    ],
    [
      "the billingPeriodEnd reset fallback",
      {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
        creditUsagePercent: 25,
        billingPeriodEnd: "2026-08-01T00:00:00Z",
      },
      { percentRemaining: 75, resetTimeIso: "2026-08-01T00:00:00.000Z", kind: "monthly" },
    ],
  ])("parses %s", async (_name, config, window) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    mockConfiguredAuth();
    stubXaiFetch({ config });

    await expect(queryXaiQuota()).resolves.toEqual({
      success: true,
      label: "xAI SuperGrok",
      window,
    });
  });

  it.each([
    [
      {
        config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }, creditUsagePercent: "100" },
      },
      "xAI credits response returned an invalid usage percentage",
    ],
    [[], "xAI credits response returned an unexpected response shape"],
    // Missing period data is reported instead of inventing quota.
    [{ config: { currentPeriod: {} } }, "No weekly quota data"],
  ])("rejects the credits payload %j", async (credits, error) => {
    mockConfiguredAuth();
    stubXaiFetch(credits);

    await expect(queryXaiQuota()).resolves.toEqual({ success: false, error });
  });

  it.each([
    [
      "bounds and sanitizes HTTP errors",
      async () => new Response(`denied\u001b[31m token-1 ${"x".repeat(300)}`, { status: 401 }),
      /^xAI API error 401: denied \[redacted\] x+$/,
    ],
    [
      "sanitizes network errors",
      async () => Promise.reject(new Error("socket failed for token-1\u001b[31m")),
      /^socket failed for \[redacted\]$/,
    ],
    ["returns the normalized timeout error", hang, /^Request timeout after 1s$/],
  ])("%s without exposing the bearer token", async (_name, credits, error) => {
    vi.useFakeTimers();
    mockConfiguredAuth();
    const fetchMock = stubXaiFetch(credits);

    const resultPromise = queryXaiQuota({ requestTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result).toEqual({ success: false, error: expect.stringMatching(error) });
    expect(result && !result.success ? result.error.length : 0).toBeLessThanOrEqual(180);
    // The subscription label is only fetched after quota succeeds.
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

it("labels each period kind", () => {
  expect((["weekly", "monthly", "daily", "period"] as const).map(periodKindLabel)).toEqual([
    "Weekly",
    "Monthly",
    "Daily",
    "Period",
  ]);
});
