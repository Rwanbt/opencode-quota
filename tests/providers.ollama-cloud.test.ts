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
  queryOllamaCloudQuota: vi.fn(),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  getApiKeyDiagnostics: mocks.getApiKeyDiagnostics,
  hasApiKey: mocks.hasApiKey,
}));

vi.mock("../src/lib/ollama-cloud.js", () => ({
  queryOllamaCloudQuota: mocks.queryOllamaCloudQuota,
}));

import { ollamaCloudProvider } from "../src/providers/ollama-cloud.js";

function window(usageFraction: number, percentRemaining: number) {
  return { usageFraction, usagePercent: usageFraction * 100, percentRemaining };
}

function entry(name: "Session" | "Weekly" | "Monthly", percentRemaining: number) {
  return {
    name: `Ollama Cloud ${name}`,
    group: "Ollama Cloud",
    label: `${name}:`,
    percentRemaining,
  };
}

describe("ollama-cloud provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:OLLAMA_API_KEY",
      checkedPaths: ["env:OLLAMA_API_KEY"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
  });

  it("returns attempted:false when no API key is configured", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce(null);

    const out = await ollamaCloudProvider.fetch({ config: {} } as any);

    expectNotAttempted(out);
    expect(out.statusDetails).toContainEqual({ key: "api_key_configured", value: "true" });
  });

  it.each([
    [
      "session and weekly",
      { session: window(0.25, 75), weekly: window(0.4, 60) },
      [entry("Session", 75), entry("Weekly", 60)],
      [
        { key: "session_usage_fraction", value: "0.25" },
        { key: "weekly_usage_fraction", value: "0.4" },
      ],
    ],
    [
      "a monthly-only pool",
      { monthly: window(0.043, 95.7) },
      [entry("Monthly", 95.7)],
      [{ key: "monthly_usage_fraction", value: "0.043" }],
    ],
  ])("maps %s quota entries", async (_name, windows, entries, fractionDetails) => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({ success: true, ...windows });

    const out = await ollamaCloudProvider.fetch({ config: { requestTimeoutMs: 1234 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(mocks.queryOllamaCloudQuota).toHaveBeenCalledWith({ requestTimeoutMs: 1234 });
    expect(visibleEntries(out.entries, "ollama-cloud")).toEqual(entries);
    // Only reported windows get a usage-fraction detail.
    expect(out.statusDetails?.filter((detail) => detail.key.endsWith("_usage_fraction"))).toEqual(
      fractionDetails,
    );
    expect(out.statusDetails).toContainEqual({
      key: "api_key_source",
      value: "env:OLLAMA_API_KEY",
    });
  });

  it("keeps valid entries and exposes row-level response errors", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: true,
      session: window(0.25, 75),
      rowErrors: ["Weekly: ignored invalid usage fraction"],
    });

    const out = await ollamaCloudProvider.fetch({ config: {} } as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors).toEqual([
      { label: "Ollama Cloud", message: "Weekly: ignored invalid usage fraction" },
    ]);
    expect(out.statusDetails).toContainEqual({
      key: "live_error_1",
      value: "Weekly: ignored invalid usage fraction",
    });
  });

  it("returns API errors with the provider label", async () => {
    mocks.queryOllamaCloudQuota.mockResolvedValueOnce({
      success: false,
      error: "Ollama Cloud usage API error 401: invalid credentials",
    });

    const out = await ollamaCloudProvider.fetch({ config: {} } as any);

    expectAttemptedWithErrorLabel(out, "Ollama Cloud");
    expect(out.errors[0]?.message).toContain("invalid credentials");
  });

  it.each([
    ["ollama-cloud/gpt-oss:20b-cloud", true],
    ["OLLAMA-CLOUD/gpt-oss:120b-cloud", true],
    ["ollama/gpt-oss", false],
    ["openai/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(ollamaCloudProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([true, false])("isAvailable follows API key availability (%s)", async (configured) => {
    mocks.hasApiKey.mockResolvedValueOnce(configured);

    await expect(ollamaCloudProvider.isAvailable({} as any)).resolves.toBe(configured);
  });
});
