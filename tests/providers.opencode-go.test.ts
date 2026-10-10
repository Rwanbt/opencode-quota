import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({
  resolveOpenCodeGoAuthCached: vi.fn(),
  resolveOpenCodeGoAuth: vi.fn(),
  getOpenCodeGoAuthDiagnostics: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
  queryOpenCodeGoConsoleStatus: vi.fn(),
  resolveOpenCodeConsoleAuth: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  resolveApiKeyLogin: (_spec: unknown, params: unknown) =>
    mocks.resolveOpenCodeGoAuthCached(params),
  getApiKeyLoginDiagnostics: (_spec: unknown, params: unknown) =>
    mocks.getOpenCodeGoAuthDiagnostics(params),
  parseApiKeyLogin: (_spec: unknown, auth: unknown) => mocks.resolveOpenCodeGoAuth(auth),
}));

vi.mock("../src/lib/opencode-go.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-go.js")>();
  return {
    ...original,
    queryOpenCodeGoQuota: mocks.queryOpenCodeGoQuota,
    queryOpenCodeGoConsoleStatus: mocks.queryOpenCodeGoConsoleStatus,
  };
});

vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuth: mocks.resolveOpenCodeConsoleAuth,
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import { rowsFromLegacyResult } from "../src/core/rows.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import {
  __resetOpenCodeGoNotSubscribedForTests,
  opencodeGoProvider,
} from "../src/providers/opencode-go.js";
import { DEFAULT_WORDS, percentText } from "../src/view/format.js";

const NOT_SUBSCRIBED = {
  success: false,
  error: "OpenCode Go not subscribed (403 EntitlementError)",
  notSubscribed: true,
  retryable: false,
};
const NOT_SUBSCRIBED_DETAIL = { key: "opencode_go_state", value: "not_subscribed" };
const JWT = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;

function successfulResult() {
  return {
    success: true as const,
    rolling: {
      status: "ok" as const,
      usagePercent: 12.5,
      percentRemaining: 87.5,
      resetTimeIso: "2026-08-12T12:30:00.000Z",
    },
    weekly: {
      status: "ok" as const,
      usagePercent: 45,
      percentRemaining: 55,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    },
    monthly: {
      status: "ok" as const,
      usagePercent: 80,
      percentRemaining: 20,
      resetTimeIso: "2026-09-01T04:00:00.000Z",
    },
  };
}

/** All three windows, with the weekly one rate-limited (exhausted). */
function rateLimitedWeeklyResult() {
  return {
    ...successfulResult(),
    weekly: {
      status: "rate-limited" as const,
      usagePercent: 100,
      percentRemaining: 0,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    },
  };
}

function diagnostics(
  state: "none" | "configured" | "invalid" = "configured",
): Record<string, unknown> {
  return {
    state,
    source: state === "none" ? null : "opencode.db",
    checkedPaths: ["env:OPENCODE_API_KEY", "/tmp/opencode.json"],
    credentialDatabasePaths: ["/tmp/opencode.db"],
    ...(state === "invalid" ? { error: "OpenCode Go auth entry present but key is empty" } : {}),
  };
}

function credentialRow(id: string, integrationId: string, key: string, label = "default") {
  return { id, integrationId, label, active: false, value: { type: "key", key } };
}

async function runFetch(
  opencodeGoWindows: Array<"rolling" | "weekly" | "monthly"> = ["rolling", "weekly", "monthly"],
  requestTimeoutMs = 5_000,
) {
  return opencodeGoProvider.fetch(
    createProviderAvailabilityContext({
      configOverrides: { opencodeGoWindows, requestTimeoutMs },
    }),
  );
}

function noApiKey(): void {
  mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
  mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });
}

describe("opencode-go provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValue(diagnostics());
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    mocks.queryOpenCodeGoQuota.mockResolvedValue(successfulResult());
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValue({ state: "none" });
  });

  function consoleConfigured(): void {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "configured",
      credential: { accessToken: "console-access", orgId: "wrk_1" },
    });
  }

  it("reads Go windows from the console API when a console credential exists", async () => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce(successfulResult());

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).toHaveBeenCalledWith(
      { accessToken: "console-access", orgId: "wrk_1" },
      { requestTimeoutMs: 5_000 },
    );
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.statusDetails).toEqual([
      { key: "console_auth_state", value: "configured" },
      { key: "console_server", value: "https://opencode.ai/console" },
      { key: "go_source", value: "console" },
      { key: "selected_windows", value: "rolling,weekly,monthly" },
    ]);
    expect(visibleEntries(out.entries, "opencode-go").map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Weekly",
      "OpenCode Go Monthly",
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "console:go" });
    }
  });

  it("reports a console not-subscribed state without errors", async () => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go subscription not found for this console account (404)",
      notSubscribed: true,
    });

    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([]);
    expect(out.statusDetails).toContainEqual(NOT_SUBSCRIBED_DETAIL);
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["500", "OpenCode Console API error 500 (/api/go/status)", true],
    ["403", "OpenCode Console API error 403 (/api/go/status)", false],
  ])("falls back to the API key after a Console %s", async (_status, error, retryable) => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({ success: false, error, retryable });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "opencode-go")).toHaveLength(3);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "console_auth_state", value: "configured" },
        { key: "go_source", value: "legacy_key" },
        { key: "console_error", value: error },
      ]),
    );
    expect(out.statusDetails).not.toContainEqual(NOT_SUBSCRIBED_DETAIL);
  });

  it.each([
    ["a 403", "OpenCode Console API error 403 (/api/go/status)"],
    ["a network failure", "fetch failed"],
  ])("stays quiet after %s from the Console when there is no API key", async (_case, error) => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error,
      retryable: true,
    });
    noApiKey();

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "console_auth_state", value: "configured" },
        { key: "console_error", value: error },
      ]),
    );
  });

  it("uses the legacy key path with the console error when the sign-in cannot be read", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "invalid",
      error: `refresh_failed: HTTP 401 ${JWT}`,
    });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).not.toHaveBeenCalled();
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "configured" },
        { key: "console_auth_state", value: "invalid" },
        { key: "console_error", value: "refresh_failed: HTTP 401 [redacted]" },
        { key: "go_source", value: "legacy_key" },
        { key: "selected_windows", value: "rolling,weekly,monthly" },
      ]),
    );
    expect(JSON.stringify(out)).not.toContain(JWT);
  });

  it("shows the failed Console sign-in as Go's error when there is no API key", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "invalid",
      error: `refresh_failed: HTTP 401 ${JWT}`,
    });
    noApiKey();

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "OpenCode Go",
        message:
          "OpenCode Console sign-in failed: refresh_failed: HTTP 401 [redacted]. Run `opencode auth login opencode`.",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "console_auth_state", value: "invalid" },
        { key: "go_source", value: "legacy_key" },
      ]),
    );
    expect(JSON.stringify(out)).not.toContain(JWT);
  });

  it("falls back to the API key without auth details for an expired console sign-in", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "expired",
      credential: { accessToken: "console-access" },
    });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).not.toHaveBeenCalled();
    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails?.slice(0, 2)).toEqual([
      { key: "console_auth_state", value: "expired" },
      { key: "go_source", value: "legacy_key" },
    ]);
  });

  it("stays quiet without a Console sign-in or an API key, without calling the API", async () => {
    noApiKey();

    const out = await runFetch();

    expectNotAttempted(out);
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "none" },
        { key: "auth_source", value: "(none)" },
        { key: "selected_windows", value: "rolling,weekly,monthly" },
      ]),
    );
  });

  it("returns an attempted error for invalid canonical auth", async () => {
    const error = "OpenCode Go auth entry present but key is empty";
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("invalid"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "invalid", error });

    const out = await runFetch();

    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toBe(error);
    expect(out.statusDetails).toContainEqual({ key: "auth_error", value: error });
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("keeps a valid inactive duplicate-label database credential when the active row is invalid", async () => {
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("invalid"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: "empty key",
    });
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      { ...credentialRow("bad", "opencode-go", "", "shared"), active: true },
      credentialRow("good", "opencode-go", "ok", "shared"),
    ] as never);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) =>
      auth["opencode-go"].key
        ? { state: "configured", apiKey: "row-token" }
        : { state: "invalid", error: "empty key" },
    );

    const out = await runFetch();
    expect(out.errors).toContainEqual({
      label: "[OpenCode Go shared] (active)",
      message: "empty key",
    });
    expect(out.entries).toContainEqual(
      expect.objectContaining({
        group: "[OpenCode Go shared 2]",
        accounting: expect.objectContaining({ sourceId: "good" }),
      }),
    );
    expect(out.entries).toHaveLength(3);
  });

  it("keeps two failed database logins as two error rows", async () => {
    const failed = (id: string, label: string, active: boolean) => ({
      id,
      integrationId: "opencode-go",
      label,
      active,
      value: { type: "api" },
      resolveError: "active_failed: database is locked",
    });
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      failed("cred_personal", "Personal", true),
      failed("cred_work", "Work", false),
    ] as never);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) => ({
      state: "invalid",
      error: `OpenCode could not read this login: ${auth["opencode-go"].resolveError}`,
    }));

    const out = await runFetch();

    const message = "OpenCode could not read this login: active_failed: database is locked";
    expect(out.errors).toEqual([
      { label: "[OpenCode Go Personal] (active)", message },
      { label: "[OpenCode Go Work]", message },
    ]);
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "one connection when the same key is stored under both integrations",
      rows: [
        credentialRow("go-row", "opencode-go", "workspace-key"),
        credentialRow("zen-row", "opencode", "workspace-key"),
      ],
      sourceIds: ["go-row", "go-row"],
    },
    {
      name: "no second connection for another integration's credential",
      rows: [
        credentialRow("go-row", "opencode-go", "go-key"),
        credentialRow("zen-row", "opencode", "zen-key"),
      ],
      sourceIds: ["go-row", "go-row"],
    },
    {
      name: "separate connections for distinct native credentials",
      rows: [
        credentialRow("go-row", "opencode-go", "first-key"),
        credentialRow("second-go-row", "opencode-go", "second-key"),
      ],
      sourceIds: ["go-row", "go-row", "second-go-row", "second-go-row"],
    },
    {
      name: "legacy alias rows when no native opencode-go row exists",
      rows: [credentialRow("alias-row", "opencode", "legacy-key")],
      sourceIds: ["alias-row", "alias-row"],
    },
  ])("reports $name", async ({ rows, sourceIds }) => {
    vi.mocked(readCredentialRows).mockResolvedValueOnce(rows as never);

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(sourceIds.length / 2);
    const visible = visibleEntries(out.entries, "opencode-go");
    expect(visible.map((entry) => entry.group)).toEqual(sourceIds.map(() => "[OpenCode Go]"));
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(sourceIds);
  });

  it("suppresses non-entitled database connections independently", async () => {
    const rows = [
      { ...credentialRow("not-subscribed", "opencode-go", "free-key", "free"), active: true },
      credentialRow("subscribed", "opencode-go", "paid-key", "paid"),
    ];
    vi.mocked(readCredentialRows)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce(rows as never);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) => ({
      state: "configured",
      apiKey: auth["opencode-go"].key,
    }));
    mocks.queryOpenCodeGoQuota.mockImplementation(async (apiKey: string) =>
      apiKey === "free-key" ? NOT_SUBSCRIBED : successfulResult(),
    );

    const first = await runFetch(["rolling"]);
    const second = await runFetch(["rolling"]);

    expect(mocks.queryOpenCodeGoQuota.mock.calls.map(([apiKey]) => apiKey)).toEqual([
      "free-key",
      "paid-key",
      "paid-key",
    ]);
    for (const out of [first, second]) {
      expect(out.entries).toEqual([
        expect.objectContaining({
          accounting: expect.objectContaining({ sourceId: "subscribed" }),
        }),
      ]);
    }
  });

  it("returns canonical entries with remote_api accounting from the resolved token", async () => {
    const out = await runFetch(["rolling", "weekly", "monthly"], 12_345);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledWith("provider-test-token", {
      requestTimeoutMs: 12_345,
    });
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "opencode-go")).toEqual([
      {
        name: "OpenCode Go 5h",
        group: "OpenCode Go",
        label: "5h:",
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      {
        name: "OpenCode Go Weekly",
        group: "OpenCode Go",
        label: "Weekly:",
        percentRemaining: 55,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      {
        name: "OpenCode Go Monthly",
        group: "OpenCode Go",
        label: "Monthly:",
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toEqual({
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      });
    }
    expect(JSON.stringify(out)).not.toContain("provider-test-token");
  });

  it("filters duplicates in canonical order after full-response diagnostics", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(rateLimitedWeeklyResult());

    const out = await runFetch(["monthly", "rolling", "monthly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Monthly",
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "selected_windows", value: "monthly,rolling,monthly" },
        {
          key: "rolling_usage",
          value:
            "status=ok percent_used=12.5 percent_remaining=87.5 reset_at=2026-08-12T12:30:00.000Z",
        },
        {
          key: "weekly_usage",
          value:
            "status=rate-limited percent_used=100 percent_remaining=0 reset_at=2026-08-16T16:00:00.000Z",
        },
        {
          key: "monthly_usage",
          value: "status=ok percent_used=80 percent_remaining=20 reset_at=2026-09-01T04:00:00.000Z",
        },
      ]),
    );
  });

  it("uses only the standard auth diagnostic keys", async () => {
    const out = await runFetch(["weekly"]);

    expect(out.statusDetails?.map((detail) => detail.key)).toEqual([
      "auth_state",
      "auth_source",
      "auth_checked_paths",
      "credential_database_paths",
      "selected_windows",
      "rolling_usage",
      "weekly_usage",
      "monthly_usage",
    ]);
  });

  it("returns API failures as attempted errors with live_fetch_error", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go API error 503: unavailable",
      retryable: true,
    });

    const out = await runFetch();

    expect(out.errors).toEqual([
      { label: "OpenCode Go", message: "OpenCode Go API error 503: unavailable", retryable: true },
    ]);
    expect(out.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value: "OpenCode Go API error 503: unavailable",
    });
  });

  it("suppresses repeat requests after a not-subscribed response", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValue(NOT_SUBSCRIBED);

    for (const out of [await runFetch(), await runFetch()]) {
      expectAttemptedWithNoErrors(out);
      expect(out.entries).toEqual([]);
      expect(out.statusDetails).toContainEqual(NOT_SUBSCRIBED_DETAIL);
      expect(JSON.stringify(out)).not.toContain("EntitlementError");
    }
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(1);
  });

  it("hides a not-subscribed result from rows but keeps it in safe diagnostics", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(NOT_SUBSCRIBED);

    const fetched = rowsFromLegacyResult("opencode-go", await runFetch());

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toContainEqual(NOT_SUBSCRIBED_DETAIL);
    expect(JSON.stringify(fetched)).not.toMatch(/EntitlementError|provider-test-token/u);
  });

  it("shows a rate-limited window as used 100% next to its healthy siblings", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(rateLimitedWeeklyResult());

    const { rows, error } = rowsFromLegacyResult("opencode-go", await runFetch());

    const used = { ...DEFAULT_WORDS, percent: "used" as const };
    expect(error).toBeUndefined();
    expect(
      rows.map((row) => [row.window, percentText(used, row.percentRemaining ?? -1, true)]),
    ).toEqual([
      ["five_hour", "12% used"],
      ["week", "100% used"],
      ["month", "80% used"],
    ]);
  });

  it("keeps only the selected windows as rows, with every window in diagnostics", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(rateLimitedWeeklyResult());

    const fetched = rowsFromLegacyResult("opencode-go", await runFetch(["rolling", "monthly"]));

    expect(fetched.rows.map((row) => row.window)).toEqual(["five_hour", "month"]);
    expect(fetched.debug.map((detail) => detail.key)).toEqual(
      expect.arrayContaining(["rolling_usage", "weekly_usage", "monthly_usage"]),
    );
  });

  it("queries again after the credential changes, including when the original returns", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(NOT_SUBSCRIBED);
    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      true,
    );
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "new-provider-test-token",
    });
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    await runFetch();

    expect(mocks.queryOpenCodeGoQuota.mock.calls.map(([apiKey]) => apiKey)).toEqual([
      "provider-test-token",
      "new-provider-test-token",
      "provider-test-token",
    ]);
  });

  it.each([
    ["missing", { state: "none" }],
    ["invalid", { state: "invalid", error: "OpenCode Go auth entry present but key is empty" }],
  ])("queries again after production availability sees %s auth", async (_name, auth) => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(NOT_SUBSCRIBED);
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce(auth);
    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      false,
    );
    await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(2);
  });
});

describe("opencode-go availability, model matching, and cache identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValue({ state: "none" });
  });

  it.each([
    [{ state: "configured", apiKey: "key" }, true],
    [{ state: "invalid", error: "bad auth" }, false],
    [{ state: "none" }, false],
  ])("maps API-key state %j to availability %s without a request", async (auth, expected) => {
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce(auth);

    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      expected,
    );
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it.each([
    { state: "configured", credential: { accessToken: "console-access" } },
    { state: "expired", credential: { accessToken: "console-access" } },
    { state: "invalid", error: "refresh_failed: HTTP 401" },
  ])("stays available for a $state Console sign-in without an API key", async (consoleAuth) => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce(consoleAuth);
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({ state: "none" });

    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      true,
    );
  });

  it("includes the selected Go windows in the provider cache identity", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const keyFor = (window: "rolling" | "monthly") =>
      buildQuotaProviderStateCacheKey(
        "opencode-go",
        createProviderAvailabilityContext({ configOverrides: { opencodeGoWindows: [window] } }),
      );

    expect(keyFor("rolling")).toContain("opencodeGoWindows=rolling");
    expect(keyFor("monthly")).toContain("opencodeGoWindows=monthly");
    expect(keyFor("rolling")).not.toBe(keyFor("monthly"));
  });

  it.each([
    ["opencode-go/some-model", true],
    ["opencode-go-subscription/any", true],
    ["openai/gpt-4", false],
    ["copilot/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeGoProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
