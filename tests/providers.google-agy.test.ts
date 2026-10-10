import { describe, expect, it, vi } from "vitest";
import { rowsFromProviderResult } from "../src/core/rows.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

const mocks = vi.hoisted(() => ({ queryGoogleAgyQuota: vi.fn() }));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(async () => []),
}));
vi.mock("../src/lib/google-agy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-agy.js")>()),
  queryGoogleAgyQuota: mocks.queryGoogleAgyQuota,
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "missing",
    accountCount: 0,
    validAccountCount: 0,
  })),
  inspectAgyCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
}));

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    family: "Gemini Models",
    window: "weekly",
    windowLabel: "Weekly",
    bucketId: "gemini-weekly",
    percentRemaining: 58,
    accountEmail: "alice@example.com",
    accountIndex: 0,
    sourceKey: "google-agy",
    ...overrides,
  };
}

async function fetchRows() {
  return rowsFromProviderResult(
    "google-agy",
    await googleAgyProvider.fetch({ client: {} } as never),
  );
}

describe("google agy provider", () => {
  it("shows each family's weekly and 5h windows under the account", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({ window: "five_hour", windowLabel: "5h", percentRemaining: 25 }),
        bucket(),
        bucket({
          family: "Claude and GPT models",
          window: "five_hour",
          windowLabel: "5h",
          percentRemaining: 90,
        }),
        bucket({
          family: "Claude and GPT models",
          percentRemaining: 100,
          resetTimeIso: "2026-06-23T00:00:00.000Z",
        }),
        bucket({ family: "Quota Summary", accountIndex: 1, accountEmail: undefined }),
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const fetched = await fetchRows();

    expect(
      fetched.rows.map((row) => [row.id, row.account, row.label, row.window, row.percentRemaining]),
    ).toEqual([
      ["google-agy.gemini.weekly", "ali…", "Gemini Weekly", "week", 58],
      ["google-agy.gemini.five_hour", "ali…", "Gemini 5h", "five_hour", 25],
      ["google-agy.claude_gpt.weekly", "ali…", "Claude/GPT Weekly", "week", 100],
      ["google-agy.claude_gpt.five_hour", "ali…", "Claude/GPT 5h", "five_hour", 90],
      ["google-agy.quota_summary.weekly", "Account 2", "Quota Summary Weekly", "week", 58],
    ]);
    expect(fetched.rows[2]?.resetsAt).toBe("2026-06-23T00:00:00.000Z");
    expect(fetched.rowLogins).toEqual([...Array(4).fill("account-1"), "account-2"]);
    expect(fetched.debug).toContainEqual({ key: "error", value: "bob…: Unauthorized" });
  });

  it("keeps email-less accounts apart", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({ accountEmail: undefined, accountIndex: 0, percentRemaining: 20 }),
        bucket({ accountEmail: undefined, accountIndex: 1, percentRemaining: 80 }),
      ],
    });

    const fetched = await fetchRows();

    expect(fetched.error).toBeUndefined();
    expect(fetched.rows.map((row) => [row.id, row.account, row.percentRemaining])).toEqual([
      ["google-agy.gemini.weekly", "Account 1", 20],
      ["google-agy.gemini.weekly", "Account 2", 80],
    ]);
    expect(fetched.rowLogins).toEqual(["account-1", "account-2"]);
  });

  it("keeps account errors when no account has rows", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [],
      errors: [
        { email: "alice@example.com", error: "API timeout" },
        { email: "google-agy-auth", error: "Token revoked" },
      ],
    });

    const fetched = await fetchRows();

    expect(fetched.rows).toEqual([]);
    expect(fetched.debug.filter((detail) => detail.key === "error")).toEqual([
      { key: "error", value: "ali…: API timeout" },
      { key: "error", value: "goo…: Token revoked" },
    ]);
  });

  it.each([
    ["google-agy/gpt-4", true],
    ["opencode-agy-auth/gpt-4", true],
    ["google-agy-auth/gpt-4", true],
    ["google/claude-opus", false],
  ])("matches the existing Google AGY runtime ids: %s → %s", (model, expected) => {
    expect(googleAgyProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
