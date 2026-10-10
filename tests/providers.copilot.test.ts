import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCopilotQuotaAuthDiagnostics,
  hasCopilotQuotaRuntimeAvailable,
  queryCopilotQuota,
} from "../src/lib/copilot.js";
import { copilotProvider } from "../src/providers/copilot.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(async () => null),
  readCredentialRows: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../src/lib/copilot.js", () => ({
  COPILOT_AUTH_KEYS: ["github-copilot", "copilot", "copilot-chat", "github-copilot-chat"],
  hasCopilotQuotaRuntimeAvailable: vi.fn(),
  queryCopilotQuota: vi.fn(),
  getCopilotQuotaAuthDiagnostics: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readAuthFileCached: mocks.readAuthFileCached,
  readCredentialRows: mocks.readCredentialRows,
}));

function diagnostics(effectiveSource: "pat" | "oauth" | "none", billingScope = "none") {
  return {
    pat: { state: "absent", checkedPaths: [] },
    oauth: {
      configured: effectiveSource === "oauth",
      keyName: null,
      hasRefreshToken: false,
      hasAccessToken: false,
      hasEnterpriseUrl: false,
    },
    effectiveSource,
    billingScope,
  } as unknown as ReturnType<typeof getCopilotQuotaAuthDiagnostics>;
}

const usageAccounting = { resultType: "usage", authority: "provider_reported" };

beforeEach(() => {
  vi.mocked(getCopilotQuotaAuthDiagnostics).mockReturnValue(diagnostics("none"));
  vi.mocked(hasCopilotQuotaRuntimeAvailable).mockResolvedValue(false);
});

describe("copilot provider", () => {
  it("returns attempted:false when Copilot accounting is unavailable", async () => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce(null);
    expectNotAttempted(await copilotProvider.fetch({} as any));
  });

  it("maps explicit failures into provider errors", async () => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({ success: false, error: "Forbidden" });
    expectAttemptedWithErrorLabel(await copilotProvider.fetch({} as any), "Copilot");
  });

  it.each([
    {
      name: "personal PAT AI Credit accounting as usage-only",
      result: {
        success: true,
        mode: "user_quota",
        unit: "ai_credits",
        period: { year: 2026, month: 1 },
        used: 100,
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        authority: "provider_reported",
      },
      entries: [
        {
          kind: "value",
          name: "Copilot AI Credits",
          group: "Copilot (personal)",
          label: "Credits:",
          value: "Used 100 | Included 80 | Billed 20 ($0.20)",
          resetTimeIso: undefined,
        },
      ],
      accounting: [usageAccounting],
    },
    {
      name: "OAuth premium_interactions neutrally and marks local arithmetic derived",
      result: {
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: 600.5,
        total: 1000,
        percentRemaining: 40,
        authority: "locally_derived",
        plan: "enterprise",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      entries: [
        {
          name: "Copilot Premium Interactions",
          group: "Copilot (enterprise)",
          label: "Quota:",
          right: "600.5/1,000",
          percentRemaining: 40,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
      ],
      accounting: [{ resultType: "quota", authority: "locally_derived" }],
    },
    {
      name: "token-based over-limit AI credits as a quota row with a clamped percentage",
      result: {
        success: true,
        mode: "user_quota",
        unit: "ai_credits",
        used: 3739,
        total: 3000,
        percentRemaining: 0,
        authority: "provider_reported",
        plan: "business",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      entries: [
        {
          name: "Copilot AI Credits",
          group: "Copilot (business)",
          label: "Credits:",
          right: "3,739/3,000",
          percentRemaining: 0,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
      ],
      accounting: [{ resultType: "quota", authority: "provider_reported" }],
    },
    {
      name: "explicitly eligible legacy premium requests separately",
      result: {
        success: true,
        mode: "user_quota",
        unit: "premium_requests",
        used: 150,
        authority: "locally_derived",
        total: 1500,
        percentRemaining: 90,
        plan: "pro+",
      },
      entries: [
        {
          name: "Copilot Premium Requests",
          group: "Copilot (pro+)",
          label: "Quota:",
          right: "150/1,500",
          percentRemaining: 90,
          resetTimeIso: undefined,
        },
      ],
      accounting: [{ resultType: "quota", authority: "locally_derived" }],
    },
    {
      name: "token-billing placeholders as plan-only without a fake percentage or denominator",
      result: {
        success: true,
        mode: "user_plan",
        authority: "provider_reported",
        plan: "business",
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      entries: [
        {
          kind: "value",
          name: "Copilot",
          group: "Copilot (business)",
          label: "Plan:",
          value: "business | usage needs billing token",
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
      ],
      accounting: [{ resultType: "quota", authority: "provider_reported" }],
    },
    {
      name: "pooled organization credits plus a real additional-usage budget",
      result: {
        success: true,
        mode: "organization_usage",
        organization: "acme",
        username: "alice",
        period: { year: 2026, month: 1 },
        unit: "ai_credits",
        used: 100,
        authority: "provider_reported",
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        budget: {
          amountUsd: 1,
          spentUsd: 0.2,
          scope: "user",
          percentRemaining: 80,
          authority: "locally_derived",
        },
      },
      entries: [
        {
          kind: "value",
          name: "Copilot AI Credits",
          group: "Copilot (business)",
          label: "Credits:",
          value: "Used 100 | Included 80 | Billed 20 ($0.20) | 2026-01 | org=acme | user=alice",
          resetTimeIso: undefined,
        },
        {
          name: "Copilot Additional Usage",
          group: "Copilot (business)",
          label: "Budget:",
          right: "$0.20/$1.00",
          percentRemaining: 80,
          resetTimeIso: undefined,
        },
      ],
      accounting: [usageAccounting, { resultType: "budget", authority: "locally_derived" }],
      presentation: { singleWindowDisplayName: "Copilot Org (acme)" },
    },
    {
      name: "a zero budget denominator as a value-only budget row",
      result: {
        success: true,
        mode: "enterprise_usage",
        enterprise: "octo",
        period: { year: 2026, month: 1 },
        unit: "ai_credits",
        used: 10,
        authority: "provider_reported",
        includedUsed: 0,
        billedUsed: 10,
        billedAmountUsd: 0.1,
        budget: {
          amountUsd: 0,
          spentUsd: 0.1,
          scope: "enterprise",
          authority: "provider_reported",
        },
      },
      entries: [
        {
          kind: "value",
          name: "Copilot AI Credits",
          group: "Copilot (business)",
          label: "Credits:",
          value: "Used 10 | Included 0 | Billed 10 ($0.10) | 2026-01 | enterprise=octo",
          resetTimeIso: undefined,
        },
        {
          kind: "value",
          name: "Copilot Additional Usage",
          group: "Copilot (business)",
          label: "Budget:",
          value: "$0.10 spent | $0.00 budget | scope=enterprise",
          resetTimeIso: undefined,
        },
      ],
      accounting: [usageAccounting, { resultType: "budget", authority: "provider_reported" }],
      presentation: { singleWindowDisplayName: "Copilot Enterprise (octo)" },
    },
  ])("renders $name", async ({ result, entries, accounting, presentation }) => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce(result as any);

    const out = await copilotProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "copilot")).toStrictEqual(entries);
    expect(out.entries.map((entry) => entry.accounting)).toMatchObject(accounting);
    expect(out.presentation).toEqual(presentation);
  });

  it("keeps partial budget failures alongside successful usage", async () => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      period: { year: 2026, month: 1 },
      unit: "ai_credits",
      used: 10,
      authority: "provider_reported",
      includedUsed: 10,
      billedUsed: 0,
      warnings: ["Budget endpoint forbidden"],
    });

    const out = await copilotProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors).toEqual([{ label: "Copilot", message: "Budget endpoint forbidden" }]);
  });

  it("uses the OAuth GHE Copilot plan in the credential presentation without changing billing scope", async () => {
    vi.mocked(getCopilotQuotaAuthDiagnostics).mockReturnValue(diagnostics("oauth", "user"));
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "copilot-alice",
        integrationId: "github-copilot",
        label: "alice",
        active: true,
        value: { type: "oauth", access: "oauth-token", enterpriseUrl: "acme.ghe.com" },
      },
    ]);
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "user_quota",
      unit: "premium_interactions",
      used: 600,
      total: 1_000,
      percentRemaining: 40,
      authority: "provider_reported",
      plan: "enterprise",
    });

    const out = await copilotProvider.fetch({} as any);

    expect(visibleEntries(out.entries, "copilot")[0]?.group).toBe("[Copilot alice] (enterprise)");
    expect(out.entries[0]?.accounting.sourceId).toBe("copilot-alice");
    expect(out.statusDetails).toContainEqual({ key: "billing_scope", value: "user" });
  });

  it("shows a login OpenCode could not read as its own error row", async () => {
    vi.mocked(getCopilotQuotaAuthDiagnostics).mockReturnValue(diagnostics("oauth"));
    mocks.readCredentialRows.mockResolvedValueOnce([
      {
        id: "copilot-alice",
        integrationId: "github-copilot",
        label: "alice",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 401",
      },
      {
        id: "copilot-bob",
        integrationId: "github-copilot",
        label: "bob",
        active: false,
        value: { type: "oauth", access: "bob-token" },
      },
    ]);
    const signInError =
      "Copilot sign-in could not be read: refresh_failed: HTTP 401. Run `opencode auth login github-copilot`.";
    vi.mocked(queryCopilotQuota)
      .mockResolvedValueOnce({ success: false, error: signInError })
      .mockResolvedValueOnce({
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: 600,
        total: 1_000,
        percentRemaining: 40,
        authority: "provider_reported",
        plan: "enterprise",
      });

    const out = await copilotProvider.fetch({} as any);

    expect(vi.mocked(queryCopilotQuota).mock.calls.map(([options]) => options?.authData)).toEqual([
      { "github-copilot": { type: "oauth", resolveError: "refresh_failed: HTTP 401" } },
      { "github-copilot": { type: "oauth", access: "bob-token" } },
    ]);
    expect(out.errors).toEqual([{ label: "[Copilot alice] (active)", message: signInError }]);
    expect(visibleEntries(out.entries, "copilot")[0]?.group).toBe("[Copilot bob] (enterprise)");
  });

  it("uses runtime provider ids or trusted local billing auth for availability", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["github-copilot"] }),
      ),
    ).resolves.toBe(true);

    const openAiOnly = createProviderAvailabilityContext({ providerIds: ["openai"] });
    await expect(copilotProvider.isAvailable(openAiOnly)).resolves.toBe(false);
    vi.mocked(hasCopilotQuotaRuntimeAvailable).mockResolvedValueOnce(true);
    await expect(copilotProvider.isAvailable(openAiOnly)).resolves.toBe(true);
  });

  it("does not claim availability when provider lookup throws", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("boom") }),
      ),
    ).resolves.toBe(false);
  });
});
