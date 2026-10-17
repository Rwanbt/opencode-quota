import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  context: vi.fn(),
  eligible: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../src/lib/quota-runtime-context.js", () => ({
  resolveQuotaRuntimeContext: mocks.resolve,
}));
vi.mock("../src/lib/quota-export.js", () => ({
  createExportProviderContext: mocks.context,
}));
vi.mock("../src/lib/quota-render-data.js", () => ({
  collectConcreteEnabledProviderIds: mocks.eligible,
}));
vi.mock("../src/lib/quota-state.js", () => ({
  fetchQuotaProviderResult: mocks.fetch,
}));

import { startGuiBackgroundRefresh, warmGuiQuotaCache } from "../src/lib/gui-background-refresh.js";

const host = { client: {}, roots: {}, resolveSessionMeta: vi.fn() } as never;

describe("opt-in GUI cache warming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({
      config: { ...DEFAULT_CONFIG, guiBackgroundRefresh: { enabled: true } },
      providers: [{ id: "copilot" }, { id: "openai" }],
    });
    mocks.context.mockReturnValue({ config: {} });
    mocks.eligible.mockResolvedValue(["openai"]);
    mocks.fetch.mockResolvedValue({ entries: [{}], errors: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("does nothing without explicit background-refresh opt-in", async () => {
    mocks.resolve.mockResolvedValueOnce({
      config: { ...DEFAULT_CONFIG, guiBackgroundRefresh: { enabled: false } },
      providers: [{ id: "copilot" }],
    });
    expect(await warmGuiQuotaCache(host)).toEqual({ intervalMs: 300_000, failed: false });
    expect(mocks.eligible).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("honors disabled plugin and explicit provider selection, never bypasses cache", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      enabledProviders: ["openai"],
      guiBackgroundRefresh: { enabled: true },
      minIntervalMs: 1_000,
    };
    mocks.resolve.mockResolvedValueOnce({
      config,
      providers: [{ id: "copilot" }, { id: "openai" }],
    });
    expect(await warmGuiQuotaCache(host)).toEqual({ intervalMs: 300_000, failed: false });
    expect(mocks.eligible).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledProviders: ["openai"],
      }),
    );
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: { id: "openai" },
        ttlMs: 300_000,
        // cache bypass must never be set by the background worker.
      }),
    );
    expect(mocks.fetch.mock.calls[0][0]).not.toHaveProperty("bypassCache");

    mocks.eligible.mockClear();
    mocks.fetch.mockClear();
    mocks.resolve.mockResolvedValueOnce({
      config: { ...config, enabled: false },
      providers: [{ id: "openai" }],
    });
    await warmGuiQuotaCache(host);
    expect(mocks.eligible).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("ignores provider error strings, retries later with a bounded backoff", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("SECRET account"));
    expect(await warmGuiQuotaCache(host)).toEqual({ intervalMs: 300_000, failed: true });
  });

  it("never overlaps asynchronous ticks, backs off on error, stops on cleanup", async () => {
    vi.useFakeTimers();
    const pending: Array<(result: { intervalMs: number; failed: boolean }) => void> = [];
    const warm = vi.fn(
      () =>
        new Promise<{ intervalMs: number; failed: boolean }>((resolve) => {
          pending.push(resolve);
        }),
    );
    const stop = startGuiBackgroundRefresh(warm);
    await vi.advanceTimersByTimeAsync(0);
    expect(warm).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(warm).toHaveBeenCalledOnce();
    pending.shift()!({ intervalMs: 300_000, failed: true });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(899_999);
    expect(warm).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(warm).toHaveBeenCalledTimes(2);
    stop();
    pending.shift()!({ intervalMs: 300_000, failed: false });
    await vi.advanceTimersByTimeAsync(900_000);
    expect(warm).toHaveBeenCalledTimes(2);
  });
});
