import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rowsFromProviderResult } from "../src/core/rows.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyLogin: vi.fn(),
  getApiKeyLoginDiagnostics: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  resolveApiKeyLogin: mocks.resolveApiKeyLogin,
  getApiKeyLoginDiagnostics: mocks.getApiKeyLoginDiagnostics,
}));

vi.mock("../src/lib/http.js", async (importOriginal) => {
  const http = await importOriginal<typeof import("../src/lib/http.js")>();
  return { ...http, fetchWithTimeout: vi.fn(http.fetchWithTimeout) };
});

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import { fetchWithTimeout } from "../src/lib/http.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { zaiProvider, zhipuProvider } from "../src/providers/glm-coding-plan.js";

const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const FIVE_HOUR_RESET = "2026-01-01T03:00:00.000Z";
const WEEKLY_RESET = "2026-01-05T00:00:00.000Z";

const VENDORS = [
  {
    id: "zai",
    label: "Z.ai",
    provider: zaiProvider,
    endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
    integrationId: "zai-coding-plan",
    providerIds: ["zai", "glm", "zai-coding-plan"],
    matchingModels: ["zai/glm-4.5", "glm/glm-4.5", "anthropic/glm-4"],
    nonMatchingModels: ["openai/gpt-5"],
  },
  {
    id: "zhipu",
    label: "Zhipu",
    provider: zhipuProvider,
    endpoint: "https://bigmodel.cn/api/monitor/usage/quota/limit",
    integrationId: "zhipu-coding-plan",
    providerIds: ["zhipu", "zhipu-coding-plan", "glm-coding-plan"],
    matchingModels: ["zhipu/glm-4.5", "zhipu-coding-plan/glm-4.5", "glm-coding-plan/glm-4.5"],
    nonMatchingModels: ["zai/glm-4.5", "glm/glm-4.5", "openai/gpt-5"],
  },
] as const;

function diagnostics(source: string | null) {
  return {
    state: source ? "configured" : "none",
    source,
    checkedPaths: [],
    credentialDatabasePaths: [],
  };
}

function quotaResponse() {
  return {
    code: 0,
    msg: "ok",
    success: true,
    data: {
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          percentage: 20,
          nextResetTime: Date.parse(FIVE_HOUR_RESET),
        },
        { type: "TOKENS_LIMIT", unit: 6, percentage: 70, nextResetTime: Date.parse(WEEKLY_RESET) },
        { type: "TIME_LIMIT", percentage: 10 },
      ],
    },
  };
}

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
  const fetchMock = vi.fn();
  for (const { status, body } of responses) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function summary(rows: Array<{ id: string; account?: string; label: string }>) {
  return rows.map((row) => [row.id, row.account ?? null, row.label]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApiKeyLoginDiagnostics.mockResolvedValue(diagnostics("env"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(VENDORS)("$label coding plan", (vendor) => {
  async function fetchRows(ctx: unknown = { config: { requestTimeoutMs: 4321 } }) {
    return rowsFromProviderResult(vendor.id, await vendor.provider.fetch(ctx as never), NOW_MS);
  }

  it("reads the 5h, weekly and MCP windows of the configured key", async () => {
    mocks.resolveApiKeyLogin.mockResolvedValue({ state: "configured", apiKey: "secret-key" });
    stubFetch({ status: 200, body: quotaResponse() });

    const fetched = await fetchRows();

    expect(fetched.rows).toEqual([
      {
        id: `${vendor.id}.five_hour`,
        providerId: vendor.id,
        label: "5h",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "five_hour",
        prominence: "primary",
        percentRemaining: 80,
        resetsAt: FIVE_HOUR_RESET,
      },
      {
        id: `${vendor.id}.weekly`,
        providerId: vendor.id,
        label: "Weekly",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "week",
        prominence: "primary",
        percentRemaining: 30,
        resetsAt: WEEKLY_RESET,
      },
      {
        id: `${vendor.id}.mcp`,
        providerId: vendor.id,
        label: "MCP",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "mcp",
        prominence: "primary",
        percentRemaining: 90,
      },
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toContainEqual({
      key: "five_hour_remaining",
      value: `80% reset_at=${FIVE_HOUR_RESET}`,
    });
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      vendor.endpoint,
      expect.objectContaining({
        timeoutMs: 4321,
        request: {
          headers: {
            Authorization: "secret-key",
            "User-Agent": "OpenCode-Quota-Toast/1.0",
            "Content-Type": "application/json",
          },
        },
      }),
    );
  });

  it.each([
    [
      "no key",
      { state: "none" },
      undefined,
      { rows: [], error: { code: "not_configured" } },
      undefined,
    ],
    [
      "an invalid key",
      { state: "invalid", error: "Unsupported auth type" },
      undefined,
      { rows: [], error: { code: "not_configured", detail: "Unsupported auth type" } },
      `${vendor.label}: Unsupported auth type`,
    ],
    [
      "an HTTP error",
      { state: "configured", apiKey: "secret-key" },
      { status: 500, body: { msg: "down" } },
      {
        rows: [],
        error: {
          code: "provider_error",
          status: 500,
          detail: `${vendor.label} API error 500: {"msg":"down"}`,
        },
      },
      `${vendor.label}: ${vendor.label} API error 500: {"msg":"down"}`,
    ],
  ])("with %s it shows no rows and its error", async (_name, auth, response, expected, line) => {
    mocks.resolveApiKeyLogin.mockResolvedValue(auth);
    const fetchMock = stubFetch(...(response ? [response] : []));

    const fetched = await fetchRows();

    expect(fetched).toMatchObject(expected);
    if (line) expect(fetched.debug).toContainEqual({ key: "error", value: line });
    expect(fetchMock).toHaveBeenCalledTimes(response ? 1 : 0);
  });

  it("queries each stored key and shows a key OpenCode could not read as an error", async () => {
    mocks.getApiKeyLoginDiagnostics.mockResolvedValue(diagnostics("opencode.db"));
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "failed-id",
        integrationId: vendor.integrationId,
        label: "Work",
        active: true,
        value: { type: "api" },
        resolveError: "refresh_failed: HTTP 401",
      },
      {
        id: "working-id",
        integrationId: vendor.integrationId,
        label: "Home",
        active: false,
        value: { type: "api", key: "home-key" },
      },
    ]);
    const fetchMock = stubFetch({ status: 200, body: quotaResponse() });

    const fetched = await fetchRows();

    expect(summary(fetched.rows)).toEqual([
      [`${vendor.id}.five_hour`, "Home", "5h"],
      [`${vendor.id}.weekly`, "Home", "Weekly"],
      [`${vendor.id}.mcp`, "Home", "MCP"],
    ]);
    expect(fetched.rowLogins).toEqual(["working-id", "working-id", "working-id"]);
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: `[${vendor.label} Work] (active): OpenCode could not read this login: refresh_failed: HTTP 401`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      vendor.endpoint,
      expect.objectContaining({
        timeoutMs: 4321,
        request: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "home-key" }),
        }),
      }),
    );
  });

  it("keeps provider-specific model matching", () => {
    for (const model of vendor.matchingModels) {
      expect(vendor.provider.matchesCurrentModel?.(model), model).toBe(true);
    }
    for (const model of vendor.nonMatchingModels) {
      expect(vendor.provider.matchesCurrentModel?.(model), model).toBe(false);
    }
  });

  it.each([
    [{ state: "configured", apiKey: "secret-key" }, true],
    // An invalid key stays available so fetch can show its error.
    [{ state: "invalid", error: "Unsupported auth type" }, true],
    [{ state: "none" }, false],
  ])("with auth %j is available: %s", async (auth, expected) => {
    mocks.resolveApiKeyLogin.mockResolvedValue(auth);
    for (const providerId of vendor.providerIds) {
      await expect(
        vendor.provider.isAvailable(
          createProviderAvailabilityContext({ providerIds: [providerId] }),
        ),
      ).resolves.toBe(expected);
    }
  });

  it("is not available for other providers or when the provider lookup fails", async () => {
    mocks.resolveApiKeyLogin.mockResolvedValue({ state: "configured", apiKey: "secret-key" });
    await expect(
      vendor.provider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(false);
    await expect(
      vendor.provider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("boom") }),
      ),
    ).resolves.toBe(false);
    expect(mocks.resolveApiKeyLogin).not.toHaveBeenCalled();
  });
});
