import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasApiKey } from "../src/lib/api-key-resolver.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { querySyntheticQuota } from "../src/lib/synthetic.js";
import { syntheticProvider } from "../src/providers/synthetic.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/synthetic.js", () => ({
  querySyntheticQuota: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  hasApiKey: vi.fn(),
  getApiKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

const mockQuery = (result: unknown) =>
  vi.mocked(querySyntheticQuota).mockResolvedValueOnce(result as never);

describe("synthetic provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when not configured", async () => {
    mockQuery(null);
    expectNotAttempted(await syntheticProvider.fetch({} as any));
  });

  it.each([
    [{ limit: 100, used: 25.5, percentRemaining: 75 }, "26/100"],
    [{ limit: 500, used: 52.4, percentRemaining: 90 }, "52/500"],
  ])("maps both windows with rounded usage summaries (5h %j)", async (fiveHour, right) => {
    mockQuery({
      success: true,
      windows: {
        fiveHour: { ...fiveHour, resetTimeIso: "2026-01-20T18:12:03.000Z" },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2026-01-27T18:12:03.000Z",
        },
      },
    });

    const out = await syntheticProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "synthetic")).toEqual([
      {
        name: "Synthetic 5h",
        group: "Synthetic",
        label: "5h:",
        percentRemaining: fiveHour.percentRemaining,
        right,
        resetTimeIso: "2026-01-20T18:12:03.000Z",
      },
      {
        name: "Synthetic Weekly",
        group: "Synthetic",
        label: "Weekly:",
        percentRemaining: 8,
        right: "$22/$24",
        resetTimeIso: "2026-01-27T18:12:03.000Z",
      },
    ]);
    expect(out.presentation).toEqual({ singleWindowShowRight: true });
  });

  it("maps a query error without fabricating quota rows", async () => {
    mockQuery({ success: false, error: "Synthetic returned no quota data for this account." });

    const out = await syntheticProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Synthetic");
    expect(out.errors).toEqual([
      { label: "Synthetic", message: "Synthetic returned no quota data for this account." },
    ]);
    expect(out.presentation).toBeUndefined();
  });

  it("matches synthetic model prefixes", () => {
    expect(syntheticProvider.matchesCurrentModel?.("synthetic/claude")).toBe(true);
    expect(syntheticProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  // A configured Synthetic runtime provider is enough; otherwise a trusted API key is needed.
  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])("isAvailable with provider id=%s and API key=%s is %s", async (providerId, apiKey, expected) => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(providerId);
    vi.mocked(hasApiKey).mockResolvedValue(apiKey);

    await expect(syntheticProvider.isAvailable({} as any)).resolves.toBe(expected);
  });
});
