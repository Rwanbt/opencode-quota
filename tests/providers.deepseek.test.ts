import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasApiKey } from "../src/lib/api-key-resolver.js";
import { queryDeepSeekBalance } from "../src/lib/deepseek.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { deepseekProvider } from "../src/providers/deepseek.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/deepseek.js", () => ({
  queryDeepSeekBalance: vi.fn(),
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

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

const mockQuery = (result: unknown) =>
  vi.mocked(queryDeepSeekBalance).mockResolvedValueOnce(result as never);

function balance(currency: "USD" | "CNY", component: string, decimal: string) {
  return {
    kind: "quantity",
    name: `deepseek-${currency.toLowerCase()}-${component.replaceAll("_", "-")}`,
    group: "DeepSeek",
    semantic: {
      metric: { kind: "component", component },
      prominence: component === "total_balance" ? "primary" : "supplementary",
    },
    quantity: { decimal, unit: { kind: "currency", code: currency } },
  };
}

const INVALID_USD_TOTAL = {
  label: "DeepSeek USD",
  message: "total_balance returned an invalid decimal",
};

describe("deepseek provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when not configured", async () => {
    mockQuery(null);
    expectNotAttempted(await deepseekProvider.fetch({} as any));
  });

  it("maps separate currencies and exact source precision into complete semantic rows", async () => {
    mockQuery({
      success: true,
      isAvailable: true,
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "12.340000000000000001",
          grantedBalance: "2.00",
          toppedUpBalance: "10.340000000000000001",
        },
        {
          currency: "CNY",
          totalBalance: "88.00",
          grantedBalance: "0.00",
          toppedUpBalance: "88.00",
        },
      ],
      parseIssues: [],
    });

    const out = await deepseekProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);
    expectAttemptedWithNoErrors(out);
    expect(queryDeepSeekBalance).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      balance("USD", "total_balance", "12.340000000000000001"),
      balance("USD", "granted_balance", "2.00"),
      balance("USD", "topped_up_balance", "10.340000000000000001"),
      balance("CNY", "total_balance", "88.00"),
      balance("CNY", "granted_balance", "0.00"),
      balance("CNY", "topped_up_balance", "88.00"),
    ]);
    expect(out.entries.every((entry) => entry.accounting.resultType === "balance")).toBe(true);
  });

  it.each([
    [
      "a malformed total next to valid components",
      {
        isAvailable: true,
        balanceInfos: [
          { currency: "USD", grantedBalance: "1.25", toppedUpBalance: "3.75" },
          { currency: "CNY", totalBalance: "8.5" },
        ],
      },
      [
        balance("USD", "granted_balance", "1.25"),
        balance("USD", "topped_up_balance", "3.75"),
        balance("CNY", "total_balance", "8.5"),
      ],
    ],
    // No total balance and no reported availability: no availability row is invented.
    [
      "a malformed total without availability",
      { isAvailable: undefined, balanceInfos: [{ currency: "USD", grantedBalance: "1.25" }] },
      [balance("USD", "granted_balance", "1.25")],
    ],
  ])("keeps valid rows and reports %s without inventing zero", async (_name, result, entries) => {
    mockQuery({
      success: true,
      ...result,
      parseIssues: [{ currency: "USD", field: "total_balance" }],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);

    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "deepseek")).toEqual(entries);
    expect(out.errors).toEqual([INVALID_USD_TOTAL]);
  });

  it.each([
    true,
    false,
  ])("maps an empty balance response into a semantic boolean (%s)", async (isAvailable) => {
    mockQuery({ success: true, isAvailable, balanceInfos: [], parseIssues: [] });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      {
        kind: "boolean",
        name: "deepseek-availability",
        group: "DeepSeek",
        semantic: { metric: { kind: "named", name: "Availability" }, prominence: "primary" },
        value: isAvailable,
      },
    ]);
    expect(out.entries[0]?.accounting.resultType).toBe("status");
  });

  it("returns no data when an empty response omits availability", async () => {
    mockQuery({ success: true, isAvailable: undefined, balanceInfos: [], parseIssues: [] });

    const out = await deepseekProvider.fetch({ config: {} } as any);

    expect(out).toMatchObject({ attempted: true, entries: [], errors: [] });
  });

  it("maps errors into toast errors", async () => {
    mockQuery({ success: false, error: "Unauthorized" });
    expectAttemptedWithErrorLabel(await deepseekProvider.fetch({} as any), "DeepSeek");
  });

  it("matches DeepSeek model ids", () => {
    expect(deepseekProvider.matchesCurrentModel?.("deepseek/deepseek-chat")).toBe(true);
    expect(deepseekProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  // A configured DeepSeek runtime provider is enough; otherwise a trusted API key is needed.
  it.each([
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])("isAvailable with provider id=%s and API key=%s is %s", async (providerId, apiKey, expected) => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(providerId);
    vi.mocked(hasApiKey).mockResolvedValue(apiKey);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(expected);
  });
});
