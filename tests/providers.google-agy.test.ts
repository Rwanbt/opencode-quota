import { describe, expect, it, vi } from "vitest";
import { googleAgyProvider } from "../src/providers/google-agy.js";
import { expectAttemptedWithNoErrors, visibleEntries } from "./helpers/provider-assertions.js";

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

describe("google agy provider", () => {
  it("maps weekly and five-hour summary rows with fixed labels and accounting metadata", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          window: "five_hour",
          windowLabel: "5h",
          bucketId: "gemini-five-hour",
          percentRemaining: 25,
          remainingAmount: "1234.5",
        }),
        bucket(),
        bucket({
          family: "Claude and GPT models",
          window: "five_hour",
          windowLabel: "5h",
          bucketId: "third-party-five-hour",
          percentRemaining: 90,
          remainingAmount: "1e3",
        }),
        bucket({
          family: "Claude and GPT models",
          bucketId: "third-party-weekly",
          percentRemaining: 100,
          resetTimeIso: "2026-06-23T00:00:00.000Z",
        }),
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as never);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "google-agy")).toEqual([
      {
        name: "Gemini Models (ali…)",
        group: "AGY (ali…): Gemini",
        label: "Weekly:",
        sortPriority: 0,
        percentRemaining: 58,
        resetTimeIso: undefined,
      },
      {
        name: "Gemini Models (ali…)",
        group: "AGY (ali…): Gemini",
        label: "5h:",
        sortPriority: 1,
        right: "1,234.5 left",
        percentRemaining: 25,
        resetTimeIso: undefined,
      },
      {
        name: "Claude and GPT models (ali…)",
        group: "AGY (ali…): Claude/GPT",
        label: "Weekly:",
        sortPriority: 0,
        percentRemaining: 100,
        resetTimeIso: "2026-06-23T00:00:00.000Z",
      },
      {
        name: "Claude and GPT models (ali…)",
        group: "AGY (ali…): Claude/GPT",
        label: "5h:",
        sortPriority: 1,
        right: "1,000 left",
        percentRemaining: 90,
        resetTimeIso: undefined,
      },
    ]);
    expect(out.errors).toEqual([{ label: "bob…", message: "Unauthorized" }]);
    expect(out.presentation).toEqual({
      singleWindowShowRight: true,
    });
    expect(out.entries.every((entry) => entry.accounting.sourceId === "account-1")).toBe(true);
  });

  it("keeps account order and email-less accounts distinct", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          accountEmail: undefined,
          accountIndex: 0,
          percentRemaining: 20,
        }),
        bucket({
          accountEmail: undefined,
          accountIndex: 1,
          percentRemaining: 80,
        }),
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as never);
    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "Gemini Models (Account 1)",
      "Gemini Models (Account 2)",
    ]);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "account-1",
      "account-2",
    ]);
    expect(out.entries.map((entry) => entry.percentRemaining)).toEqual([20, 80]);
  });

  it("sorts account, family, and weekly-before-five-hour independently of input order", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          accountIndex: 1,
          accountEmail: "bob@example.com",
          window: "five_hour",
          windowLabel: "5h",
        }),
        bucket({
          family: "Claude and GPT models",
          accountIndex: 0,
          window: "five_hour",
          windowLabel: "5h",
        }),
        bucket({ accountIndex: 0 }),
        bucket({
          family: "Claude and GPT models",
          accountIndex: 0,
        }),
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as never);
    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.group)).toEqual([
      "AGY (ali…): Gemini",
      "AGY (ali…): Claude/GPT",
      "AGY (ali…): Claude/GPT",
      "AGY (bob…): Gemini",
    ]);
  });

  it("preserves partial account errors when no summary rows succeed", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [],
      errors: [
        { email: "alice@example.com", error: "API timeout" },
        { email: "google-agy-auth", error: "Token revoked" },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as never);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      { label: "ali…", message: "API timeout" },
      { label: "goo…", message: "Token revoked" },
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
