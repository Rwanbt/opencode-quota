import { describe, expect, it, vi } from "vitest";
import { rowsFromProviderResult } from "../src/core/rows.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";

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

async function fetchRows() {
  return rowsFromProviderResult(
    "google-gemini-cli",
    await googleGeminiCliProvider.fetch({ client: {} } as never),
  );
}

describe("google gemini cli provider", () => {
  it("keys the quality tiers and other models, per account", async () => {
    mocks.queryGeminiCliQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          displayName: "Gemini Pro",
          accountEmail: "alice@example.com",
          percentRemaining: 20,
          resetTimeIso: "2026-01-01T12:00:00Z",
        },
        { displayName: "Gemini Flash", accountEmail: "alice@example.com", percentRemaining: 50 },
        {
          displayName: "Gemini Flash Lite",
          accountEmail: "alice@example.com",
          percentRemaining: 10,
        },
        { displayName: "Gemini 3 Daily", accountEmail: "alice@example.com", percentRemaining: 30 },
        { displayName: "Gemini Pro", percentRemaining: 5 },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const fetched = await fetchRows();

    expect(fetched.rows.map((row) => [row.id, row.account, row.label, row.window ?? null])).toEqual(
      [
        ["google-gemini-cli.pro", "ali…", "Pro", null],
        ["google-gemini-cli.flash", "ali…", "Flash", null],
        ["google-gemini-cli.flash_lite", "ali…", "Flash Lite", null],
        ["google-gemini-cli.model.3_daily", "ali…", "3 Daily", "day"],
        ["google-gemini-cli.pro", "Unknown", "Pro", null],
      ],
    );
    expect(fetched.rows[0]?.resetsAt).toBe("2026-01-01T12:00:00Z");
    expect(fetched.rowLogins).toEqual([...Array(4).fill("alice@example.com"), ""]);
    expect(fetched.debug).toContainEqual({ key: "error", value: "bob…: Unauthorized" });
  });

  it("shows a login OpenCode could not return as an error, next to working ones", async () => {
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
        { displayName: "Gemini Pro", accountEmail: "home@example.com", percentRemaining: 64 },
      ],
    });

    const fetched = await fetchRows();

    expect(mocks.readCredentialRows).toHaveBeenCalledWith(
      ["google-gemini-cli", "gemini-cli", "opencode-gemini-auth", "gemini", "google"],
      { methods: ["oauth"] },
    );
    // Only the working login is queried.
    expect(mocks.queryGeminiCliQuota).toHaveBeenCalledExactlyOnceWith({
      requestTimeoutMs: undefined,
      authData: { "google-gemini-cli": { type: "oauth", refresh: "refresh-token|project-id" } },
    });
    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["google-gemini-cli.pro", "home@example.com"],
    ]);
    expect(fetched.rowLogins).toEqual(["working-id"]);
    expect(fetched.debug).toContainEqual({
      key: "error",
      value:
        "[Gemini CLI [email]] (active): Gemini CLI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth login google`.",
    });
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
