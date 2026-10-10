// Gemini CLI quota parsing. The OAuth flow it shares with Google AGY is in lib.google-agy.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
  fetchResponse: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({ readAuthFileCached: mocks.readAuthFileCached }));
vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    url: string,
    options: { request: RequestInit; consume: (response: unknown) => Promise<unknown> },
  ) => options.consume(await mocks.fetchResponse(url, options.request)),
}));
vi.mock("../src/lib/google-token-cache.js", () => ({
  makeAccountCacheKey: () => "cache-key",
  getCachedAccessToken: async () => ({ accessToken: "cached-access-token" }),
  setCachedAccessToken: async () => undefined,
}));
vi.mock("../src/lib/google-companion-credentials.js", () => ({
  geminiCliCompanion: {
    resolveCredentials: async () => ({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
  },
}));

import { queryGeminiCliQuota } from "../src/lib/google-gemini-cli.js";

function quotaResponse(buckets: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ buckets }) };
}

describe("Gemini CLI quota buckets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set, so the configured-project lookup never reads a real OpenCode config.
    vi.stubEnv("OPENCODE_GEMINI_PROJECT_ID", "env-project");
  });

  it("aggregates known Gemini CLI buckets by quality tier and keeps unknown models", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      google: {
        type: "oauth",
        refresh: "refresh-token|project-1|",
        email: "alice@example.com",
      },
    });
    mocks.fetchResponse.mockResolvedValueOnce(
      quotaResponse([
        {
          modelId: "gemini-3.1-pro-preview",
          remainingFraction: 0.8,
          resetTime: "2026-01-01T10:00:00.000Z",
          remainingAmount: "100",
          tokenType: "REQUESTS",
        },
        {
          modelId: "gemini-2.5-pro",
          remainingFraction: 0.2,
          resetTime: "2026-01-01T12:00:00.000Z",
          remainingAmount: "50",
          tokenType: "TOKENS",
        },
        {
          modelId: "gemini-2.5-flash",
          remainingFraction: 0.5,
          resetTime: "2026-01-01T08:00:00.000Z",
          remainingAmount: "1000",
          tokenType: "REQUESTS",
        },
        { modelId: "gemini_2_5_flash_lite", remainingFraction: 0.1, remainingAmount: "25" },
        { modelId: "gemini-experimental-foo", remainingFraction: 0.7 },
        { remainingFraction: 0.01 },
      ]),
    );

    await expect(queryGeminiCliQuota()).resolves.toEqual({
      success: true,
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          displayName: "Gemini Pro",
          percentRemaining: 20,
          resetTimeIso: "2026-01-01T12:00:00.000Z",
          remainingAmount: "50",
          tokenType: "TOKENS",
          accountEmail: "alice@example.com",
          sourceKey: "google",
        },
        {
          modelId: "gemini-2.5-flash",
          displayName: "Gemini Flash",
          percentRemaining: 50,
          resetTimeIso: "2026-01-01T08:00:00.000Z",
          remainingAmount: "1000",
          tokenType: "REQUESTS",
          accountEmail: "alice@example.com",
          sourceKey: "google",
        },
        {
          modelId: "gemini_2_5_flash_lite",
          displayName: "Gemini Flash Lite",
          percentRemaining: 10,
          remainingAmount: "25",
          accountEmail: "alice@example.com",
          sourceKey: "google",
        },
        {
          modelId: "gemini-experimental-foo",
          displayName: "Gemini Experimental Foo",
          percentRemaining: 70,
          accountEmail: "alice@example.com",
          sourceKey: "google",
        },
      ],
    });
  });

  it("does not merge Gemini CLI tier buckets across accounts", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-gemini-cli": {
        type: "oauth",
        refresh: "refresh-a|project-a|",
        email: "alice@example.com",
      },
      google: {
        type: "oauth",
        refresh: "refresh-b|project-b|",
        email: "bob@example.com",
      },
    });
    mocks.fetchResponse.mockImplementation(async (_url: string, init: { body?: string }) =>
      quotaResponse([
        {
          modelId: "gemini-2.5-pro",
          remainingFraction: JSON.parse(String(init.body)).project === "project-a" ? 0.9 : 0.1,
        },
      ]),
    );

    const result = await queryGeminiCliQuota();
    if (!result?.success) throw new Error("expected successful Gemini CLI quota result");
    expect(result.buckets).toEqual([
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 90,
        accountEmail: "alice@example.com",
        sourceKey: "google-gemini-cli",
      },
      {
        modelId: "gemini-2.5-pro",
        displayName: "Gemini Pro",
        percentRemaining: 10,
        accountEmail: "bob@example.com",
        sourceKey: "google",
      },
    ]);
  });

  it("reports no data when every account answers without buckets", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      google: { type: "oauth", refresh: "refresh-token|project-1" },
    });
    mocks.fetchResponse.mockResolvedValueOnce(quotaResponse([]));

    await expect(queryGeminiCliQuota()).resolves.toEqual({
      success: false,
      error: "No Gemini CLI quota data available",
    });
  });
});
