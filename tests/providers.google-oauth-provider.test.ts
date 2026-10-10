// The provider flow shared by Google AGY and Gemini CLI (src/providers/google-oauth-provider.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCredentialRows: vi.fn(),
  agy: {
    query: vi.fn(),
    hasRuntime: vi.fn(),
    inspectAuth: vi.fn(),
    inspectCompanion: vi.fn(),
  },
  gemini: {
    query: vi.fn(),
    hasRuntime: vi.fn(),
    inspectAuth: vi.fn(),
    inspectCompanion: vi.fn(),
  },
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: mocks.readCredentialRows,
}));
vi.mock("../src/lib/google-agy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-agy.js")>()),
  queryGoogleAgyQuota: mocks.agy.query,
  hasAgyQuotaRuntimeAvailable: mocks.agy.hasRuntime,
  inspectAgyAuthPresence: mocks.agy.inspectAuth,
  inspectAgyCompanionPresence: mocks.agy.inspectCompanion,
}));
vi.mock("../src/lib/google-gemini-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-gemini-cli.js")>()),
  queryGeminiCliQuota: mocks.gemini.query,
  hasGeminiCliQuotaRuntimeAvailable: mocks.gemini.hasRuntime,
  inspectGeminiCliAuthPresence: mocks.gemini.inspectAuth,
  inspectGeminiCliCompanionPresence: mocks.gemini.inspectCompanion,
}));

import { legacyResultFromFetch, rowsFromProviderResult } from "../src/core/rows.js";
import { normalizeQuotaProviderResult } from "../src/lib/quota-state-codec.js";
import type { ProviderFetchResult } from "../src/providers/contract.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";

const PROVIDERS = [
  {
    name: "Google AGY",
    integrationId: "google-agy",
    provider: googleAgyProvider,
    lib: mocks.agy,
    bucket: {
      family: "Gemini Models",
      window: "weekly",
      windowLabel: "Weekly",
      accountIndex: 0,
      percentRemaining: 70,
    },
    rowId: "google-agy.gemini.weekly",
  },
  {
    name: "Gemini CLI",
    integrationId: "google-gemini-cli",
    provider: googleGeminiCliProvider,
    lib: mocks.gemini,
    bucket: { displayName: "Gemini 2.5", percentRemaining: 70 },
    rowId: "google-gemini-cli.model.2_5",
  },
] as const;

async function fetchRows(provider: (typeof PROVIDERS)[number]["provider"], config = {}) {
  return rowsFromProviderResult(provider.id, await provider.fetch({ client: {}, config } as never));
}

beforeEach(() => {
  mocks.readCredentialRows.mockResolvedValue([]);
  for (const lib of [mocks.agy, mocks.gemini]) {
    lib.inspectAuth.mockResolvedValue({ state: "missing", accountCount: 0, validAccountCount: 0 });
    lib.inspectCompanion.mockResolvedValue({ state: "missing", error: "companion unavailable" });
  }
});

describe.each(PROVIDERS)("$name provider", ({ name, integrationId, provider, lib, ...flavor }) => {
  it("passes the request timeout only when the user configured it", async () => {
    lib.query.mockResolvedValue(null);

    await provider.fetch({ client: {}, config: { requestTimeoutMs: 5000 } } as never);
    expect(lib.query).toHaveBeenLastCalledWith({ requestTimeoutMs: undefined });

    await provider.fetch({
      client: {},
      config: { requestTimeoutMs: 12000, requestTimeoutMsConfigured: true },
    } as never);
    expect(lib.query).toHaveBeenLastCalledWith({ requestTimeoutMs: 12000 });
  });

  it("is not set up without a login and shows the error when the query fails", async () => {
    lib.query.mockResolvedValueOnce(null);
    expect(await fetchRows(provider)).toMatchObject({
      rows: [],
      error: { code: "not_configured" },
    });

    lib.query.mockResolvedValueOnce({ success: false, error: `No ${name} quota data available` });
    const failed = await fetchRows(provider);
    expect(failed).toMatchObject({ rows: [], error: { code: "no_data" } });
    expect(failed.debug).toContainEqual({
      key: "error",
      value: `${name}: No ${name} quota data available`,
    });
  });

  it("is available only when the runtime check succeeds", async () => {
    lib.hasRuntime.mockResolvedValueOnce(true);
    await expect(provider.isAvailable({ client: {} } as never)).resolves.toBe(true);
    lib.hasRuntime.mockResolvedValueOnce(false);
    await expect(provider.isAvailable({ client: {} } as never)).resolves.toBe(false);
    lib.hasRuntime.mockRejectedValueOnce(new Error("broken"));
    await expect(provider.isAvailable({ client: {} } as never)).resolves.toBe(false);
  });

  it("reports auth and companion state in status details", async () => {
    lib.query.mockResolvedValueOnce(null);
    lib.inspectAuth.mockResolvedValueOnce({
      state: "invalid",
      sourceKey: integrationId,
      accountCount: 1,
      validAccountCount: 0,
      error: "missing project id",
    });
    lib.inspectCompanion.mockResolvedValueOnce({
      state: "invalid",
      resolvedPath: "/plugin/constants.ts",
      error: "incompatible",
    });

    const { debug } = await fetchRows(provider);
    expect(debug).toEqual([
      { key: "auth_state", value: "invalid" },
      { key: "auth_source", value: integrationId },
      { key: "account_count", value: "1" },
      { key: "valid_account_count", value: "0" },
      { key: "companion_package_state", value: "invalid" },
      { key: "companion_package_path", value: "/plugin/constants.ts" },
      { key: "auth_error", value: "missing project id" },
      { key: "companion_error", value: "incompatible" },
    ]);
  });

  it("queries every DB login without deduping duplicate aliases", async () => {
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "active-id",
        integrationId,
        label: "Work",
        active: true,
        value: { type: "oauth", refresh: "one|project" },
      },
      {
        id: "other-id",
        integrationId,
        label: "Work",
        active: false,
        value: { type: "oauth", refresh: "two|project" },
      },
    ]);
    lib.query.mockResolvedValue({ success: true, buckets: [flavor.bucket] });

    const fetched = await fetchRows(provider);

    expect(lib.query).toHaveBeenCalledTimes(2);
    expect(lib.query).toHaveBeenCalledWith({
      requestTimeoutMs: undefined,
      authData: { [integrationId]: { type: "oauth", refresh: "two|project" } },
    });
    expect(fetched.rows.map((row) => [row.id, row.account, row.percentRemaining])).toEqual([
      [flavor.rowId, "Work", 70],
      [flavor.rowId, "Work 2", 70],
    ]);
    expect(fetched.rowLogins).toEqual(["active-id", "other-id"]);
  });
});

describe.each(PROVIDERS)("$name account labels", ({ provider, lib, bucket }) => {
  it.each([
    [
      "short hints without the domain",
      ["alice@example.com", "bo@example.com", "local-only"],
      ["ali…", "bo…", "loc…"],
    ],
    [
      "extended or numbered hints where they would collide",
      ["alice@work.com", "alicia@example.com", "alice@personal.com"],
      ["alice… 1", "alici…", "alice… 2"],
    ],
  ])("names accounts with %s", async (_name, emails, accounts) => {
    lib.query.mockResolvedValueOnce({
      success: true,
      buckets: emails.map((accountEmail, accountIndex) => ({
        ...bucket,
        accountEmail,
        accountIndex,
      })),
    });

    const fetched = await fetchRows(provider);

    expect(fetched.rows.map((row) => row.account)).toEqual(accounts);
  });
});

const TOKENS = { kind: "count", unit: "token" } as const;
const REQUESTS = { kind: "count", unit: "request" } as const;
const PLAIN = { kind: "count", unit: "unit" } as const;

describe("google remaining counts", () => {
  it.each([
    ["Google AGY", { remainingAmount: "1200" }, "1,200 left", { decimal: "1200", unit: PLAIN }],
    ["Google AGY", {}, undefined, undefined],
    [
      "Gemini CLI",
      { remainingAmount: "1200", tokenType: "TOKENS" },
      "1,200 left TOKENS",
      { decimal: "1200", unit: TOKENS },
    ],
    [
      "Gemini CLI",
      { remainingAmount: "0042", tokenType: "requests" },
      "42 left",
      { decimal: "42", unit: REQUESTS },
    ],
    [
      "Gemini CLI",
      { remainingAmount: "1234567" },
      "1,234,567 left",
      { decimal: "1234567", unit: PLAIN },
    ],
    [
      "Gemini CLI",
      { remainingAmount: "12.5", tokenType: "TOKENS" },
      "12.5 left TOKENS",
      { decimal: "12.5", unit: TOKENS },
    ],
    ["Google AGY", { remainingAmount: "007.250" }, "7.25 left", { decimal: "7.25", unit: PLAIN }],
    ["Gemini CLI", { tokenType: "TOKENS" }, undefined, undefined],
  ])("%s %j shows %j and keeps the count", async (name, fields, right, remaining) => {
    const flavor = PROVIDERS.find((candidate) => candidate.name === name);
    if (!flavor) throw new Error(`no provider ${name}`);
    flavor.lib.query.mockResolvedValueOnce({
      success: true,
      buckets: [{ ...flavor.bucket, ...fields }],
    });

    const result = (await flavor.provider.fetch({
      client: {},
      config: {},
    } as never)) as ProviderFetchResult;

    const legacy = normalizeQuotaProviderResult(legacyResultFromFetch(result));
    expect(legacy?.entries.map((entry) => entry.right)).toEqual([right]);
    expect(
      rowsFromProviderResult(flavor.provider.id, result).rows.map((row) => row.remaining),
    ).toEqual([remaining]);
  });
});
