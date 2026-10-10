/**
 * The API-key vendors (Chutes, Synthetic, Ollama Cloud, DeepSeek, Kilo, NanoGPT, OpenRouter)
 * through their public `fetch`, with a key in the environment and fake HTTP replies.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { legacyResultFromFetch } from "../src/core/rows.js";
import type { QuotaProvider } from "../src/lib/entries.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { chutesProvider } from "../src/providers/chutes.js";
import type { ProviderFetchResult } from "../src/providers/contract.js";
import { deepseekProvider } from "../src/providers/deepseek.js";
import { kiloProvider } from "../src/providers/kilo.js";
import { nanoGptProvider } from "../src/providers/nanogpt.js";
import { ollamaCloudProvider } from "../src/providers/ollama-cloud.js";
import { openRouterProvider } from "../src/providers/openrouter.js";
import { syntheticProvider } from "../src/providers/synthetic.js";
import {
  fakeHttp,
  fetchRows,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";

vi.mock("../src/lib/provider-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/provider-availability.js")>()),
  isCanonicalProviderAvailable: vi.fn(),
}));

const VENDORS = {
  chutes: { provider: chutesProvider, keyEnv: "CHUTES_API_KEY" },
  synthetic: { provider: syntheticProvider, keyEnv: "SYNTHETIC_API_KEY" },
  "ollama-cloud": { provider: ollamaCloudProvider, keyEnv: "OLLAMA_API_KEY" },
  deepseek: { provider: deepseekProvider, keyEnv: "DEEPSEEK_API_KEY" },
  kilo: { provider: kiloProvider, keyEnv: "KILO_API_KEY" },
  nanogpt: { provider: nanoGptProvider, keyEnv: "NANOGPT_API_KEY" },
  openrouter: { provider: openRouterProvider, keyEnv: "OPENROUTER_API_KEY" },
} as const;
type VendorId = keyof typeof VENDORS;
const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];

const KEY = "test-key";

function setKey(id: VendorId): void {
  process.env[VENDORS[id].keyEnv] = KEY;
}

/** A reply for every request, or a function of the URL that returns one. */
type Reply = unknown;

/** Answers each request with the reply of the first URL part it contains. */
function byUrl(replies: Record<string, Reply>) {
  return (url: string) => {
    const part = Object.keys(replies).find((candidate) => url.includes(candidate));
    if (part === undefined) throw new Error(`unexpected request ${url}`);
    return replies[part];
  };
}

/** A JSON reply with a JSON content type (OpenRouter checks it). */
function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** What one fetch shows: the row summaries, the error code and the "error" debug lines. */
async function fetchSummary(provider: Pick<QuotaProvider, "id" | "fetch">, reply: Reply) {
  fakeHttp((url) => (typeof reply === "function" ? reply(url) : reply));
  const fetched = await fetchRows(provider);
  return {
    rows: rowSummary(fetched.rows),
    error: fetched.error?.code ?? null,
    errorLines: fetched.debug.filter((item) => item.key === "error").map((item) => item.value),
  };
}

type VendorCase = {
  name: string;
  reply: Reply;
  rows: unknown[];
  error?: string;
  errorLines?: string[];
};

/** One `it` per case: the vendor's key is set and every request gets the case's reply. */
function describeVendor(id: VendorId, cases: VendorCase[]): void {
  describe(id, () => {
    it.each(cases)("$name", async ({ reply, rows, error = null, errorLines = [] }) => {
      setKey(id);
      expect(await fetchSummary(VENDORS[id].provider, reply)).toEqual({ rows, error, errorLines });
    });
  });
}

useProviderWorld();

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-01-01T12:00:00.000Z"), toFake: ["Date"] });
});

describe("every API-key vendor", () => {
  it.each(VENDOR_IDS)("%s without a key is not configured and sends nothing", async (id) => {
    const http = fakeHttp(() => {
      throw new Error("no request expected");
    });

    const fetched = await fetchRows(VENDORS[id].provider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toEqual({ code: "not_configured" });
    expect(http).not.toHaveBeenCalled();
  });

  it.each<{
    id: VendorId;
    requests: string[];
    authHeader: string;
    auth: string;
    errorLines: string[];
  }>([
    {
      id: "chutes",
      requests: ["GET https://api.chutes.ai/users/me/quota_usage/me"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["Chutes: Chutes API error 401: Unauthorized"],
    },
    {
      id: "synthetic",
      requests: ["GET https://api.synthetic.new/v2/quotas"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["Synthetic: Synthetic API error 401: Unauthorized"],
    },
    {
      // Ollama takes the key as is, without "Bearer".
      id: "ollama-cloud",
      requests: ["GET https://ollama.com/api/usage"],
      authHeader: "authorization",
      auth: KEY,
      errorLines: ["Ollama Cloud: Ollama Cloud usage API error 401: Unauthorized"],
    },
    {
      id: "deepseek",
      requests: ["GET https://api.deepseek.com/user/balance"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["DeepSeek: DeepSeek API error 401: Unauthorized"],
    },
    {
      // A failed Kilo Pass request does not fall back to the balance.
      id: "kilo",
      requests: [
        "GET https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D",
      ],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["Kilo Gateway: Kilo Gateway state API error 401: Unauthorized"],
    },
    {
      id: "nanogpt",
      requests: [
        "GET https://nano-gpt.com/api/subscription/v1/usage",
        "POST https://nano-gpt.com/api/check-balance",
      ],
      authHeader: "x-api-key",
      auth: KEY,
      errorLines: [
        "NanoGPT: Usage: NanoGPT API error 401: Unauthorized; Balance: NanoGPT API error 401: Unauthorized",
      ],
    },
    {
      id: "openrouter",
      requests: ["GET https://openrouter.ai/api/v1/key"],
      authHeader: "authorization",
      auth: `Bearer ${KEY}`,
      errorLines: ["OpenRouter: HTTP 401"],
    },
  ])("$id sends its key to its endpoint and shows a 401 as login_expired", async (vendor) => {
    setKey(vendor.id);
    const http = fakeHttp(() => new Response("Unauthorized\u001b[31m", { status: 401 }));

    const fetched = await fetchRows(VENDORS[vendor.id].provider);

    expect(http.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual(
      vendor.requests,
    );
    for (const [, init] of http.mock.calls) {
      expect(requestHeader(init, vendor.authHeader)).toBe(vendor.auth);
    }
    expect(fetched.rows).toEqual([]);
    expect(fetched.error?.code).toBe("login_expired");
    expect(fetched.debug.filter((item) => item.key === "error").map((item) => item.value)).toEqual(
      vendor.errorLines,
    );
  });
});

describeVendor("chutes", [
  {
    name: "shows the daily quota left, resetting at the next UTC midnight",
    reply: { quota: 1000, used: 250 },
    rows: [["chutes.daily", null, "Daily", "day", 75, "2026-01-02T00:00:00.000Z"]],
  },
  {
    name: "shows a zero quota as 0% left",
    reply: { quota: 0, used: 0 },
    rows: [["chutes.daily", null, "Daily", "day", 0, "2026-01-02T00:00:00.000Z"]],
  },
  {
    name: "clamps usage above the quota to 0% left",
    reply: { quota: 100, used: 150 },
    rows: [["chutes.daily", null, "Daily", "day", 0, "2026-01-02T00:00:00.000Z"]],
  },
]);

const SYNTHETIC_FIVE_HOUR = {
  max: 100,
  remaining: 74.5,
  nextTickAt: "2026-01-20T18:12:03.000Z",
};

describeVendor("synthetic", [
  {
    name: "shows the 5h and weekly windows",
    reply: {
      rollingFiveHourLimit: SYNTHETIC_FIVE_HOUR,
      weeklyTokenLimit: {
        maxCredits: "$24.00",
        remainingCredits: "$2.02",
        nextRegenAt: "2026-01-27T18:12:03.000Z",
        percentRemaining: 8.4552365,
      },
    },
    rows: [
      ["synthetic.five_hour", null, "5h", "five_hour", 75, "2026-01-20T18:12:03.000Z"],
      ["synthetic.weekly", null, "Weekly", "week", 8, "2026-01-27T18:12:03.000Z"],
    ],
  },
  {
    name: "derives the weekly percent from the credits when the reported one is out of range",
    reply: {
      rollingFiveHourLimit: SYNTHETIC_FIVE_HOUR,
      weeklyTokenLimit: {
        maxCredits: "$24.00",
        remainingCredits: "$6",
        nextRegenAt: "not a date",
        percentRemaining: 150,
      },
    },
    rows: [
      ["synthetic.five_hour", null, "5h", "five_hour", 75, "2026-01-20T18:12:03.000Z"],
      ["synthetic.weekly", null, "Weekly", "week", 25, null],
    ],
  },
  {
    name: "rejects credits without a dollar sign",
    reply: {
      rollingFiveHourLimit: SYNTHETIC_FIVE_HOUR,
      weeklyTokenLimit: { maxCredits: "24.00", remainingCredits: "$2.02", percentRemaining: 8 },
    },
    rows: [],
    error: "bad_response",
    errorLines: ["Synthetic: Synthetic API response missing weeklyTokenLimit quota window"],
  },
  {
    name: "shows an empty reply as no data",
    reply: {},
    rows: [],
    error: "no_data",
    errorLines: ["Synthetic: Synthetic returned no quota data for this account."],
  },
]);

describeVendor("ollama-cloud", [
  {
    name: "shows the session and weekly windows",
    reply: {
      limits: {
        session: { usage: 0.25, models: [{ name: "glm-5.3-flash", request_count: 57 }] },
        weekly: { usage: 0.405 },
      },
    },
    rows: [
      ["ollama-cloud.session", null, "Session", "session", 75, null],
      ["ollama-cloud.weekly", null, "Weekly", "week", 59.5, null],
    ],
  },
  {
    // The monthly-pool plan of issue #289.
    name: "shows a monthly-only pool",
    reply: { activity: { cost: "0.00000", models: [] }, limits: { monthly: { usage: 0.043 } } },
    rows: [["ollama-cloud.monthly", null, "Monthly", "month", 95.7, null]],
  },
  {
    name: "keeps a valid window next to an invalid one and reports the invalid one",
    reply: { limits: { session: { usage: 0.2 }, weekly: { usage: 1.5 } } },
    rows: [["ollama-cloud.session", null, "Session", "session", 80, null]],
    error: "bad_response",
    errorLines: ["Ollama Cloud: Weekly: ignored invalid usage fraction"],
  },
  {
    name: "shows no data when no window has a usable fraction",
    reply: { limits: { session: { usage: -1 }, weekly: { usage: "0.5" }, monthly: { usage: 2 } } },
    rows: [],
    error: "no_data",
    errorLines: ["Ollama Cloud: Ollama Cloud usage API returned no usable usage data"],
  },
]);

describeVendor("deepseek", [
  {
    name: "shows each balance component with its exact decimal",
    reply: {
      is_available: true,
      balance_infos: [
        {
          currency: "USD",
          total_balance: "12.340000000000000001",
          granted_balance: "2.00",
          topped_up_balance: "10.340000000000000001",
        },
      ],
    },
    rows: [
      ["deepseek.total_balance.usd", null, "Balance", null, "12.340000000000000001 USD", null],
      ["deepseek.granted_balance.usd", null, "Granted", null, "2.00 USD", null],
      [
        "deepseek.topped_up_balance.usd",
        null,
        "Topped up",
        null,
        "10.340000000000000001 USD",
        null,
      ],
    ],
  },
  {
    // Without a total, the availability flag stands in for it.
    name: "keeps valid components and reports malformed decimals instead of reading them as zero",
    reply: {
      is_available: true,
      balance_infos: [
        {
          currency: "USD",
          total_balance: "12.34\u001b[31m",
          granted_balance: "1.2345678901234567890",
          topped_up_balance: "not-a-number",
        },
      ],
    },
    rows: [
      ["deepseek.granted_balance.usd", null, "Granted", null, "1.2345678901234567890 USD", null],
      ["deepseek.available", null, "Available", null, true, null],
    ],
    error: "bad_response",
    errorLines: [
      "DeepSeek USD: total_balance returned an invalid decimal",
      "DeepSeek USD: topped_up_balance returned an invalid decimal",
    ],
  },
  {
    name: "keeps CNY in any case and skips unsupported currencies",
    reply: {
      is_available: true,
      balance_infos: [
        { currency: "EUR", total_balance: "9.99" },
        { currency: "cny", total_balance: "88.00" },
      ],
    },
    rows: [["deepseek.total_balance.cny", null, "Balance", null, "88.00 CNY", null]],
  },
  {
    name: "shows only the availability flag when no balance is reported",
    reply: { is_available: false, balance_infos: [] },
    rows: [["deepseek.available", null, "Available", null, false, null]],
  },
]);

const KILO_STATE = "kiloPass.getState";
const KILO_BALANCE = "profile/balance";

function kiloPassState(subscription: Record<string, unknown> | null) {
  return [{ result: { data: { json: { subscription } } } }];
}

describeVendor("kilo", [
  {
    name: "shows the Kilo Pass credits left of base plus bonus",
    reply: byUrl({
      [KILO_STATE]: kiloPassState({
        currentPeriodBaseCreditsUsd: 16,
        currentPeriodUsageUsd: 5,
        currentPeriodBonusCreditsUsd: 4,
        nextBillingAt: "2099-02-01T00:00:00.000Z",
      }),
    }),
    rows: [
      [
        "kilo.pass_credits",
        null,
        "Pass credits",
        null,
        "75 (5 USD of 20 USD)",
        "2099-02-01T00:00:00.000Z",
      ],
    ],
  },
  {
    name: "shows usage above the pass credits as 0% left",
    reply: byUrl({
      [KILO_STATE]: kiloPassState({ currentPeriodBaseCreditsUsd: 10, currentPeriodUsageUsd: 12 }),
    }),
    rows: [["kilo.pass_credits", null, "Pass credits", null, "0 (12 USD of 10 USD)", null]],
  },
  {
    name: "shows the USD left when the pass has no credits",
    reply: byUrl({
      [KILO_STATE]: kiloPassState({ currentPeriodBaseCreditsUsd: 0, currentPeriodUsageUsd: 0 }),
    }),
    rows: [["kilo.pass_credits", null, "Pass credits", null, "0 USD", null]],
  },
  {
    name: "falls back to the Gateway balance without an active pass",
    reply: byUrl({ [KILO_STATE]: kiloPassState(null), [KILO_BALANCE]: { balance: 8.25 } }),
    rows: [["kilo.balance", null, "Balance", null, "8.25 USD", null]],
  },
  {
    name: "does not hide an invalid pass state behind the balance",
    reply: byUrl({
      [KILO_STATE]: kiloPassState({ currentPeriodBaseCreditsUsd: -1, currentPeriodUsageUsd: 0 }),
    }),
    rows: [],
    error: "bad_response",
    errorLines: [
      "Kilo Gateway: Kilo Gateway state API returned invalid currentPeriodBaseCreditsUsd",
    ],
  },
  {
    name: "reports a failed balance fallback with the key redacted",
    reply: byUrl({
      [KILO_STATE]: kiloPassState(null),
      [KILO_BALANCE]: new Response(`down ${KEY}\u001b[31m`, { status: 503 }),
    }),
    rows: [],
    error: "no_plan",
    errorLines: [
      "Kilo Gateway: Kilo Gateway has no active Kilo Pass subscription; balance fallback failed: Kilo Gateway balance API error 503: down [redacted]",
    ],
  },
]);

const NANOGPT_USAGE = "subscription/v1/usage";
const NANOGPT_BALANCE = "check-balance";

describeVendor("nanogpt", [
  {
    name: "shows the daily and monthly requests and the USD balance",
    reply: byUrl({
      [NANOGPT_USAGE]: {
        active: true,
        state: "active",
        limits: { daily: 5000, monthly: 60000 },
        daily: { used: 50, remaining: 4950, percentUsed: 0.01, resetAt: 1_738_540_800_000 },
        monthly: { used: 1000, remaining: 59000, resetAt: 1_739_404_800_000 },
      },
      [NANOGPT_BALANCE]: { usd_balance: "129.46956147", nano_balance: "26.71801147" },
    }),
    rows: [
      [
        "nanogpt.daily",
        null,
        "Daily",
        "day",
        "99 (50 request of 5000 request)",
        "2025-02-03T00:00:00.000Z",
      ],
      [
        "nanogpt.monthly",
        null,
        "Monthly",
        "month",
        "98 (1000 request of 60000 request)",
        "2025-02-13T00:00:00.000Z",
      ],
      ["nanogpt.balance.usd", null, "Balance", null, "129.46956147 USD", null],
    ],
  },
  {
    name: "keeps the usage when the balance fails and reports a subscription in grace",
    reply: byUrl({
      [NANOGPT_USAGE]: {
        active: false,
        state: "grace",
        limits: { daily: 100 },
        daily: { used: 100, remaining: 0, resetAt: 1_735_776_000_000 },
      },
      [NANOGPT_BALANCE]: new Response("Unauthorized", { status: 401 }),
    }),
    rows: [
      [
        "nanogpt.daily",
        null,
        "Daily",
        "day",
        "0 (100 request of 100 request)",
        "2025-01-02T00:00:00.000Z",
      ],
    ],
    error: "login_expired",
    errorLines: [
      "NanoGPT Balance: NanoGPT API error 401: Unauthorized",
      "NanoGPT: Subscription state: grace",
    ],
  },
  {
    name: "keeps a valid NANO balance when usage fails and the USD decimal is malformed",
    reply: byUrl({
      [NANOGPT_USAGE]: new Response("bad gateway", { status: 502 }),
      [NANOGPT_BALANCE]: { usd_balance: "12junk", nano_balance: "26.71801147" },
    }),
    rows: [["nanogpt.balance.nano", null, "Balance", null, "26.71801147 NANO", null]],
    error: "provider_error",
    errorLines: [
      "NanoGPT Usage: NanoGPT API error 502: bad gateway",
      "NanoGPT Balance: NanoGPT balance response returned an invalid usd_balance decimal",
    ],
  },
  {
    // The limit is derived from used + remaining here, so the row does not report it.
    name: "reports only the counts NanoGPT gave",
    reply: byUrl({
      [NANOGPT_USAGE]: { active: true, state: "active", daily: { used: 25, remaining: 75 } },
      [NANOGPT_BALANCE]: { usd_balance: "12.50" },
    }),
    rows: [
      ["nanogpt.daily", null, "Daily", "day", "75 (25 request of ?)", null],
      ["nanogpt.balance.usd", null, "Balance", null, "12.50 USD", null],
    ],
  },
]);

it("nanogpt marks a failure of both endpoints retryable when one of them may recover", async () => {
  setKey("nanogpt");
  fakeHttp(
    byUrl({
      [NANOGPT_USAGE]: new Response("bad gateway", { status: 502 }),
      [NANOGPT_BALANCE]: new Response("Unauthorized", { status: 401 }),
    }),
  );

  const result = await nanoGptProvider.fetch({ config: { requestTimeoutMs: 5_000 } } as never);

  expect(legacyResultFromFetch(result as ProviderFetchResult).errors).toEqual([
    {
      label: "NanoGPT",
      message:
        "Usage: NanoGPT API error 502: bad gateway; Balance: NanoGPT API error 401: Unauthorized",
      retryable: true,
    },
  ]);
});

describeVendor("openrouter", [
  {
    name: "shows a key with a limit as the budget left",
    reply: () => jsonReply({ data: { usage: 2, limit: 10, limit_remaining: 8 } }),
    rows: [["openrouter.key", null, "Budget", null, 80, null]],
  },
  {
    // `limit_remaining` covers the limit window; `usage` is the key's lifetime total.
    name: "reads the budget left from limit_remaining, not lifetime usage",
    reply: () => jsonReply({ data: { usage: 50, limit: 10, limit_remaining: 7.5 } }),
    rows: [["openrouter.key", null, "Budget", null, 75, null]],
  },
  {
    name: "shows a key without a limit as its spend",
    reply: () => jsonReply({ data: { usage: 3.5, limit: null, limit_remaining: null } }),
    rows: [["openrouter.key", null, "Spend", null, "$3.50", null]],
  },
  {
    name: "rejects more left than the limit",
    reply: () => jsonReply({ data: { usage: 1, limit: 10, limit_remaining: 11 } }),
    rows: [],
    error: "bad_response",
    errorLines: ["OpenRouter: Invalid openrouter-key-v1 response"],
  },
]);

describe("availability and model matching", () => {
  // Chutes, Synthetic and DeepSeek also count a configured OpenCode provider; the rest need a key.
  it.each<[VendorId, boolean, boolean, boolean]>([
    ["chutes", true, false, true],
    ["chutes", false, true, true],
    ["chutes", false, false, false],
    ["synthetic", true, false, true],
    ["synthetic", false, true, true],
    ["deepseek", true, false, true],
    ["deepseek", false, true, true],
    ["ollama-cloud", true, false, false],
    ["ollama-cloud", false, true, true],
    ["kilo", true, false, false],
    ["kilo", false, true, true],
    ["nanogpt", true, false, false],
    ["nanogpt", false, true, true],
    ["openrouter", true, false, false],
    ["openrouter", false, true, true],
  ])("%s with an OpenCode provider %s and a key %s is available: %s", async (id, configured, withKey, expected) => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(configured);
    if (withKey) setKey(id);

    await expect(VENDORS[id].provider.isAvailable({} as never)).resolves.toBe(expected);
  });

  it.each<[VendorId, string, boolean]>([
    ["chutes", "chutes/deepseek-ai/DeepSeek-V3", true],
    ["synthetic", "synthetic/claude", true],
    ["deepseek", "deepseek/deepseek-chat", true],
    ["ollama-cloud", "ollama-cloud/gpt-oss:20b-cloud", true],
    ["ollama-cloud", "OLLAMA-CLOUD/gpt-oss:120b-cloud", true],
    ["ollama-cloud", "ollama/gpt-oss", false],
    ["kilo", "kilo/anthropic/claude-sonnet-4", true],
    ["kilo", "kilo-gateway/model", false],
    ["nanogpt", "nanogpt/gpt-oss-120b", true],
    ["nanogpt", "nano-gpt/gpt-5", true],
    ["openrouter", "openrouter/anthropic/claude", true],
    ...VENDOR_IDS.map((id): [VendorId, string, boolean] => [id, "openai/gpt-5", false]),
  ])("%s matches the model %s: %s", (id, model, expected) => {
    expect(VENDORS[id].provider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
