// The OAuth quota flow shared by Google AGY and Gemini CLI (src/lib/google-oauth-quota.ts),
// run for both flavors, plus the AGY quota-summary parsing.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  const companion = () => ({
    inspect: vi.fn(),
    resolveCredentials: vi.fn(),
    clearCacheForTests: vi.fn(),
  });
  return {
    readAuthFileCached: vi.fn(),
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        url: string,
        options: {
          request: RequestInit;
          timeoutMs?: number;
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => options.consume(await fetchResponse(url, options.request), new AbortController().signal),
    ),
    getCachedAccessToken: vi.fn(),
    setCachedAccessToken: vi.fn(),
    agyCompanion: companion(),
    geminiCliCompanion: companion(),
    deriveResolvedAuthIdentity: vi.fn(
      async (params: { providerId: string; principal: { kind: string } }) =>
        `identity:${params.providerId}:${params.principal.kind}`,
    ),
    composeResolvedAuthIdentities: vi.fn(
      async (params: { providerId: string; identities: readonly string[] }) =>
        `composed:${params.providerId}:${params.identities.join("|")}`,
    ),
  };
});

vi.mock("../src/lib/opencode-auth.js", () => ({ readAuthFileCached: mocks.readAuthFileCached }));
vi.mock("../src/lib/http.js", () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock("../src/lib/google-token-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-token-cache.js")>()),
  getCachedAccessToken: mocks.getCachedAccessToken,
  setCachedAccessToken: mocks.setCachedAccessToken,
}));
vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: mocks.deriveResolvedAuthIdentity,
  composeResolvedAuthIdentities: mocks.composeResolvedAuthIdentities,
}));
vi.mock("../src/lib/google-companion-credentials.js", () => ({
  agyCompanion: mocks.agyCompanion,
  geminiCliCompanion: mocks.geminiCliCompanion,
}));

import {
  hasAgyQuotaRuntimeAvailable,
  inspectAgyAuthPresence,
  queryGoogleAgyQuota,
  resolveGoogleAgyAuthIdentity,
} from "../src/lib/google-agy.js";
import {
  hasGeminiCliQuotaRuntimeAvailable,
  inspectGeminiCliAuthPresence,
  queryGeminiCliQuota,
  resolveGeminiCliAuthIdentity,
} from "../src/lib/google-gemini-cli.js";
import {
  resolveGoogleAccounts,
  resolveGoogleConfiguredProjectId,
} from "../src/lib/google-oauth-quota.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function notJsonResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  };
}

function authAccount(
  refreshToken: string,
  projectId: string,
  email?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "oauth",
    refresh: `${refreshToken}|${projectId}`,
    ...(email ? { email } : {}),
    ...extra,
  };
}

function summaryResponse(
  params: {
    geminiWeekly?: number;
    geminiFiveHour?: number;
    thirdPartyWeekly?: number;
    thirdPartyFiveHour?: number;
  } = {},
) {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        description: "Gemini model family",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly",
            window: "WEEKLY",
            remainingFraction: params.geminiWeekly ?? 0.58,
            resetTime: "2026-06-22T00:00:00Z",
          },
          {
            bucketId: "gemini-five-hour",
            displayName: "Five Hour",
            window: "FIVE_HOUR",
            remainingFraction: params.geminiFiveHour ?? 0.25,
            remainingAmount: "1234",
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        description: "Third-party model family",
        buckets: [
          {
            bucketId: "third-party-weekly",
            displayName: "Weekly",
            window: "WEEKLY",
            remainingFraction: params.thirdPartyWeekly ?? 1,
            resetTime: "2026-06-23T00:00:00Z",
          },
          {
            bucketId: "third-party-five-hour",
            displayName: "Five Hour",
            window: "FIVE_HOUR",
            remainingFraction: params.thirdPartyFiveHour ?? 0.9,
            remaining: "50",
          },
        ],
      },
    ],
  };
}

const FLAVORS = [
  {
    name: "Google AGY",
    providerId: "google-agy",
    // First, a middle compatibility key, and the last key, in lookup order.
    keys: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
    projectEnvVar: "OPENCODE_AGY_PROJECT_ID",
    configProvider: "google-agy",
    quotaUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    quotaHeaders: {
      "User-Agent": "antigravity/cli/1.3.2 darwin/amd64",
      "x-activity-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
    quotaResponse: summaryResponse(),
    companion: mocks.agyCompanion,
    missingCompanionError: "Companion plugin is missing",
    failedLoginState: "invalid",
    query: queryGoogleAgyQuota,
    resolveProjectId: () =>
      resolveGoogleConfiguredProjectId({
        projectIdEnvVar: "OPENCODE_AGY_PROJECT_ID",
        projectIdConfigProvider: "google-agy",
      }),
    resolveIdentity: resolveGoogleAgyAuthIdentity,
    inspectAuth: inspectAgyAuthPresence,
    hasRuntime: hasAgyQuotaRuntimeAvailable,
  },
  {
    name: "Gemini CLI",
    providerId: "google-gemini-cli",
    keys: ["google-gemini-cli", "opencode-gemini-auth", "google"],
    projectEnvVar: "OPENCODE_GEMINI_PROJECT_ID",
    configProvider: "google",
    quotaUrl: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    quotaHeaders: {
      "User-Agent": `GeminiCLI/opencode-quota (${process.platform}; ${process.arch})`,
    },
    quotaResponse: { buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.5 }] },
    companion: mocks.geminiCliCompanion,
    missingCompanionError: "Gemini CLI requires the opencode-gemini-auth plugin",
    failedLoginState: "present",
    query: queryGeminiCliQuota,
    resolveProjectId: () =>
      resolveGoogleConfiguredProjectId({
        projectIdEnvVar: "OPENCODE_GEMINI_PROJECT_ID",
        projectIdConfigProvider: "google",
      }),
    resolveIdentity: resolveGeminiCliAuthIdentity,
    inspectAuth: inspectGeminiCliAuthPresence,
    hasRuntime: hasGeminiCliQuotaRuntimeAvailable,
  },
] as const;

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "opencode-quota-google-config-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
  for (const name of [
    "OPENCODE_AGY_PROJECT_ID",
    "OPENCODE_GEMINI_PROJECT_ID",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.clearAllMocks();
  mocks.readAuthFileCached.mockResolvedValue(null);
  mocks.getCachedAccessToken.mockResolvedValue({ accessToken: "cached-access-token" });
  for (const companion of [mocks.agyCompanion, mocks.geminiCliCompanion]) {
    companion.inspect.mockResolvedValue({ state: "present", resolvedPath: "/plugin" });
    companion.resolveCredentials.mockResolvedValue({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

function writeGlobalConfig(config: unknown) {
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config));
}

describe.each(FLAVORS)("$name OAuth quota flow", (flavor) => {
  const [firstKey, middleKey, lastKey] = flavor.keys;

  it("composes account identities in auth-key order, then the companion client", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      [lastKey]: authAccount("refresh-two", "shared-project", "shared@example.com"),
      [middleKey]: authAccount("refresh-one", "shared-project", "ignored-duplicate@example.com"),
      [firstKey]: authAccount("refresh-one", "shared-project", "shared@example.com"),
    });

    const resolved = await flavor.resolveIdentity();

    expect(resolved).toContain(`composed:${flavor.providerId}:`);
    expect(mocks.deriveResolvedAuthIdentity.mock.calls.map(([params]) => params)).toEqual([
      {
        providerId: flavor.providerId,
        principal: { kind: "credential", value: "refresh-one" },
        qualifiers: ["shared-project"],
      },
      {
        providerId: flavor.providerId,
        principal: { kind: "credential", value: "refresh-two" },
        qualifiers: ["shared-project"],
      },
      {
        providerId: `${flavor.providerId}:companion`,
        principal: { kind: "credential", value: "client-secret" },
        qualifiers: ["client-id"],
      },
    ]);
    expect(JSON.stringify({ resolved })).not.toContain("ignored-duplicate@example.com");

    flavor.companion.resolveCredentials.mockResolvedValueOnce({ state: "missing", error: "x" });
    await expect(flavor.resolveIdentity()).resolves.toBeNull();
  });

  it("resolves the project id: env override, OpenCode config (native over legacy), GCP env", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT_ID", "generic-gcp-project-id");
    await expect(flavor.resolveProjectId()).resolves.toBe("generic-gcp-project-id");

    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "generic-gcp-project");
    await expect(flavor.resolveProjectId()).resolves.toBe("generic-gcp-project");

    writeGlobalConfig({
      provider: { [flavor.configProvider]: { options: { projectId: "legacy-project" } } },
    });
    await expect(flavor.resolveProjectId()).resolves.toBe("legacy-project");

    writeGlobalConfig({
      provider: { [flavor.configProvider]: { options: { projectId: "legacy-project" } } },
      providers: { [flavor.configProvider]: { settings: { projectId: "native-project" } } },
    });
    await expect(flavor.resolveProjectId()).resolves.toBe("native-project");

    vi.stubEnv(flavor.projectEnvVar, "explicit-project");
    await expect(flavor.resolveProjectId()).resolves.toBe("explicit-project");
  });

  it("reports missing, invalid, and failed-login auth presence", async () => {
    // A failed API key login is not an OAuth login.
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: { type: "api", resolveError: "resolve_empty: no value" },
    });
    await expect(flavor.inspectAuth()).resolves.toEqual({
      state: "missing",
      accountCount: 0,
      validAccountCount: 0,
    });

    mocks.readAuthFileCached.mockResolvedValueOnce({
      [lastKey]: { type: "oauth", refresh: "refresh-token" },
    });
    await expect(flavor.inspectAuth()).resolves.toEqual({
      state: "invalid",
      sourceKey: lastKey,
      accountCount: 1,
      validAccountCount: 0,
      error: `${flavor.name} OAuth auth is missing a refresh token or project id`,
    });

    // A login OpenCode could not return never becomes an account.
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: { type: "oauth", resolveError: "refresh_failed: HTTP 400" },
      [lastKey]: authAccount("refresh-token", "project-id"),
    });
    await expect(flavor.inspectAuth()).resolves.toEqual({
      state: "present",
      sourceKey: lastKey,
      accountCount: 2,
      validAccountCount: 1,
    });

    mocks.readAuthFileCached.mockResolvedValue({
      [firstKey]: { type: "oauth", resolveError: "refresh_failed: HTTP 400" },
    });
    await expect(flavor.inspectAuth()).resolves.toMatchObject({
      state: flavor.failedLoginState,
      sourceKey: firstKey,
      accountCount: 1,
      validAccountCount: 0,
    });
    await expect(flavor.hasRuntime()).resolves.toBe(flavor.failedLoginState === "present");
    await expect(flavor.query()).resolves.toBeNull();
    expect(mocks.fetchResponse).not.toHaveBeenCalled();
  });

  it("is available only with a usable login and an installed companion", async () => {
    mocks.readAuthFileCached.mockResolvedValue({ [firstKey]: authAccount("refresh", "project") });
    await expect(flavor.hasRuntime()).resolves.toBe(true);

    flavor.companion.inspect.mockResolvedValueOnce({ state: "missing", error: "missing" });
    await expect(flavor.hasRuntime()).resolves.toBe(false);

    mocks.readAuthFileCached.mockResolvedValue({ [firstKey]: { type: "oauth" } });
    await expect(flavor.hasRuntime()).resolves.toBe(false);
  });

  it("returns an actionable error when companion credentials are unavailable", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    flavor.companion.resolveCredentials.mockResolvedValueOnce({
      state: "missing",
      error: "Companion plugin is missing",
    });
    await expect(flavor.query()).resolves.toEqual({
      success: false,
      error: flavor.missingCompanionError,
    });

    flavor.companion.resolveCredentials.mockResolvedValueOnce({
      state: "invalid",
      error: "Companion plugin is incompatible",
    });
    await expect(flavor.query()).resolves.toEqual({
      success: false,
      error: "Companion plugin is incompatible",
    });
  });

  it("requests the fixed quota endpoint with the existing request contract", async () => {
    vi.stubEnv("OPENCODE_AGY_ENDPOINT", "https://untrusted.example");
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(flavor.quotaResponse));

    await expect(flavor.query({ requestTimeoutMs: 12_345 })).resolves.toMatchObject({
      success: true,
    });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(flavor.quotaUrl, {
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cached-access-token",
          ...flavor.quotaHeaders,
        },
        body: JSON.stringify({ project: "project-1" }),
      },
      timeoutMs: 12_345,
      consume: expect.any(Function),
    });
  });

  it("reuses an unexpired login token, else refreshes and retries once after a 401", async () => {
    mocks.getCachedAccessToken.mockResolvedValue(null);
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com", {
        access: "auth-entry-access",
        expires: Date.now() + 60 * 60_000,
      }),
    });
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(flavor.quotaResponse));
    await expect(flavor.query()).resolves.toMatchObject({ success: true });
    expect(mocks.fetchResponse).toHaveBeenCalledOnce();
    expect(mocks.fetchResponse.mock.calls[0]?.[1].headers.Authorization).toBe(
      "Bearer auth-entry-access",
    );

    mocks.fetchResponse.mockClear();
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.fetchResponse
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-access-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "retry-access-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(flavor.quotaResponse));
    await expect(flavor.query()).resolves.toMatchObject({ success: true });
    expect(mocks.fetchResponse.mock.calls.map(([url]) => url)).toEqual([
      TOKEN_URL,
      flavor.quotaUrl,
      TOKEN_URL,
      flavor.quotaUrl,
    ]);
    expect(mocks.fetchResponse.mock.calls[3]?.[1].headers.Authorization).toBe(
      "Bearer retry-access-token",
    );
    expect(mocks.setCachedAccessToken).toHaveBeenLastCalledWith({
      key: expect.stringMatching(/^gat1_/),
      entry: { accessToken: "retry-access-token", expiresAt: expect.any(Number) },
    });
  });

  it.each([
    ["revoked grant", jsonResponse({ error: "invalid_grant" }, 400), "Token revoked"],
    ["error description", jsonResponse({ error_description: "Bad client" }, 401), "Bad client"],
    ["non-JSON error", notJsonResponse(500), "HTTP 500"],
    ["timeout", new Error("Request timeout after 8s"), "Token refresh timeout"],
    ["network error", new Error("socket hang up"), "Token refresh failed"],
  ])("reports a failed token refresh (%s) as an account error", async (_case, outcome, error) => {
    mocks.getCachedAccessToken.mockResolvedValue(null);
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: authAccount("refresh", "project"),
    });
    if (outcome instanceof Error) mocks.fetchResponse.mockRejectedValueOnce(outcome);
    else mocks.fetchResponse.mockResolvedValueOnce(outcome);

    await expect(flavor.query()).resolves.toEqual({
      success: true,
      buckets: [],
      errors: [{ email: firstKey, error }],
    });
  });

  it.each([
    ["server error", [jsonResponse({}, 500)], `${flavor.name} quota API error: 500`],
    [
      "auth error after the retry",
      [
        jsonResponse({}, 403),
        jsonResponse({ access_token: "retry-access-token", expires_in: 3600 }),
        jsonResponse({}, 403),
      ],
      `${flavor.name} quota auth error: 403`,
    ],
    ["timeout", [new Error("Request timeout after 6s")], "API timeout"],
  ])("reports a failed quota request (%s) as an account error", async (_case, outcomes, error) => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      [firstKey]: authAccount("refresh", "project"),
    });
    for (const outcome of outcomes) {
      if (outcome instanceof Error) mocks.fetchResponse.mockRejectedValueOnce(outcome);
      else mocks.fetchResponse.mockResolvedValueOnce(outcome);
    }

    await expect(flavor.query()).resolves.toEqual({
      success: true,
      buckets: [],
      errors: [{ email: firstKey, error }],
    });
  });

  it("keeps account order and returns sibling account errors", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      [firstKey]: authAccount("refresh-1", "project-1", "alice@example.com"),
      [lastKey]: authAccount("refresh-2", "project-2", "bob@example.com"),
    });
    mocks.fetchResponse.mockImplementation(async (_url: string, init: { body?: string }) => {
      if (JSON.parse(init.body ?? "{}").project === "project-1") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return jsonResponse(flavor.quotaResponse);
      }
      return jsonResponse(flavor.quotaResponse);
    });
    const result = await flavor.query();
    if (!result?.success) throw new Error("expected success");
    expect([...new Set(result.buckets.map((bucket) => bucket.accountEmail))]).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);

    mocks.fetchResponse.mockImplementation(async (_url: string, init: { body?: string }) =>
      JSON.parse(init.body ?? "{}").project === "project-1"
        ? jsonResponse(flavor.quotaResponse)
        : jsonResponse({}, 500),
    );
    const partial = await flavor.query();
    if (!partial?.success) throw new Error("expected success");
    expect(new Set(partial.buckets.map((bucket) => bucket.accountEmail))).toEqual(
      new Set(["alice@example.com"]),
    );
    expect(partial.errors).toEqual([
      { email: "bob@example.com", error: `${flavor.name} quota API error: 500` },
    ]);

    mocks.fetchResponse.mockResolvedValue(jsonResponse({}, 500));
    await expect(flavor.query()).resolves.toEqual({
      success: true,
      buckets: [],
      errors: [
        { email: "alice@example.com", error: `${flavor.name} quota API error: 500` },
        { email: "bob@example.com", error: `${flavor.name} quota API error: 500` },
      ],
    });
  });
});

const AGY_AUTH_KEYS = ["google-agy", "opencode-agy-auth", "google-agy-auth"] as const;

function resolveAgyAccounts(auth: Parameters<typeof resolveGoogleAccounts>[1], project: string) {
  return resolveGoogleAccounts({ authKeys: AGY_AUTH_KEYS }, auth, project);
}

describe("Google account resolution", () => {
  it("preserves auth-key order, packed refresh parts, login tokens, and duplicate suppression", () => {
    expect(
      resolveAgyAccounts(
        {
          "google-agy-auth": authAccount("refresh-token-2", "project-2", undefined, {
            login: "bob@example.com",
          }),
          "opencode-agy-auth": {
            type: "oauth",
            refresh: "refresh-token-1|packed-project|packed-managed",
            managedProjectId: "entry-managed",
            email: "duplicate@example.com",
          },
          "google-agy": {
            type: "oauth",
            refresh: " refresh-token-1 |packed-project|packed-managed",
            managedProjectId: "entry-managed",
            accountEmail: "alice@example.com",
            access: " access-token ",
            expires: 123,
          },
        },
        "configured-project",
      ),
    ).toEqual([
      {
        sourceKey: "google-agy",
        refreshToken: "refresh-token-1",
        projectId: "entry-managed",
        email: "alice@example.com",
        accessToken: "access-token",
        expiresAt: 123,
      },
      {
        sourceKey: "google-agy-auth",
        refreshToken: "refresh-token-2",
        projectId: "project-2",
        email: "bob@example.com",
      },
    ]);
  });

  it.each([
    [
      { refresh: "refresh|packed-project|packed-managed", managedProjectId: "entry-managed" },
      "entry-managed",
    ],
    [
      { refresh: "refresh|packed-project|packed-managed", quotaProjectId: "entry-quota" },
      "entry-quota",
    ],
    [
      { refresh: "refresh|packed-project|packed-managed", projectId: "entry-project" },
      "packed-managed",
    ],
    [{ refresh: "refresh|packed-project", projectId: "entry-project" }, "entry-project"],
    [{ refresh: "refresh|packed-project", projectID: "entry-project-id" }, "entry-project-id"],
    [{ refresh: "refresh|packed-project" }, "packed-project"],
    [{ refresh: "refresh" }, "configured-project"],
  ])("picks the project id by precedence: %o → %s", (entry, projectId) => {
    expect(
      resolveAgyAccounts({ "google-agy": { type: "oauth", ...entry } }, "configured-project")[0]
        ?.projectId,
    ).toBe(projectId);
  });
});

describe("Google AGY quota summary", () => {
  function mockSummary(summary: unknown) {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1"),
    });
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(summary));
  }

  it("normalizes grouped weekly and five-hour buckets with canonical family labels", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-token", "project-1", "alice@example.com"),
    });
    mocks.fetchResponse.mockResolvedValueOnce(jsonResponse(summaryResponse()));

    const result = await queryGoogleAgyQuota();
    if (!result?.success) throw new Error("expected success");
    expect(result.buckets[0]).toEqual({
      family: "Gemini Models",
      window: "weekly",
      windowLabel: "Weekly",
      bucketId: "gemini-weekly",
      bucketLabel: "Weekly",
      remainingFraction: 0.58,
      percentRemaining: 58,
      resetTimeIso: "2026-06-22T00:00:00.000Z",
      accountEmail: "alice@example.com",
      accountIndex: 0,
      sourceKey: "google-agy",
    });
    expect(
      result.buckets.map(({ family, window, windowLabel, percentRemaining, remainingAmount }) => [
        family,
        window,
        windowLabel,
        percentRemaining,
        remainingAmount,
      ]),
    ).toEqual([
      ["Gemini Models", "weekly", "Weekly", 58, undefined],
      ["Gemini Models", "five_hour", "5h", 25, "1234"],
      ["Claude and GPT models", "weekly", "Weekly", 100, undefined],
      ["Claude and GPT models", "five_hour", "5h", 90, "50"],
    ]);
  });

  it("uses top-level buckets only when grouped buckets are not usable", async () => {
    mockSummary({
      description: "Fallback family",
      groups: [{ displayName: "Gemini Models", buckets: [{ window: "DAILY" }] }],
      buckets: [
        { bucketId: "fallback-weekly", window: "weekly", remainingFraction: 0.4 },
        { bucketId: "fallback-five-hour", window: "5h", remainingFraction: 0.7 },
      ],
    });

    const result = await queryGoogleAgyQuota();
    if (!result?.success) throw new Error("expected success");
    expect(result.buckets.map((bucket) => [bucket.family, bucket.window])).toEqual([
      ["Fallback family", "weekly"],
      ["Fallback family", "five_hour"],
    ]);
  });

  it("reports a summary without usable rows as an account error", async () => {
    mockSummary({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "disabled", window: "WEEKLY", remainingFraction: 0.1, disabled: true },
            { bucketId: "missing-fraction", window: "FIVE_HOUR" },
            { bucketId: "non-finite", window: "FIVE_HOUR", remainingFraction: Number.NaN },
            { bucketId: "unsupported", window: "DAILY", remainingFraction: 0.5 },
          ],
        },
        {
          displayName: " ",
          buckets: [{ bucketId: "missing-family", window: "WEEKLY", remainingFraction: 0.5 }],
        },
      ],
    });

    await expect(queryGoogleAgyQuota()).resolves.toEqual({
      success: true,
      buckets: [],
      errors: [{ email: "google-agy", error: "Quota summary API unavailable" }],
    });
  });

  it("keeps the most constrained duplicate, an explicit zero, and drops an invalid reset", async () => {
    mockSummary({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "same-weekly",
              window: "WEEKLY",
              remainingFraction: 0.8,
              resetTime: "2026-06-24T00:00:00Z",
            },
            {
              bucketId: "same-weekly",
              window: "WEEKLY",
              remainingFraction: 0.3,
              resetTime: "2026-06-21T00:00:00Z",
            },
            {
              bucketId: "zero-weekly",
              window: "WEEKLY",
              remainingFraction: 0,
              resetTime: "not-a-date",
            },
          ],
        },
      ],
    });

    const result = await queryGoogleAgyQuota();
    if (!result?.success) throw new Error("expected success");
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets.find((bucket) => bucket.bucketId === "same-weekly")).toMatchObject({
      percentRemaining: 30,
      resetTimeIso: "2026-06-21T00:00:00.000Z",
    });
    const zero = result.buckets.find((bucket) => bucket.bucketId === "zero-weekly");
    expect(zero).toMatchObject({ percentRemaining: 0 });
    expect(zero).not.toHaveProperty("resetTimeIso");
  });

  it("numbers accounts in input order and limits requests to three in flight", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      "google-agy": authAccount("refresh-1", "project-1"),
      "opencode-agy-auth": authAccount("refresh-2", "project-2"),
      "google-agy-auth": authAccount("refresh-3", "project-3"),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.fetchResponse.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return jsonResponse(summaryResponse());
    });

    const result = await queryGoogleAgyQuota();
    if (!result?.success) throw new Error("expected success");
    expect(maxInFlight).toBe(3);
    expect(result.buckets.map((bucket) => bucket.accountIndex)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    ]);
  });
});
