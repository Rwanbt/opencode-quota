import { describe, expect, it, vi } from "vitest";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";
import { visibleEntries } from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  readCredentialRows: vi.fn(async () => [] as unknown[]),
  queryGeminiCliQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: mocks.readCredentialRows,
}));
vi.mock("../src/lib/google-gemini-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-gemini-cli.js")>()),
  queryGeminiCliQuota: mocks.queryGeminiCliQuota,
  inspectGeminiCliAuthPresence: vi.fn(async () => ({
    state: "missing",
    accountCount: 0,
    validAccountCount: 0,
  })),
  inspectGeminiCliCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
}));

describe("google gemini cli provider", () => {
  it("maps quality-tier buckets into grouped entries with amounts, token types, and labels", async () => {
    mocks.queryGeminiCliQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          displayName: "Gemini Pro",
          accountEmail: "alice@example.com",
          percentRemaining: 20,
          resetTimeIso: "2026-01-01T12:00:00Z",
          remainingAmount: "50",
          tokenType: "TOKENS",
        },
        {
          modelId: "gemini-2.5-flash",
          displayName: "Gemini Flash",
          accountEmail: "alice@example.com",
          percentRemaining: 50,
          resetTimeIso: "2026-01-01T08:00:00Z",
          remainingAmount: "1000",
          tokenType: "REQUESTS",
        },
        {
          modelId: "gemini-2.5-flash-lite",
          displayName: "Gemini Flash Lite",
          accountEmail: "alice@example.com",
          percentRemaining: 10,
          resetTimeIso: "2026-01-01T06:00:00Z",
          remainingAmount: "25",
          tokenType: "REQUESTS",
        },
        { modelId: "gemini-2.5-pro", displayName: "Gemini Pro", percentRemaining: 5 },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleGeminiCliProvider.fetch({ client: {} } as never);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "google-gemini-cli")).toEqual([
      {
        name: "Gemini Pro (ali…)",
        group: "Gemini CLI (ali…)",
        label: "Gemini Pro:",
        right: "50 left TOKENS",
        percentRemaining: 20,
        resetTimeIso: "2026-01-01T12:00:00Z",
      },
      {
        name: "Gemini Flash (ali…)",
        group: "Gemini CLI (ali…)",
        label: "Gemini Flash:",
        right: "1,000 left",
        percentRemaining: 50,
        resetTimeIso: "2026-01-01T08:00:00Z",
      },
      {
        name: "Gemini Flash Lite (ali…)",
        group: "Gemini CLI (ali…)",
        label: "Gemini Flash Lite:",
        right: "25 left",
        percentRemaining: 10,
        resetTimeIso: "2026-01-01T06:00:00Z",
      },
      {
        name: "Gemini Pro (Unknown)",
        group: "Gemini CLI (Unknown)",
        label: "Gemini Pro:",
        percentRemaining: 5,
        resetTimeIso: undefined,
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "alice@example.com",
      "alice@example.com",
      "alice@example.com",
      undefined,
    ]);
    expect(out.errors).toEqual([{ label: "bob…", message: "Unauthorized" }]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Gemini CLI",
      singleWindowShowRight: true,
    });
  });

  it("adds an error row per login OpenCode could not return, next to working accounts", async () => {
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "failed-id",
        integrationId: "google",
        label: "work@example.com",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 400",
      },
      {
        id: "working-id",
        integrationId: "google-gemini-cli",
        label: "home@example.com",
        active: false,
        value: { type: "oauth", refresh: "refresh-token|project-id" },
      },
    ]);
    mocks.queryGeminiCliQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          displayName: "Gemini Pro",
          accountEmail: "home@example.com",
          percentRemaining: 64,
        },
      ],
    });

    const out = await googleGeminiCliProvider.fetch({ client: {} } as never);

    expect(mocks.readCredentialRows).toHaveBeenCalledWith(
      ["google-gemini-cli", "gemini-cli", "opencode-gemini-auth", "gemini", "google"],
      { methods: ["oauth"] },
    );
    // Only the working row is queried.
    expect(mocks.queryGeminiCliQuota).toHaveBeenCalledTimes(1);
    expect(mocks.queryGeminiCliQuota).toHaveBeenLastCalledWith({
      requestTimeoutMs: undefined,
      authData: { "google-gemini-cli": { type: "oauth", refresh: "refresh-token|project-id" } },
    });
    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([
      {
        label: "[Gemini CLI work@example.com] (active)",
        message:
          "Gemini CLI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth login google`.",
      },
    ]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Gemini CLI home@example.com]", "working-id"],
    ]);
  });

  it.each([
    ["google-gemini-cli/gemini-3-pro", true],
    ["gemini-cli/gemini-3-flash", true],
    ["google/gemini-2.5-pro", true],
    ["google/claude-opus", false],
    ["google/antigravity-gemini-3-pro", false],
  ])("matches Gemini CLI current model ids: %s → %s", (model, expected) => {
    expect(googleGeminiCliProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
