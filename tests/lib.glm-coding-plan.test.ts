import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GLM_ENDPOINTS, queryGlmCodingPlanQuota } from "../src/lib/glm-coding-plan.js";

function queryZaiQuota(options: { requestTimeoutMs?: number; apiKey?: string } = {}) {
  return queryGlmCodingPlanQuota(GLM_ENDPOINTS.zai, options);
}

function queryZhipuQuota(options: { requestTimeoutMs?: number; apiKey?: string } = {}) {
  return queryGlmCodingPlanQuota(GLM_ENDPOINTS.zhipu, options);
}

const mocks = vi.hoisted(() => ({
  resolveZaiAuthCached: vi.fn(),
  resolveZhipuAuthCached: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  resolveApiKeyLogin: (spec: { displayName: string }) =>
    spec.displayName === "Z.ai" ? mocks.resolveZaiAuthCached() : mocks.resolveZhipuAuthCached(),
}));

const providers = [
  {
    label: "Z.ai",
    endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
    httpErrorPrefix: "Z.ai API error",
    key: "zai-test-key",
    resolveAuth: mocks.resolveZaiAuthCached,
    query: queryZaiQuota,
  },
  {
    label: "Zhipu",
    endpoint: "https://bigmodel.cn/api/monitor/usage/quota/limit",
    httpErrorPrefix: "Zhipu API error",
    key: "zhipu-test-key",
    resolveAuth: mocks.resolveZhipuAuthCached,
    query: queryZhipuQuota,
  },
] as const;

type ProviderCase = (typeof providers)[number];

function configure(provider: ProviderCase): void {
  provider.resolveAuth.mockResolvedValueOnce({
    state: "configured",
    apiKey: provider.key,
    source: "opencode.db",
  });
}

function quotaResponse(limits: unknown): object {
  return { code: 0, msg: "ok", success: true, data: { level: "pro", limits } };
}

function stubJson(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock as any);
  return fetchMock;
}

/** For bodies JSON cannot carry, such as Infinity and NaN. */
function stubParsedJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body }) as Response),
  );
}

function credit(fields: Record<string, number>) {
  return { type: "CREDIT_LIMIT", unit: 3, ...fields };
}

beforeEach(() => {
  mocks.resolveZaiAuthCached.mockReset();
  mocks.resolveZhipuAuthCached.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GLM coding plan quota contract", () => {
  it("preserves unconfigured and invalid auth behavior", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const provider of providers) {
      provider.resolveAuth.mockResolvedValueOnce({ state: "none" });
      await expect(provider.query(), `${provider.label} missing auth`).resolves.toBeNull();

      const error = `Unsupported ${provider.label} auth type: "oauth"`;
      provider.resolveAuth.mockResolvedValueOnce({ state: "invalid", error });
      await expect(provider.query(), `${provider.label} invalid auth`).resolves.toEqual({
        success: false,
        error,
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses each explicit endpoint, auth resolver, header contract, and label", async () => {
    for (const provider of providers) {
      configure(provider);
      const fetchMock = stubJson(quotaResponse([]));

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: true,
        label: provider.label,
        windows: {},
      });
      expect(fetchMock, `${provider.label} request`).toHaveBeenCalledWith(
        provider.endpoint,
        expect.objectContaining({
          headers: {
            Authorization: provider.key,
            "User-Agent": "OpenCode-Quota-Toast/1.0",
            "Content-Type": "application/json",
          },
          signal: expect.any(AbortSignal),
        }),
      );
    }
  });

  it("sanitizes and truncates HTTP error bodies with provider-specific prefixes", async () => {
    const unsafeBody = `\u001b[31m${"x".repeat(200)}`;

    for (const provider of providers) {
      configure(provider);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(unsafeBody, { status: 500 })) as any);

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: false,
        error: `${provider.httpErrorPrefix} 500: ${"x".repeat(120)}`,
      });
    }
  });

  it("rejects missing or non-array limit envelopes", async () => {
    for (const provider of providers) {
      for (const limits of [null, {}]) {
        configure(provider);
        stubJson(quotaResponse(limits));
        await expect(provider.query(), `${provider.label} ${limits}`).resolves.toEqual({
          success: false,
          error: "Invalid quota data",
        });
      }
    }
  });

  it("maps windows, ignores daily units in either order, clamps, and keeps later duplicates", async () => {
    const resetMs = 1_735_776_000_000;
    const limits = [
      { type: "TOKENS_LIMIT", unit: 4, percentage: 10, nextResetTime: resetMs },
      { type: "TOKENS_LIMIT", unit: 3, percentage: 120, nextResetTime: resetMs },
      { type: "TOKENS_LIMIT", unit: 6, percentage: 70, nextResetTime: resetMs },
      { type: "TOKENS_LIMIT", unit: 4, percentage: 90, nextResetTime: resetMs },
      { type: "TIME_LIMIT", unit: 9, percentage: 10, nextResetTime: -1 },
      { type: "TOKENS_LIMIT", unit: 3, percentage: -20, nextResetTime: resetMs + 0.4 },
    ];

    for (const provider of providers) {
      configure(provider);
      stubJson(quotaResponse(limits));

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: true,
        label: provider.label,
        windows: {
          fiveHour: { percentRemaining: 100, resetTimeIso: new Date(resetMs).toISOString() },
          weekly: { percentRemaining: 30, resetTimeIso: new Date(resetMs).toISOString() },
          mcp: { percentRemaining: 90, resetTimeIso: undefined },
        },
      });
    }
  });

  it("sanitizes network failures and preserves timeout behavior", async () => {
    for (const provider of providers) {
      configure(provider);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("\u001b[31mnetwork down"))) as any,
      );
      await expect(provider.query(), `${provider.label} network`).resolves.toEqual({
        success: false,
        error: "network down",
      });

      vi.useFakeTimers();
      configure(provider);
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})) as any);
      const result = provider.query({ requestTimeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result, `${provider.label} timeout`).resolves.toEqual({
        success: false,
        error: "Request timeout after 1s",
      });
      vi.useRealTimers();
    }
  });
});

describe("provider-specific GLM envelopes", () => {
  it.each([
    [
      { code: 500, msg: "\u001b[31mcurrent user has no coding plan", success: false },
      "current user has no coding plan",
    ],
    [{ code: 401 }, "Z.ai API error 401"],
    [{ success: false }, "Z.ai API error"],
  ])("preserves the Z.ai API-level error in %j", async (body, error) => {
    configure(providers[0]);
    stubJson(body);
    await expect(queryZaiQuota()).resolves.toEqual({ success: false, error });
  });

  it("maps credit limits to percent windows for both providers without inferring credit amounts", async () => {
    const resetMs = 1_735_776_000_000;
    const creditLimits = [
      credit({
        number: 1,
        usage: 12_000,
        currentValue: 569,
        remaining: 11_430,
        percentage: 4,
        nextResetTime: resetMs,
      }),
      credit({
        unit: 6,
        number: 1,
        usage: 60_000,
        currentValue: 569,
        remaining: 59_430,
        percentage: 1,
        nextResetTime: resetMs + 1_000,
      }),
    ];

    for (const provider of providers) {
      configure(provider);
      stubJson(quotaResponse(creditLimits));
      await expect(provider.query(), provider.label).resolves.toEqual({
        success: true,
        label: provider.label,
        windows: {
          fiveHour: { percentRemaining: 95, resetTimeIso: new Date(resetMs).toISOString() },
          weekly: { percentRemaining: 99, resetTimeIso: new Date(resetMs + 1_000).toISOString() },
        },
      });
    }
  });

  it.each([
    // Exact credit values missing or unusable: the reported percentage is used.
    ["missing current value", credit({ usage: 12_000, percentage: 4 }), 96],
    ["zero usage", credit({ usage: 0, currentValue: 569, percentage: 11 }), 89],
    ["negative usage", credit({ usage: -12_000, currentValue: 569, percentage: 12 }), 88],
    ["negative current value", credit({ usage: 12_000, currentValue: -1, percentage: 13 }), 87],
    ["non-finite usage", credit({ usage: Infinity, currentValue: 569, percentage: 14 }), 86],
    ["non-finite current value", credit({ usage: 12_000, currentValue: NaN, percentage: 15 }), 85],
    ["non-finite fallback percentage", credit({ usage: 12_000, percentage: Infinity }), 0],
    // Exact credit values are clamped.
    ["credit use above the limit", credit({ usage: 100, currentValue: 150, percentage: 25 }), 0],
    ["no credit used", credit({ usage: 100, currentValue: 0, percentage: 25 }), 100],
    // Token limits always use the reported percentage.
    [
      "a token limit",
      { ...credit({ usage: 12_000, currentValue: 569, percentage: 4 }), type: "TOKENS_LIMIT" },
      96,
    ],
  ])("gives both providers the right 5h percent for %s", async (_name, limit, expected) => {
    for (const provider of providers) {
      configure(provider);
      stubParsedJson(quotaResponse([limit]));

      await expect(provider.query(), provider.label).resolves.toEqual({
        success: true,
        label: provider.label,
        windows: { fiveHour: { percentRemaining: expected, resetTimeIso: undefined } },
      });
    }
  });

  it("allows Z.ai root limits but keeps Zhipu strict to data.limits", async () => {
    const rootEnvelope = {
      code: 0,
      msg: "ok",
      success: true,
      limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 25 }],
    };

    configure(providers[0]);
    stubJson(rootEnvelope);
    await expect(queryZaiQuota()).resolves.toEqual({
      success: true,
      label: "Z.ai",
      windows: { weekly: { percentRemaining: 75, resetTimeIso: undefined } },
    });

    configure(providers[1]);
    stubJson(rootEnvelope);
    await expect(queryZhipuQuota()).resolves.toEqual({
      success: false,
      error: "Invalid quota data",
    });
  });
});
