import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasApiKey } from "../src/lib/api-key-resolver.js";
import { queryNanoGptQuota } from "../src/lib/nanogpt.js";
import { nanoGptProvider } from "../src/providers/nanogpt.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/nanogpt.js", () => ({
  queryNanoGptQuota: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  hasApiKey: vi.fn(),
  getApiKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
}));

const mockQuery = (result: unknown) =>
  vi.mocked(queryNanoGptQuota).mockResolvedValueOnce(result as never);

function requests(decimal: string) {
  return {
    quantity: { decimal, unit: { kind: "count", unit: "request" } },
    authority: "provider_reported",
  };
}

function quotaEntry(window: "day" | "month", percentRemaining: number, resetTimeIso: string) {
  return {
    name: `nanogpt-${window}-quota`,
    group: "NanoGPT",
    percentRemaining,
    resetTimeIso,
    semantic: { metric: { kind: "window", window }, prominence: "primary" },
  };
}

function balanceEntry(quantity: { decimal: string; unit: Record<string, string> }) {
  return {
    kind: "quantity",
    name: "nanogpt-current-balance",
    group: "NanoGPT",
    semantic: {
      metric: { kind: "component", component: "current_balance" },
      prominence: "primary",
    },
    quantity,
  };
}

describe("nanogpt provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when not configured", async () => {
    mockQuery(null);
    expectNotAttempted(await nanoGptProvider.fetch({} as any));
  });

  it("maps canonical grouped-capable rows for daily, monthly, and balance", async () => {
    mockQuery({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        daily: {
          used: 5,
          limit: 5000,
          remaining: 4995,
          percentRemaining: 100,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
          reportedBasis: { used: 5, limit: 5000, remaining: 4995 },
        },
        monthly: {
          used: 50,
          limit: 60000,
          remaining: 59950,
          percentRemaining: 100,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
          reportedBasis: { used: 50, limit: 60000, remaining: 59950 },
        },
      },
      balance: { usdBalanceRaw: "12.3400", nanoBalanceRaw: "99.5" },
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "nanogpt")).toEqual([
      {
        ...quotaEntry("day", 100, "2026-01-02T00:00:00.000Z"),
        basis: { used: requests("5"), limit: requests("5000"), remaining: requests("4995") },
      },
      {
        ...quotaEntry("month", 100, "2026-02-01T00:00:00.000Z"),
        basis: { used: requests("50"), limit: requests("60000"), remaining: requests("59950") },
      },
      balanceEntry({ decimal: "12.3400", unit: { kind: "currency", code: "USD" } }),
    ]);
    expect(out.presentation).toBeUndefined();
  });

  it("omits locally derived fallback values from provider-reported basis", async () => {
    mockQuery({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: false,
        daily: {
          used: 0,
          limit: 100,
          remaining: 75,
          percentRemaining: 75,
          reportedBasis: { limit: 100 },
        },
      },
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);

    expect(visibleEntries(out.entries, "nanogpt")[0]?.basis).toEqual({ limit: requests("100") });
  });

  it("maps partial endpoint errors and non-active subscription state", async () => {
    mockQuery({
      success: true,
      subscription: {
        active: false,
        state: "grace",
        enforceDailyLimit: true,
        daily: {
          used: 100,
          limit: 100,
          remaining: 0,
          percentRemaining: 0,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
          reportedBasis: { used: 100, limit: 100, remaining: 0 },
        },
      },
      endpointErrors: [{ endpoint: "balance", message: "NanoGPT API error 401: Unauthorized" }],
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "nanogpt")).toEqual([
      {
        ...quotaEntry("day", 0, "2026-01-02T00:00:00.000Z"),
        basis: { used: requests("100"), limit: requests("100"), remaining: requests("0") },
      },
    ]);
    expect(out.errors).toEqual([
      { label: "NanoGPT Balance", message: "NanoGPT API error 401: Unauthorized" },
      { label: "NanoGPT", message: "Subscription state: grace" },
    ]);
  });

  it("falls back to valid NANO and preserves its malformed USD sibling as a partial error", async () => {
    const message = "NanoGPT balance response returned an invalid usd_balance decimal";
    mockQuery({
      success: true,
      balance: { nanoBalanceRaw: "26.71801147" },
      endpointErrors: [{ endpoint: "balance", message }],
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);

    expect(visibleEntries(out.entries, "nanogpt")).toEqual([
      balanceEntry({ decimal: "26.71801147", unit: { kind: "custom", symbol: "NANO" } }),
    ]);
    expect(out.errors).toEqual([{ label: "NanoGPT Balance", message }]);
  });

  it.each([
    ["hard failures", { success: false, error: "Usage: Unauthorized; Balance: Unauthorized" }],
    [
      "missing usable data",
      { success: true, subscription: { active: true, state: "active", enforceDailyLimit: true } },
    ],
  ])("maps %s into a NanoGPT error", async (_name, result) => {
    mockQuery(result);
    expectAttemptedWithErrorLabel(await nanoGptProvider.fetch({ config: {} } as any), "NanoGPT");
  });

  it("matches NanoGPT model ids", () => {
    expect(nanoGptProvider.matchesCurrentModel?.("nanogpt/gpt-oss-120b")).toBe(true);
    expect(nanoGptProvider.matchesCurrentModel?.("nano-gpt/gpt-5")).toBe(true);
    expect(nanoGptProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  // Only a trusted API key counts; the runtime provider list does not.
  it.each([
    [{ providerIds: ["nanogpt"] }, true, true],
    [{ providerIds: ["openai"] }, true, true],
    [{ providerIds: ["nanogpt"] }, false, false],
    [{ providersError: new Error("boom") }, false, false],
  ])("isAvailable with providers %j and an API key=%s is %s", async (ctx, keyConfigured, expected) => {
    vi.mocked(hasApiKey).mockResolvedValueOnce(keyConfigured);

    await expect(nanoGptProvider.isAvailable(createProviderAvailabilityContext(ctx))).resolves.toBe(
      expected,
    );
  });
});
