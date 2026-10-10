import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const authMocks = vi.hoisted(() => ({
  resolveGlobal: vi.fn(),
  resolveCn: vi.fn(),
  resolveGlobalWithDiagnostics: vi.fn(),
  resolveCnWithDiagnostics: vi.fn(),
  parseGlobal: vi.fn(),
  parseCn: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  resolveKimiGlobalAuthCached: authMocks.resolveGlobal,
  resolveKimiCnAuthCached: authMocks.resolveCn,
  resolveKimiGlobalAuthWithDiagnosticsCached: authMocks.resolveGlobalWithDiagnostics,
  resolveKimiCnAuthWithDiagnosticsCached: authMocks.resolveCnWithDiagnostics,
  resolveKimiGlobalAuth: authMocks.parseGlobal,
  resolveKimiCnAuth: authMocks.parseCn,
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/kimi.js", () => ({ queryKimiQuota: vi.fn() }));
vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import { queryKimiQuota } from "../src/lib/kimi.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { kimiCodePlanCnProvider, kimiCodePlanGlobalProvider } from "../src/providers/kimi-code.js";

const successfulWindows = [
  {
    label: "Weekly limit",
    used: 250,
    limit: 1000,
    percentRemaining: 75,
    resetTimeIso: "2026-01-08T00:00:00.000Z",
  },
  {
    label: "5h limit",
    used: 100,
    limit: 500,
    percentRemaining: 80,
    resetTimeIso: "2026-01-01T05:00:00.000Z",
  },
];

/** The CN login read from opencode.db is broken, so every stored CN row is listed. */
function mockInvalidCnDatabaseLogin(error: string) {
  authMocks.resolveCnWithDiagnostics.mockResolvedValueOnce({
    auth: { state: "invalid", error },
    diagnostics: {
      state: "invalid",
      source: "opencode.db",
      error,
      checkedPaths: [],
      credentialDatabasePaths: [],
    },
  });
}

/** A key for `endpoint` from its environment variable. */
function envKey(endpoint: "global" | "cn") {
  const auth = { state: "configured", apiKey: `${endpoint}-key`, endpoint };
  const source = `env:KIMI_${endpoint.toUpperCase()}_API_KEY`;
  return {
    auth,
    diagnostics: {
      state: "configured",
      source,
      endpoint,
      checkedPaths: [source],
      credentialDatabasePaths: [],
    },
  };
}

describe("Kimi regional providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveGlobal.mockResolvedValue(envKey("global").auth);
    authMocks.resolveCn.mockResolvedValue(envKey("cn").auth);
    authMocks.resolveGlobalWithDiagnostics.mockResolvedValue(envKey("global"));
    authMocks.resolveCnWithDiagnostics.mockResolvedValue(envKey("cn"));
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(true);
  });

  it.each([
    [
      kimiCodePlanGlobalProvider,
      "global",
      "global-key",
      "Kimi Code",
      "https://api.kimi.ai/coding/v1",
    ],
    [kimiCodePlanCnProvider, "cn", "cn-key", "Kimi Code (CN)", "https://api.kimi.com/coding/v1"],
  ] as const)("binds $id fetches to the resolved regional credential", async (provider, endpoint, apiKey, label, baseUrl) => {
    vi.mocked(queryKimiQuota).mockResolvedValue({
      success: true,
      label,
      windows: successfulWindows,
    });

    const out = await provider.fetch({ config: { requestTimeoutMs: 1234 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(queryKimiQuota).toHaveBeenCalledWith({
      apiKey,
      endpoint,
      label,
      requestTimeoutMs: 1234,
    });
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_endpoint", value: endpoint },
        { key: "api_base_url", value: baseUrl },
      ]),
    );
  });

  it("maps CN success into the existing accounting and presentation shape", async () => {
    vi.mocked(queryKimiQuota).mockResolvedValue({
      success: true,
      label: "Kimi Code (CN)",
      windows: successfulWindows,
    });

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as any);

    expect(visibleEntries(out.entries, "kimi-code-plan-cn")).toEqual([
      {
        name: "Kimi Code (CN) Weekly limit",
        group: "Kimi Code (CN)",
        label: "Weekly limit:",
        right: "250/1000",
        percentRemaining: 75,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
      {
        name: "Kimi Code (CN) 5h limit",
        group: "Kimi Code (CN)",
        label: "5h limit:",
        right: "100/500",
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T05:00:00.000Z",
      },
    ]);
    expect(out.entries[0]?.accounting).toEqual({
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    });
    expect(out.presentation).toEqual({ singleWindowDisplayName: "Kimi Code (CN)" });
  });

  it.each([
    ["kimi-code-plan-global/k3", true, false],
    ["kimi-code-plan-global/kimi-k2", true, false],
    ["kimi-code-plan-cn/k3", false, true],
    ["kimi-code-plan-cn/future-model", false, true],
    // Legacy provider ids belong to CN only.
    ["kimi-for-coding/k3", false, true],
    ["kimi-code/k3", false, true],
    ["kimi/k3", false, true],
    ["kimi-for-code/k3", false, true],
    // A model without a provider prefix matches neither region.
    ["kimi-k2", false, false],
    ["future-model", false, false],
  ])("matches %s: global=%s, cn=%s", (model, global, cn) => {
    expect(kimiCodePlanGlobalProvider.matchesCurrentModel?.(model)).toBe(global);
    expect(kimiCodePlanCnProvider.matchesCurrentModel?.(model)).toBe(cn);
  });

  it("does not resolve auth when the regional runtime provider is unavailable", async () => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(false);

    await expect(
      kimiCodePlanGlobalProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-cn"] }),
      ),
    ).resolves.toBe(false);
    expect(authMocks.resolveGlobal).not.toHaveBeenCalled();
  });

  it("keeps availability and auth state independent by region", async () => {
    authMocks.resolveGlobal.mockResolvedValue({ state: "none" });
    authMocks.resolveCn.mockResolvedValue({
      state: "invalid",
      error: 'Unsupported Kimi auth type: "oauth"',
    });

    await expect(
      kimiCodePlanGlobalProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-global"] }),
      ),
    ).resolves.toBe(false);
    await expect(
      kimiCodePlanCnProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["kimi-code-plan-cn"] }),
      ),
    ).resolves.toBe(true);
  });

  it("returns not attempted for absent auth and preserves invalid-auth provenance", async () => {
    authMocks.resolveGlobalWithDiagnostics.mockResolvedValueOnce({
      auth: { state: "none" },
      diagnostics: {
        state: "none",
        source: null,
        checkedPaths: ["/trusted/opencode.json"],
        credentialDatabasePaths: ["/trusted/opencode.db"],
      },
    });
    expectNotAttempted(await kimiCodePlanGlobalProvider.fetch({ config: {} } as any));

    mockInvalidCnDatabaseLogin("Invalid API key");
    const invalid = await kimiCodePlanCnProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(invalid, "Kimi Code (CN)");
    expect(invalid.errors[0]?.message).toBe("Invalid API key");
    expect(invalid.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "invalid" },
        { key: "api_key_source", value: "opencode.db" },
        { key: "auth_error", value: "Invalid API key" },
        { key: "api_endpoint", value: "cn" },
      ]),
    );
    expect(queryKimiQuota).not.toHaveBeenCalled();
  });

  it("maps request errors to the same regional label", async () => {
    vi.mocked(queryKimiQuota).mockResolvedValue({ success: false, error: "Unauthorized" });

    const out = await kimiCodePlanGlobalProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Kimi Code");
    expect(out.statusDetails).toContainEqual({ key: "live_fetch_error", value: "Unauthorized" });
  });

  it("keeps valid inactive CN credentials and errors alongside invalid rows, without querying Global", async () => {
    mockInvalidCnDatabaseLogin("empty key");
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "bad",
        integrationId: "kimi",
        label: "shared",
        active: true,
        value: { type: "api", key: "" },
      },
      {
        id: "good",
        integrationId: "kimi-code-plan-cn",
        label: "shared",
        active: false,
        value: { type: "api", key: "cn-key" },
      },
      {
        id: "global",
        integrationId: "kimi-code-plan-global",
        label: "other",
        active: false,
        value: { type: "api", key: "global-key" },
      },
    ] as never);
    authMocks.parseCn.mockImplementation((auth: Record<string, { key: string }>) => {
      const key = Object.values(auth)[0]?.key;
      return key
        ? { state: "configured", apiKey: key, endpoint: "cn" }
        : { state: "invalid", error: "empty key" };
    });
    vi.mocked(queryKimiQuota).mockResolvedValueOnce({
      success: true,
      label: "Kimi Code (CN)",
      windows: successfulWindows,
    });

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as any);

    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([
      { label: expect.stringContaining("shared"), message: "empty key" },
    ]);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]?.accounting.sourceId).toBe("good");
    expect(queryKimiQuota).toHaveBeenCalledOnce();
    expect(queryKimiQuota).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "cn-key", endpoint: "cn" }),
    );
  });

  it("shows a CN login OpenCode could not return as its own error row", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/kimi-auth.js")>("../src/lib/kimi-auth.js");
    authMocks.parseCn.mockImplementation(actual.resolveKimiCnAuth);
    mockInvalidCnDatabaseLogin("OpenCode could not read this login: resolve_empty: no value");
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "failed",
        integrationId: "kimi-code-plan-cn",
        label: "Work",
        active: true,
        value: { type: "api" },
        resolveError: "resolve_empty: no value",
      },
    ]);

    const out = await kimiCodePlanCnProvider.fetch({ config: {} } as any);

    expect(readCredentialRows).toHaveBeenLastCalledWith(
      ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
      { methods: ["key"] },
    );
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "[Kimi Code (CN) Work]",
        message: "OpenCode could not read this login: resolve_empty: no value",
      },
    ]);
    expect(queryKimiQuota).not.toHaveBeenCalled();
  });
});
