import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  getApiKeyDiagnostics: vi.fn(),
  hasApiKey: vi.fn(),
  queryKiloQuota: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  getApiKeyDiagnostics: mocks.getApiKeyDiagnostics,
  hasApiKey: mocks.hasApiKey,
}));

vi.mock("../src/lib/kilo.js", () => ({
  queryKiloQuota: mocks.queryKiloQuota,
}));

import { kiloProvider } from "../src/providers/kilo.js";

const REMAINING_CREDITS = {
  metric: { kind: "component", component: "remaining_credits" },
  prominence: "primary",
};

function usd(decimal: string) {
  return { decimal, unit: { kind: "currency", code: "USD" } };
}

/** Used is reported by Kilo; the limit (base + bonus) and what is left are computed here. */
function usdBasis(used: string, limit: string, remaining: string) {
  return {
    used: { quantity: usd(used), authority: "provider_reported" },
    limit: { quantity: usd(limit), authority: "locally_derived" },
    remaining: { quantity: usd(remaining), authority: "locally_derived" },
  };
}

function kiloPass(fields: Record<string, unknown>) {
  return { success: true, mode: "kilo_pass", ...fields };
}

describe("Kilo Gateway provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:KILO_API_KEY",
      checkedPaths: ["env:KILO_API_KEY"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
  });

  it("uses the documented canonical provider identity and model prefix", () => {
    expect(kiloProvider.id).toBe("kilo");
    expect(kiloProvider.matchesCurrentModel?.("kilo/anthropic/claude-sonnet-4")).toBe(true);
    expect(kiloProvider.matchesCurrentModel?.("kilo-gateway/model")).toBe(false);
    expect(kiloProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available only when a trusted Kilo API key exists", async () => {
    mocks.hasApiKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(true);
    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce(null);

    const out = await kiloProvider.fetch({} as any);

    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_configured", value: "true" },
        { key: "api_key_source", value: "env:KILO_API_KEY" },
      ]),
    );
  });

  it("maps one structured Kilo Pass percentage with complete USD basis", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce(
      kiloPass({
        baseCreditsUsd: 10,
        usageUsd: 2.5,
        bonusCreditsUsd: 5,
        remainingUsd: 12.5,
        overageUsd: 0,
        resetTimeIso: "2099-02-01T00:00:00.000Z",
      }),
    );

    const out = await kiloProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(mocks.queryKiloQuota).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        percentRemaining: 83.33333333333334,
        semantic: REMAINING_CREDITS,
        basis: usdBasis("2.5", "15", "12.5"),
        resetTimeIso: "2099-02-01T00:00:00.000Z",
      },
    ]);
    expect(out.entries[0]?.accounting).toEqual({
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    });
    expect(out.presentation).toBeUndefined();
    const rawDetails = [
      { key: "base_credits_usd", value: "$10.00" },
      { key: "usage_usd", value: "$2.50" },
      { key: "bonus_credits_usd", value: "$5.00" },
      { key: "remaining_usd", value: "$12.50" },
      { key: "overage_usd", value: "$0.00" },
      { key: "reset_at", value: "2099-02-01T00:00:00.000Z" },
    ];
    expect(out.rawDetails).toEqual(rawDetails);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([{ key: "accounting_mode", value: "kilo_pass" }, ...rawDetails]),
    );
    // The USD amounts stay in the details; the row carries only exact decimals.
    expect(JSON.stringify(out.entries)).not.toContain("$");
  });

  it.each([
    [
      "no bonus",
      { baseCreditsUsd: 10, usageUsd: 2.5, bonusCreditsUsd: 0, remainingUsd: 7.5, overageUsd: 0 },
      75,
      usdBasis("2.5", "10", "7.5"),
      [],
    ],
    [
      "usage above the quota (zero percent, zero left, overage only in the details)",
      { baseCreditsUsd: 10, usageUsd: 12, bonusCreditsUsd: 0, remainingUsd: 0, overageUsd: 2 },
      0,
      usdBasis("12", "10", "0"),
      [
        { key: "usage_usd", value: "$12.00" },
        { key: "remaining_usd", value: "$0.00" },
        { key: "overage_usd", value: "$2.00" },
      ],
    ],
  ])("maps a Kilo Pass with %s", async (_name, state, percentRemaining, basis, rawDetails) => {
    mocks.queryKiloQuota.mockResolvedValueOnce(kiloPass(state));

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        name: "kilo-gateway-credits",
        group: "Kilo Gateway",
        percentRemaining,
        semantic: REMAINING_CREDITS,
        basis,
      },
    ]);
    expect(out.rawDetails).toEqual(expect.arrayContaining(rawDetails));
    expect(out.statusDetails).toEqual(expect.arrayContaining(rawDetails));
    expect(JSON.stringify(out.entries)).not.toContain("$");
  });

  it("omits the percent entry when total credits are zero", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce(
      kiloPass({
        baseCreditsUsd: 0,
        usageUsd: 0,
        bonusCreditsUsd: 0,
        remainingUsd: 0,
        overageUsd: 0,
        resetTimeIso: "2099-02-01T00:00:00.000Z",
      }),
    );

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        kind: "quantity",
        name: "kilo-gateway-remaining-credits",
        group: "Kilo Gateway",
        semantic: REMAINING_CREDITS,
        quantity: usd("0"),
        resetTimeIso: "2099-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("restores the provider-reported Gateway balance-only fallback", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({
      success: true,
      mode: "gateway_balance",
      balanceUsd: 8.25,
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        kind: "quantity",
        name: "kilo-gateway-total-balance",
        group: "Kilo Gateway",
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
        quantity: usd("8.25"),
      },
    ]);
    expect(out.entries[0]?.accounting).toEqual({
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    });
    expect(out.presentation).toBeUndefined();
    expect(out.rawDetails).toBeUndefined();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "accounting_mode", value: "gateway_balance" },
        { key: "balance_usd", value: "$8.25" },
      ]),
    );
    expect(out.statusDetails?.map((detail) => detail.key)).not.toContain("usage_usd");
  });

  it("maps API failures into a safe Kilo Gateway error", async () => {
    mocks.queryKiloQuota.mockResolvedValueOnce({ success: false, error: "Unauthorized" });

    expectAttemptedWithErrorLabel(await kiloProvider.fetch({} as any), "Kilo Gateway");
  });
});
