import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

vi.mock("../src/lib/cursor-detection.js", () => ({
  CURSOR_CANONICAL_PLUGIN_PACKAGE: "cursor-opencode-provider",
  inspectCursorAuthPresence: vi.fn(async () => ({
    state: "missing",
    presentPaths: [],
    candidatePaths: [],
  })),
  inspectCursorOpenCodeIntegration: vi.fn(async () => ({
    pluginEnabled: false,
    providerConfigured: false,
    matchedPaths: [],
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/cursor-usage.js", () => ({
  getCurrentCursorUsageSummary: vi.fn(),
}));

import { inspectCursorOpenCodeIntegration } from "../src/lib/cursor-detection.js";
import { getCurrentCursorUsageSummary } from "../src/lib/cursor-usage.js";
import { isCanonicalProviderAvailable } from "../src/lib/provider-availability.js";
import { cursorProvider } from "../src/providers/cursor.js";
import {
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const resetTimeIso = "2026-03-01T00:00:00.000Z";

function usageSummary(params: {
  apiCost: number;
  apiMessages: number;
  autoCost?: number;
  autoMessages?: number;
  unknownModels?: Array<Record<string, unknown>>;
}): any {
  const autoCost = params.autoCost ?? 0;
  const autoMessages = params.autoMessages ?? 0;
  return {
    window: { resetTimeIso },
    api: { costUsd: params.apiCost, tokens: {}, messageCount: params.apiMessages },
    autoComposer: { costUsd: autoCost, tokens: {}, messageCount: autoMessages },
    total: {
      costUsd: params.apiCost + autoCost,
      tokens: {},
      messageCount: params.apiMessages + autoMessages,
    },
    unknownModels: params.unknownModels ?? [],
  };
}

function fetchCursor(config: Record<string, unknown>, summary: unknown) {
  vi.mocked(getCurrentCursorUsageSummary).mockResolvedValueOnce(summary as any);
  return cursorProvider.fetch({ config } as any);
}

function usd(decimal: string) {
  return { decimal, unit: { kind: "currency", code: "USD" } };
}

function autoComposerSpend(group: string, decimal: string) {
  return {
    kind: "quantity",
    name: "cursor-auto-composer-spend",
    group,
    resetTimeIso,
    semantic: {
      metric: { kind: "named", name: "Auto+Composer" },
      prominence: "supplementary",
    },
    quantity: usd(decimal),
  };
}

describe("cursor provider", () => {
  it("returns attempted:false when there is no usage and no configured included budget", async () => {
    expectNotAttempted(
      await fetchCursor({ cursorPlan: "none" }, usageSummary({ apiCost: 0, apiMessages: 0 })),
    );
  });

  it("maps complete API coverage to a named budget percentage with USD basis", async () => {
    const out = await fetchCursor(
      { cursorPlan: "pro" },
      usageSummary({ apiCost: 5, apiMessages: 2, autoCost: 1.25, autoMessages: 1 }),
    );

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "cursor")).toEqual([
      {
        name: "Cursor API (Pro)",
        group: "Cursor (Pro)",
        percentRemaining: 75,
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "API" },
          prominence: "primary",
        },
        basis: {
          used: { quantity: usd("5"), authority: "locally_derived" },
          limit: { quantity: usd("20"), authority: "locally_derived" },
          remaining: { quantity: usd("15"), authority: "locally_derived" },
        },
      },
      autoComposerSpend("Cursor (Pro)", "1.25"),
    ]);
    expect(out.entries.map((entry) => entry.accounting.resultType)).toEqual(["budget", "spend"]);
  });

  it("attaches fixed-window evidence only to explicitly configured billing cycles", async () => {
    const observedAtMs = Date.parse("2026-02-15T12:00:00.000Z");
    const cycle = {
      sinceMs: Date.parse("2026-02-01T00:00:00.000Z"),
      untilMs: Date.parse(resetTimeIso),
      resetTimeIso,
    };
    const configured = usageSummary({ apiCost: 5, apiMessages: 2 });
    configured.window = { ...cycle, source: "configured_day" };
    configured.observedAtMs = observedAtMs;
    const inferred = usageSummary({ apiCost: 5, apiMessages: 2 });
    inferred.window = { ...cycle, source: "calendar_month" };
    inferred.observedAtMs = observedAtMs;

    const supported = await fetchCursor(
      { cursorPlan: "pro", cursorBillingCycleStartDay: 1 },
      configured,
    );
    expect(supported.entries[0]).toMatchObject({
      fixedWindow: {
        kind: "fixed_window",
        startedAtIso: "2026-02-01T00:00:00.000Z",
        observedAtIso: "2026-02-15T12:00:00.000Z",
        endsAtIso: resetTimeIso,
        fullReset: true,
      },
    });

    const unsupported = await fetchCursor({ cursorPlan: "pro" }, inferred);
    expect(unsupported.entries[0]).not.toHaveProperty("fixedWindow");
  });

  it.each([
    [
      "marks an explicit included-API override as user configured",
      { cursorPlan: "pro", cursorIncludedApiUsd: 10 },
      { apiCost: 2, apiMessages: 1 },
      {
        percentRemaining: 80,
        basis: { limit: { quantity: usd("10"), authority: "user_configured" } },
      },
    ],
    [
      "preserves negative remaining percent while keeping remaining basis non-negative",
      { cursorPlan: "pro" },
      { apiCost: 25, apiMessages: 2 },
      {
        percentRemaining: -25,
        basis: { remaining: { quantity: usd("0"), authority: "locally_derived" } },
      },
    ],
  ])("%s", async (_label, config, usage, expected) => {
    const out = await fetchCursor(config, usageSummary(usage));

    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject(expected);
  });

  it("maps complete no-allowance coverage to named API cycle spend", async () => {
    const out = await fetchCursor(
      { cursorPlan: "none" },
      usageSummary({ apiCost: 0.5, apiMessages: 1, autoCost: 1.25, autoMessages: 1 }),
    );

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "cursor")).toEqual([
      {
        kind: "quantity",
        name: "cursor-api-spend",
        group: "Cursor",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "API" },
          prominence: "primary",
        },
        quantity: usd("0.5"),
      },
      autoComposerSpend("Cursor", "1.25"),
    ]);
    expect(out.entries.every((entry) => entry.accounting.resultType === "spend")).toBe(true);
  });

  it("maps partial model coverage to Known API spend and preserves the partial error", async () => {
    const out = await fetchCursor(
      { cursorPlan: "pro" },
      usageSummary({
        apiCost: 2,
        apiMessages: 1,
        unknownModels: [{ sourceModelID: "cursor/future-model", messageCount: 1, tokens: {} }],
      }),
    );

    expect(visibleEntries(out.entries, "cursor")).toEqual([
      {
        kind: "quantity",
        name: "cursor-known-api-spend",
        group: "Cursor (Pro)",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "Known API" },
          prominence: "primary",
        },
        quantity: usd("2"),
      },
      autoComposerSpend("Cursor (Pro)", "0"),
    ]);
    expect(out.entries[0]?.accounting.resultType).toBe("spend");
    expect(out.errors[0]?.label).toBe("Cursor");
    expect(out.errors[0]?.message).toContain("Unknown Cursor model ids");
  });

  it("treats a zero allowance as API spend instead of a percentage", async () => {
    const out = await fetchCursor(
      { cursorPlan: "pro", cursorIncludedApiUsd: 0 },
      usageSummary({ apiCost: 0, apiMessages: 1 }),
    );

    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({
      kind: "quantity",
      semantic: {
        metric: { kind: "named", name: "API" },
        prominence: "primary",
      },
      quantity: usd("0"),
    });
    expect(out.entries[0]).not.toHaveProperty("percentRemaining");
  });

  it.each([
    ["provider metadata", true, { currentModel: "openai/gpt-5" }, {}, true],
    [
      "the current provider id",
      false,
      { currentModel: "auto", currentProviderID: "cursor" },
      {},
      true,
    ],
    ["a Cursor model", false, { currentModel: "cursor-acp/auto" }, {}, true],
    [
      "the plugin in a config file",
      false,
      { currentModel: "openai/gpt-5" },
      { pluginEnabled: true },
      true,
    ],
    [
      "a provider in a config file",
      false,
      { currentModel: "openai/gpt-5" },
      { providerConfigured: true },
      true,
    ],
    ["no signal", false, { currentModel: "openai/gpt-5" }, {}, false],
  ])("isAvailable via %s -> %s", async (_label, viaMetadata, config, integration, expected) => {
    vi.mocked(isCanonicalProviderAvailable).mockResolvedValue(viaMetadata);
    vi.mocked(inspectCursorOpenCodeIntegration).mockResolvedValue({
      pluginEnabled: false,
      providerConfigured: false,
      matchedPaths: [],
      checkedPaths: ["/tmp/opencode.json"],
      ...integration,
    });

    await expect(
      cursorProvider.isAvailable({
        client: { config: { providers: vi.fn() } },
        config: { ...config, cursorPlan: "none" },
      } as any),
    ).resolves.toBe(expected);
  });
});
