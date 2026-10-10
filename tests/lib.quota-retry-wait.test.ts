import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaRow } from "../src/core/types.js";
import type { QuotaProviderResult, QuotaToastEntry } from "../src/lib/entries.js";
import type { QuotaRetryEvent } from "../src/lib/quota-retry-wait.js";
import {
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createProvidersRegistryModuleMock,
  makeQuotaToastTestConfig,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-lib-quota-retry-wait-tests";
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE_MS = 60_000;
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);

// Loaded after the mocks above are set up.
const {
  getQuotaResetRetryDelayMs,
  isQuotaLimitError,
  QUOTA_RESET_RETRY_BUFFER_MS,
  QUOTA_RESET_RETRY_MAX_DELAY_MS,
} = await import("../src/lib/quota-retry-wait.js");

function at(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function row(key: string, percentRemaining: number | undefined, resetsAt?: string): QuotaRow {
  return {
    id: `zai.${key}`,
    providerId: "zai",
    label: key,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...(percentRemaining === undefined ? { text: "n/a" } : { percentRemaining }),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function window(label: string, percentRemaining: number, resetTimeIso?: string): QuotaToastEntry {
  return {
    accounting: TEST_ACCOUNTING,
    name: label,
    label: `${label}:`,
    percentRemaining,
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };
}

function result(entries: QuotaToastEntry[]): QuotaProviderResult {
  return { attempted: true, entries, errors: [] };
}

describe("isQuotaLimitError", () => {
  it("accepts OpenCode's rate-limit and quota errors and any HTTP 429", () => {
    expect(isQuotaLimitError({ type: "provider.rate-limit" })).toBe(true);
    expect(isQuotaLimitError({ type: "provider.quota" })).toBe(true);
    expect(isQuotaLimitError({ type: "provider.unknown", status: 429 })).toBe(true);
  });

  it("rejects other errors", () => {
    for (const type of ["provider.auth", "provider.transport", "provider.internal", "unknown"]) {
      expect(isQuotaLimitError({ type, status: 500 })).toBe(false);
    }
  });
});

describe("getQuotaResetRetryDelayMs", () => {
  it("waits until a used-up window resets, plus the buffer", () => {
    const delay = getQuotaResetRetryDelayMs(
      [row("five_hour", 0, at(90 * MINUTE_MS)), row("weekly", 40, at(MINUTE_MS))],
      NOW_MS,
    );
    expect(delay).toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("picks the earliest reset among used-up windows", () => {
    const delay = getQuotaResetRetryDelayMs(
      [row("five_hour", 0, at(90 * MINUTE_MS)), row("hourly", -2, at(20 * MINUTE_MS))],
      NOW_MS,
    );
    expect(delay).toBe(20 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("caps the wait", () => {
    const delay = getQuotaResetRetryDelayMs(
      [row("weekly", 0, at(3 * 24 * 60 * MINUTE_MS))],
      NOW_MS,
    );
    expect(delay).toBe(QUOTA_RESET_RETRY_MAX_DELAY_MS);
    expect(QUOTA_RESET_RETRY_MAX_DELAY_MS).toBe(5 * 60 * MINUTE_MS);
  });

  it("has no delay without a used-up window whose reset is still ahead", () => {
    expect(getQuotaResetRetryDelayMs([], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 3, at(90 * MINUTE_MS))], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0, at(-MINUTE_MS))], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0, at(0))], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0)], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", 0, "not a date")], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([row("a", undefined, at(MINUTE_MS))], NOW_MS)).toBeUndefined();
  });
});

describe("resolveQuotaResetRetryDelayMs", () => {
  const limitEvent: QuotaRetryEvent = {
    model: { id: "glm-4.6", providerID: "zai-coding-plan" },
    error: { type: "provider.quota", status: 429 },
  };

  function makeProvider(
    id: string,
    entries: QuotaToastEntry[],
    matches: (model: string) => boolean,
  ) {
    return {
      id,
      isAvailable: vi.fn().mockResolvedValue(true),
      matchesCurrentModel: vi.fn(matches),
      fetch: vi.fn().mockResolvedValue(result(entries)),
    };
  }

  const sourceHost = {
    client: {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({ data: { providers: [{ id: "zai-coding-plan" }] } }),
      },
    },
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
  };

  /** The plugin's retry host: a store over today's providers and settings, in memory. */
  async function createHost() {
    const { createQuotaStore } = await import("../src/core/store.js");
    const { loadServerSettings, loadProviderSource } = await import(
      "../src/core/provider-source.js"
    );
    const store = createQuotaStore({ source: () => loadProviderSource(sourceHost), file: null });
    return { store, loadSettings: () => loadServerSettings(sourceHost) };
  }

  async function resolve(event: QuotaRetryEvent) {
    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    return resolveQuotaResetRetryDelayMs(await createHost(), event);
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("waits for the used-up window of the retried model's provider only", async () => {
    const zai = makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], (model) =>
      model.includes("glm"),
    );
    const synthetic = makeProvider(
      "synthetic",
      [window("Weekly", 0, at(10 * MINUTE_MS))],
      () => false,
    );
    mocks.getProviders.mockReturnValue([zai, synthetic]);
    // waitForQuotaReset is on by default.
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({ enabledProviders: ["zai", "synthetic"] }),
    );

    await expect(resolve(limitEvent)).resolves.toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
    expect(zai.fetch).toHaveBeenCalledTimes(1);
    expect(synthetic.fetch).not.toHaveBeenCalled();
  });

  it("asks the provider for fresh quota on every limit error, whatever the interval", async () => {
    const zai = {
      ...makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], () => true),
      cachePolicy: { kind: "account-neutral" },
    };
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({ enabledProviders: ["zai"], minIntervalMs: 60 * MINUTE_MS }),
    );

    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    const host = await createHost();
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(resolveQuotaResetRetryDelayMs(host, limitEvent)).resolves.toBe(
        90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS,
      );
      expect(zai.fetch).toHaveBeenCalledTimes(attempt);
    }
  });

  it("ignores rows from an earlier read when the provider fails now", async () => {
    const zai = makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabledProviders: ["zai"] }));

    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    const host = await createHost();
    await expect(resolveQuotaResetRetryDelayMs(host, limitEvent)).resolves.toBe(
      90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS,
    );
    vi.setSystemTime(NOW_MS + MINUTE_MS);
    zai.fetch.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(resolveQuotaResetRetryDelayMs(host, limitEvent)).resolves.toBeUndefined();
  });

  it("keeps OpenCode's decision when the setting is off", async () => {
    const zai = makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({ enabledProviders: ["zai"], waitForQuotaReset: false }),
    );

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
    expect(zai.fetch).not.toHaveBeenCalled();
  });

  it("keeps OpenCode's decision for errors that are not limits, without reading config", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ waitForQuotaReset: true }));

    await expect(
      resolve({ ...limitEvent, error: { type: "provider.transport" } }),
    ).resolves.toBeUndefined();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("keeps OpenCode's decision when the provider still has quota left", async () => {
    const zai = makeProvider("zai", [window("5h", 12, at(90 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({ enabledProviders: ["zai"], waitForQuotaReset: true }),
    );

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
  });
});
