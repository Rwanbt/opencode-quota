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

import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";
import { createGoogleAccountLabelMap } from "../src/providers/google-oauth-provider.js";
import {
  expectAttemptedWithErrorLabel,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

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
    loginEntryName: "Gemini Weekly",
  },
  {
    name: "Gemini CLI",
    integrationId: "google-gemini-cli",
    provider: googleGeminiCliProvider,
    lib: mocks.gemini,
    bucket: { displayName: "Gemini 2.5", percentRemaining: 70 },
    loginEntryName: "Gemini 2.5",
  },
] as const;

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

  it("returns attempted:false without a login and one error row when the query fails", async () => {
    lib.query.mockResolvedValueOnce(null);
    expectNotAttempted(await provider.fetch({ client: {} } as never));

    lib.query.mockResolvedValueOnce({ success: false, error: `No ${name} quota data available` });
    expectAttemptedWithErrorLabel(await provider.fetch({ client: {} } as never), name);
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

    const out = await provider.fetch({ client: {} } as never);
    expect(out.statusDetails).toEqual([
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

    const output = await provider.fetch({ client: {}, config: {} } as never);

    expect(lib.query).toHaveBeenCalledTimes(2);
    expect(lib.query).toHaveBeenCalledWith({
      requestTimeoutMs: undefined,
      authData: { [integrationId]: { type: "oauth", refresh: "two|project" } },
    });
    expect(
      output.entries.map((entry) => [entry.name, entry.group, entry.accounting.sourceId]),
    ).toEqual([
      [`[${name} Work] (active) ${flavor.loginEntryName}`, `[${name} Work] (active)`, "active-id"],
      [`[${name} Work 2] ${flavor.loginEntryName}`, `[${name} Work 2]`, "other-id"],
    ]);
  });
});

describe("google account labels", () => {
  it("formats real ellipsis labels without repeating the domain", () => {
    expect([
      ...createGoogleAccountLabelMap([
        "alice@example.com",
        "bo@example.com",
        "local-only",
        undefined,
      ]).values(),
    ]).toEqual(["ali…", "bo…", "loc…"]);
  });

  it("extends or numbers colliding account hints without repeating domains", () => {
    const labels = createGoogleAccountLabelMap([
      "alice@work.com",
      "alicia@example.com",
      "alice@personal.com",
    ]);

    expect(labels.get("alice@work.com")).toBe("alice… 1");
    expect(labels.get("alicia@example.com")).toBe("alici…");
    expect(labels.get("alice@personal.com")).toBe("alice… 2");
    expect(new Set(labels.values()).size).toBe(3);
  });
});
