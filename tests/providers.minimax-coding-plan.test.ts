import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
    isAnyProviderIdAvailable: vi.fn(),
    isCanonicalProviderAvailable: vi.fn(),
    resolveMiniMaxAuthCached: vi.fn(),
    resolveMiniMaxChinaAuthCached: vi.fn(),
  };
});

vi.mock("../src/lib/minimax-auth.js", () => ({
  resolveMiniMaxAuth: vi.fn(),
  resolveMiniMaxChinaAuth: vi.fn(),
  resolveMiniMaxAuthCached: mocks.resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuthCached: mocks.resolveMiniMaxChinaAuthCached,
  getMiniMaxAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  getMiniMaxChinaAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
  DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isAnyProviderIdAvailable: mocks.isAnyProviderIdAvailable,
  isCanonicalProviderAvailable: mocks.isCanonicalProviderAvailable,
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import {
  minimaxChinaCodingPlanProvider,
  minimaxCodingPlanProvider,
  queryMiniMaxQuota,
} from "../src/providers/minimax-coding-plan.js";

type ModelOverrides = Partial<{
  model_name: string;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  remains_time: number;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  weekly_remains_time: number;
  current_interval_remaining_percent: unknown;
  current_weekly_remaining_percent: unknown;
}>;

function createCodingPlanModel(overrides: ModelOverrides = {}) {
  return {
    model_name: "MiniMax-M*",
    current_interval_total_count: 4500,
    current_interval_usage_count: 4430,
    remains_time: 13_987_604,
    current_weekly_total_count: 45_000,
    current_weekly_usage_count: 44_895,
    weekly_remains_time: 564_787_604,
    ...overrides,
  };
}

/** A model row without any weekly fields. */
function fiveHourOnlyModel(overrides: ModelOverrides = {}) {
  return createCodingPlanModel({
    current_weekly_total_count: undefined,
    current_weekly_usage_count: undefined,
    weekly_remains_time: undefined,
    ...overrides,
  });
}

function mockMiniMaxAuthConfigured(apiKey = "test-key") {
  mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
    state: "configured",
    apiKey,
    endpoint: "international",
  });
}

function mockMiniMaxChinaAuthConfigured(apiKey = "china-key") {
  mocks.resolveMiniMaxChinaAuthCached.mockResolvedValueOnce({
    state: "configured",
    apiKey,
    endpoint: "china",
  });
}

function mockMiniMaxHttpSuccess(models: unknown[]) {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      model_remains: models,
      base_resp: { status_code: 0, status_msg: "success" },
    }),
  });
}

/** The entry's percent and its used / limit / remaining request counts. */
function expectCounts(entry: unknown, percentRemaining: number, counts: string[]) {
  const [used, limit, remaining] = counts;
  expect(entry).toMatchObject({
    percentRemaining,
    basis: {
      used: { quantity: { decimal: used } },
      limit: { quantity: { decimal: limit } },
      remaining: { quantity: { decimal: remaining } },
    },
  });
}

async function runProviderFetch() {
  return minimaxCodingPlanProvider.fetch({ config: {} } as any);
}

async function runChinaProviderFetch() {
  return minimaxChinaCodingPlanProvider.fetch({ config: {} } as any);
}

describe("minimax-coding-plan provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when no minimax coding plan is configured", async () => {
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "none" });

    expectNotAttempted(await runProviderFetch());
  });

  it("returns error when minimax auth is invalid", async () => {
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: "Invalid API key",
    });

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "MiniMax Token Plan");
    expect(out.errors[0]?.message).toBe("Invalid API key");
  });

  it("keeps a valid inactive duplicate-label database credential when the active row is invalid", async () => {
    const { getMiniMaxAuthDiagnostics, resolveMiniMaxAuth } = await import(
      "../src/lib/minimax-auth.js"
    );
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (getMiniMaxAuthDiagnostics as any).mockResolvedValueOnce({
      state: "invalid",
      source: "opencode.db",
      checkedPaths: [],
      credentialDatabasePaths: [],
    });
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce({ state: "invalid", error: "empty key" });
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "bad",
        integrationId: "minimax-coding-plan",
        label: "shared",
        active: true,
        value: { key: "" },
      },
      {
        id: "good",
        integrationId: "minimax-coding-plan",
        label: "shared",
        active: false,
        value: { key: "ok" },
      },
    ]);
    (resolveMiniMaxAuth as any).mockImplementation((auth: any) =>
      auth["minimax-coding-plan"].key
        ? { state: "configured", apiKey: "row-key", endpoint: "international" }
        : { state: "invalid", error: "empty key" },
    );
    mockMiniMaxHttpSuccess([createCodingPlanModel()]);

    const out = await runProviderFetch();
    expect(readCredentialRows).toHaveBeenCalledWith(["minimax-coding-plan"], {
      methods: ["key"],
    });
    expect(out.errors).toContainEqual({
      label: "[MiniMax Token Plan shared] (active)",
      message: "empty key",
    });
    expect(out.entries).toContainEqual(
      expect.objectContaining({
        group: "[MiniMax Token Plan shared 2]",
        accounting: expect.objectContaining({ sourceId: "good" }),
      }),
    );
  });

  it("maps MiniMax-M* model to structured five-hour and weekly entries", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      name: "minimax-token-plan-5h",
      group: "MiniMax Token Plan",
      label: "5h:",
      percentRemaining: 98,
      semantic: { metric: { kind: "window", window: "five_hour" } },
      basis: {
        used: {
          quantity: { decimal: "70", unit: { kind: "count", unit: "request" } },
          authority: "locally_derived",
        },
        limit: {
          quantity: { decimal: "4500", unit: { kind: "count", unit: "request" } },
          authority: "provider_reported",
        },
        remaining: {
          quantity: { decimal: "4430", unit: { kind: "count", unit: "request" } },
          authority: "provider_reported",
        },
      },
    });
    expect(out.entries[1]).toMatchObject({
      name: "minimax-token-plan-week",
      group: "MiniMax Token Plan",
      label: "Weekly:",
      percentRemaining: 100,
      semantic: { metric: { kind: "window", window: "week" } },
    });
    expect(out.entries.every((entry) => !("window" in entry))).toBe(true);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        {
          key: "five_hour_usage",
          value: expect.stringMatching(/^percent_remaining=98 reset_at=/u),
        },
        {
          key: "weekly_usage",
          value: expect.stringMatching(/^percent_remaining=100 reset_at=/u),
        },
      ]),
    );
  });

  it.each([
    {
      provider: minimaxCodingPlanProvider,
      mockAuth: () => mockMiniMaxAuthConfigured("intl-key"),
      url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
      authorization: "Bearer intl-key",
    },
    {
      provider: minimaxChinaCodingPlanProvider,
      mockAuth: () => mockMiniMaxChinaAuthConfigured("china-key"),
      url: "https://api.minimaxi.com/v1/token_plan/remains",
      authorization: "Bearer china-key",
    },
  ])("asks $url with the provider's key", async ({ provider, mockAuth, url, authorization }) => {
    mockAuth();
    mockMiniMaxHttpSuccess([createCodingPlanModel({ model_name: "MiniMax-M2.7" })]);

    expectAttemptedWithNoErrors(await provider.fetch({ config: {} } as any));
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        request: expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: authorization }),
        }),
        timeoutMs: undefined,
        consume: expect.any(Function),
      }),
    );
  });

  it("maps China five-hour-only Token Plan responses without weekly fields", async () => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        model_name: "MiniMax-M2.7",
        current_interval_total_count: 1500,
        current_interval_usage_count: 1200,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "minimax-token-plan-5h",
      group: "MiniMax Token Plan (CN)",
      percentRemaining: 20,
      semantic: { metric: { kind: "window", window: "five_hour" } },
      basis: {
        used: { quantity: { decimal: "1200" }, authority: "provider_reported" },
        limit: { quantity: { decimal: "1500" }, authority: "provider_reported" },
        remaining: { quantity: { decimal: "300" }, authority: "locally_derived" },
      },
    });
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        {
          key: "five_hour_usage",
          value: expect.stringMatching(/^percent_remaining=20 reset_at=/u),
        },
      ]),
    );
    expect(out.statusDetails).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "weekly_usage" })]),
    );
  });

  it.each([
    { rawUsed: 0, remaining: 1500, percentRemaining: 100 },
    { rawUsed: 1500, remaining: 0, percentRemaining: 0 },
    { rawUsed: 13, total: 15000, remaining: 14987, percentRemaining: 100 },
    { rawUsed: 1550, remaining: -50, percentRemaining: -3 },
  ])("normalizes China Token Plan used count $rawUsed", async ({
    rawUsed,
    total = 1500,
    remaining,
    percentRemaining,
  }) => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        model_name: "MiniMax-M2.7",
        current_interval_total_count: total,
        current_interval_usage_count: rawUsed,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expectCounts(out.entries[0], percentRemaining, [
      String(rawUsed),
      String(total),
      String(remaining),
    ]);
  });

  it("selects the lowest-remaining China model using used-count semantics", async () => {
    mockMiniMaxChinaAuthConfigured("china-key");
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        model_name: "MiniMax-M2.7",
        current_interval_total_count: 1500,
        current_interval_usage_count: 100,
      }),
      fiveHourOnlyModel({
        model_name: "MiniMax-M2.7-highspeed",
        current_interval_total_count: 1500,
        current_interval_usage_count: 1400,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expectCounts(out.entries[0], 7, ["1400", "1500", "100"]);
  });

  it("excludes video even when it has the lowest remaining percentage", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        model_name: "general",
        current_interval_total_count: 10,
        current_interval_usage_count: 8,
      }),
      fiveHourOnlyModel({
        model_name: "video",
        current_interval_total_count: 10,
        current_interval_usage_count: 2,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expectCounts(out.entries[0], 80, ["2", "10", "8"]);
  });

  it.each([
    {
      name: "zero-count international rows",
      model: createCodingPlanModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_interval_remaining_percent: 86,
        current_weekly_remaining_percent: 90,
      }),
      percents: [86, 90],
    },
    {
      name: "missing count fields",
      model: {
        model_name: "general",
        remains_time: 13_987_604,
        weekly_remains_time: 564_787_604,
        current_interval_remaining_percent: 75,
        current_weekly_remaining_percent: 80,
      },
      percents: [75, 80],
    },
  ])("falls back to provider-reported percentages for $name", async ({ model, percents }) => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([model]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "minimax-coding-plan")).toMatchObject(
      percents.map((percentRemaining) => ({ percentRemaining })),
    );
    expect(out.entries.every((entry) => !("basis" in entry))).toBe(true);
  });

  it.each([
    { name: "zero", value: 0, percentRemaining: 0 },
    { name: "negative", value: -25, percentRemaining: -25 },
    { name: "above 100", value: 140, percentRemaining: 100 },
    { name: "missing", value: undefined, percentRemaining: undefined },
    { name: "wrong type", value: "50", percentRemaining: undefined },
  ])("handles a $name international fallback percentage", async ({ value, percentRemaining }) => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        model_name: "general",
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: value,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toMatchObject(percentRemaining === undefined ? [] : [{ percentRemaining }]);
    expect(out.entries.every((entry) => !("basis" in entry))).toBe(true);
  });

  it.each([
    {
      name: "international",
      mockAuth: () => mockMiniMaxAuthConfigured(),
      fetch: runProviderFetch,
      percentRemaining: 25,
      used: "75",
      remaining: "25",
    },
    {
      name: "CN",
      mockAuth: () => mockMiniMaxChinaAuthConfigured(),
      fetch: runChinaProviderFetch,
      percentRemaining: 75,
      used: "25",
      remaining: "75",
    },
  ])("keeps valid $name general counts authoritative over provider percentages", async ({
    mockAuth,
    fetch,
    percentRemaining,
    used,
    remaining,
  }) => {
    mockAuth();
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        model_name: "general",
        current_interval_total_count: 100,
        current_interval_usage_count: 25,
        current_interval_remaining_percent: 90,
      }),
    ]);

    const out = await fetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expectCounts(out.entries[0], percentRemaining, [used, "100", remaining]);
  });

  it("does not apply the international percentage fallback to China endpoint counts", async () => {
    mockMiniMaxChinaAuthConfigured();
    mockMiniMaxHttpSuccess([
      fiveHourOnlyModel({
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 80,
      }),
    ]);

    const out = await runChinaProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(0);
  });

  it("uses provider percentages for CN general rows and excludes video rows", async () => {
    mockMiniMaxHttpSuccess([
      {
        model_name: "general",
        remains_time: 13_987_604,
        weekly_remains_time: 564_787_604,
        current_interval_remaining_percent: 33,
        current_weekly_remaining_percent: 46,
      },
      fiveHourOnlyModel({
        model_name: "video",
        current_interval_total_count: 100,
        current_interval_usage_count: 99,
      }),
    ]);

    const out = await queryMiniMaxQuota("china-key", { endpoint: "china" });

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toMatchObject([
      {
        name: "minimax-token-plan-5h",
        percentRemaining: 33,
        semantic: { metric: { kind: "window", window: "five_hour" } },
      },
      {
        name: "minimax-token-plan-week",
        percentRemaining: 46,
        semantic: { metric: { kind: "window", window: "week" } },
      },
    ]);
    expect(out.entries.every((entry) => !("basis" in entry))).toBe(true);
  });

  it("preserves negative remaining percentages when MiniMax reports negative remaining quota", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_usage_count: -50,
        current_weekly_usage_count: -500,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expectCounts(out.entries[0], -1, ["4550", "4500", "-50"]);
    expectCounts(out.entries[1], -1, ["45500", "45000", "-500"]);
  });

  it.each([
    {
      name: "returns empty entries when MiniMax coding-plan windows have zero totals",
      models: [
        createCodingPlanModel({
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_weekly_total_count: 0,
          current_weekly_usage_count: 0,
          remains_time: 46_387_604,
        }),
      ],
    },
    {
      name: "returns empty entries when API returns no models",
      models: [],
    },
    {
      name: "ignores non-coding MiniMax families",
      models: [createCodingPlanModel({ model_name: "MiniMax-Hailuo-2.3-Fast-6s-768p" })],
    },
    {
      name: "ignores non-finite quota values from the API",
      models: [createCodingPlanModel({ current_interval_total_count: Infinity })],
    },
  ])("$name", async ({ models }) => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess(models);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(0);
  });

  it("collapses multiple coding-plan models to one canonical quota record", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_usage_count: 4400,
        current_weekly_usage_count: 44000,
      }),
      createCodingPlanModel({
        model_name: "MiniMax-M2.7-highspeed",
        current_interval_usage_count: 4300,
        current_weekly_usage_count: 44500,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expectCounts(out.entries[0], 96, ["200", "4500", "4300"]);
    expectCounts(out.entries[1], 99, ["500", "45000", "44500"]);
  });

  it("falls back to a concrete coding model when the wildcard row has no quota", async () => {
    mockMiniMaxAuthConfigured();
    mockMiniMaxHttpSuccess([
      createCodingPlanModel({
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        remains_time: 46_387_604,
      }),
      createCodingPlanModel({
        model_name: "MiniMax-M2.7",
        current_interval_usage_count: 4400,
      }),
    ]);

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expectCounts(out.entries[0], 98, ["100", "4500", "4400"]);
    expectCounts(out.entries[1], 100, ["105", "45000", "44895"]);
  });

  it("sanitizes remote response text in API errors", async () => {
    mockMiniMaxAuthConfigured();
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "\u001b[31mUnauthorized\nretry later\u001b[0m",
    });

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "MiniMax Token Plan");
    expect(out.errors[0]?.message).toBe("MiniMax API error 401: Unauthorized retry later");
  });

  it("sanitizes status messages and thrown errors", async () => {
    mockMiniMaxAuthConfigured();
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_remains: [],
        base_resp: {
          status_code: 1001,
          status_msg: `\u001b[31m${"x".repeat(140)}\nretry\u001b[0m`,
        },
      }),
    });

    const statusOut = await runProviderFetch();
    expectAttemptedWithErrorLabel(statusOut, "MiniMax Token Plan");
    expect(statusOut.errors[0]?.message).toBe(
      `MiniMax API error: ${`${"x".repeat(140)} retry`.slice(0, 120)}`,
    );

    mockMiniMaxAuthConfigured();
    mocks.fetchResponse.mockRejectedValueOnce(new Error("network\nfailed"));

    const thrownOut = await runProviderFetch();
    expectAttemptedWithErrorLabel(thrownOut, "MiniMax Token Plan");
    expect(thrownOut.errors[0]?.message).toBe("network failed");
  });

  it.each([
    ["minimax-coding-plan", "minimax/MiniMax-M2.7", undefined, true],
    ["minimax-coding-plan", "minimax/MiniMax-M2.7-highspeed", undefined, true],
    ["minimax-coding-plan", "MINIMAX/MiniMax-M2.7", undefined, true],
    ["minimax-coding-plan", "minimax-coding-plan/MiniMax-M2.7", undefined, true],
    ["minimax-coding-plan", "minimax-cn/MiniMax-M2.7", undefined, false],
    ["minimax-coding-plan", "minimax-cn-coding-plan/MiniMax-M2.7", undefined, false],
    ["minimax-coding-plan", "minimax-china-coding-plan/MiniMax-M2.7", undefined, false],
    ["minimax-coding-plan", "minimax/Hailuo-02", undefined, false],
    ["minimax-coding-plan", "openai/gpt-4", undefined, false],
    ["minimax-china-coding-plan", "minimax/MiniMax-M2.7", undefined, false],
    ["minimax-china-coding-plan", "minimax-cn/MiniMax-M2.7", undefined, true],
    ["minimax-china-coding-plan", "minimax-cn-coding-plan/MiniMax-M2.7", undefined, true],
    ["minimax-china-coding-plan", "minimax-china-coding-plan/MiniMax-M2.7", undefined, true],
    ["minimax-china-coding-plan", "minimax-coding-plan/MiniMax-M2.7", undefined, false],
    ["minimax-china-coding-plan", "minimax/Hailuo-02", undefined, false],
    [
      "minimax-china-coding-plan",
      "minimax/MiniMax-M2.7",
      { enabledProviders: ["minimax-china-coding-plan"] },
      true,
    ],
  ] as const)("%s matchesCurrentModel(%s, %j) -> %s", (providerId, model, context, expected) => {
    const provider =
      providerId === "minimax-coding-plan"
        ? minimaxCodingPlanProvider
        : minimaxChinaCodingPlanProvider;
    expect(provider.matchesCurrentModel?.(model, context as never)).toBe(expected);
  });

  it.each([
    [{ state: "configured", apiKey: "test-key" }, true],
    [{ state: "invalid", error: "Invalid API key" }, true],
    [{ state: "none" }, false],
  ])("isAvailable returns %s for auth state %j", async (authState, expected) => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(true);
    mocks.resolveMiniMaxAuthCached.mockResolvedValueOnce(authState);

    const available = await minimaxCodingPlanProvider.isAvailable({
      config: { enabledProviders: "auto" },
    } as any);
    expect(available).toBe(expected);
  });

  it.each([
    {
      name: "the international provider is not configured",
      provider: minimaxCodingPlanProvider,
      enabledProviders: "auto",
      expected: false,
    },
    {
      name: "China uses the ambiguous minimax id in auto mode",
      provider: minimaxChinaCodingPlanProvider,
      enabledProviders: "auto",
      expected: false,
    },
    {
      name: "China uses the ambiguous minimax id when explicitly enabled",
      provider: minimaxChinaCodingPlanProvider,
      enabledProviders: ["minimax-china-coding-plan"],
      expected: true,
    },
  ])("isAvailable is $expected when $name", async ({ provider, enabledProviders, expected }) => {
    mocks.isCanonicalProviderAvailable.mockResolvedValue(false);
    mocks.isAnyProviderIdAvailable.mockResolvedValue(true);
    const configured = { state: "configured", apiKey: "test-key" };
    mocks.resolveMiniMaxAuthCached.mockResolvedValue(configured);
    mocks.resolveMiniMaxChinaAuthCached.mockResolvedValue(configured);

    await expect(provider.isAvailable({ config: { enabledProviders } } as any)).resolves.toBe(
      expected,
    );
  });
});
