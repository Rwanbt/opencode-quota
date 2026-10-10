import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasApiKey } from "../src/lib/api-key-resolver.js";
import { queryChutesQuota } from "../src/lib/chutes.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { chutesProvider } from "../src/providers/chutes.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/chutes.js", () => ({
  queryChutesQuota: vi.fn(),
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
  vi.mocked(queryChutesQuota).mockResolvedValueOnce(result as never);

describe("chutes provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when not configured", async () => {
    mockQuery(null);
    expectNotAttempted(await chutesProvider.fetch({} as any));
  });

  it("maps success into a toast entry", async () => {
    mockQuery({ success: true, percentRemaining: 75, resetTimeIso: "2026-01-02T00:00:00.000Z" });

    const out = await chutesProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "chutes")).toEqual([
      { name: "Chutes", percentRemaining: 75, resetTimeIso: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  it("maps errors into toast errors", async () => {
    mockQuery({ success: false, error: "Unauthorized" });
    expectAttemptedWithErrorLabel(await chutesProvider.fetch({} as any), "Chutes");
  });

  // A configured Chutes runtime provider is enough; otherwise a trusted API key is needed.
  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])("isAvailable with provider id=%s and API key=%s is %s", async (providerId, apiKey, expected) => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(providerId);
    vi.mocked(hasApiKey).mockResolvedValue(apiKey);

    await expect(chutesProvider.isAvailable({} as any)).resolves.toBe(expected);
  });
});
