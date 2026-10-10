import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PricingRefreshOptions } from "../src/lib/modelsdev-pricing.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const STALE_AT = NOW - 4 * DAY_MS;

type Prices = Record<string, { input: number; output: number }>;

function createBootstrapSnapshot(generatedAt: number, extraModels: Prices = {}) {
  return {
    _meta: {
      source: "test-bootstrap",
      generatedAt,
      providers: ["openai"],
      units: "USD per 1M tokens",
    },
    providers: {
      openai: {
        "gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.03, cache_write: 0.2 },
        ...extraModels,
      },
    } as Record<string, Record<string, unknown>>,
  };
}

function createRuntimeSnapshot(generatedAt: number, input: number, extraModels: Prices = {}) {
  return {
    _meta: {
      source: "test-runtime",
      generatedAt,
      providers: ["openai"],
      units: "USD per 1M tokens",
    },
    providers: {
      openai: {
        "gpt-4o-mini": {
          input,
          output: input * 4,
          cache_read: input / 5,
          cache_write: input / 3,
        },
        ...extraModels,
      },
    },
  };
}

/** A models.dev reply listing only openai/gpt-4o-mini. */
function modelsDevResponse(cost: Record<string, number>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ openai: { models: { "gpt-4o-mini": { cost } } } }), {
    status: 200,
    ...init,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Loads a fresh pricing module (its in-process state resets) against new temp
 * runtime folders. `refresh` defaults to a stale bundled snapshot and the
 * default 3-day max age.
 */
async function setup() {
  vi.resetModules();
  const pricing = await import("../src/lib/modelsdev-pricing.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-pricing-"));
  tempRoots.push(root);
  const runtimeDirs = {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
  };
  const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
  return {
    pricing,
    runtimeDirs,
    snapshotPath,
    refresh: (options: PricingRefreshOptions = {}) =>
      pricing.maybeRefreshPricingSnapshot({
        nowMs: NOW,
        runtimeDirs,
        fetchFn: vi.fn(),
        maxAgeMs: 3 * DAY_MS,
        bootstrapSnapshotOverride: createBootstrapSnapshot(STALE_AT),
        ...options,
      }),
    writeRuntimeSnapshot: async (snapshot: unknown) => {
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, JSON.stringify(snapshot), "utf-8");
    },
    readRuntimeSnapshot: async () => JSON.parse(await readFile(snapshotPath, "utf-8")),
  };
}

describe("pricing runtime refresh policy", () => {
  it("uses the fresh bundled snapshot without fetching or writing a runtime snapshot", async () => {
    const { pricing, snapshotPath, refresh } = await setup();
    const fetchFn = vi.fn();

    const result = await refresh({
      fetchFn,
      bootstrapSnapshotOverride: createBootstrapSnapshot(NOW),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.output).toBe(0.6);
    expect(await exists(snapshotPath)).toBe(false);
  });

  it("fetches and persists a runtime snapshot when stale", async () => {
    const { pricing, refresh, readRuntimeSnapshot } = await setup();
    const fetchFn = vi.fn().mockResolvedValue(
      modelsDevResponse(
        {
          input: 0.123,
          output: 0.456,
          cache_read: 0.01,
          cache_write: 0.02,
          reasoning: 999,
          ignored_key: 123,
        },
        { headers: { etag: "etag-1", "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT" } },
      ),
    );

    const result = await refresh({ fetchFn });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");

    const persistedSnapshot = await readRuntimeSnapshot();
    expect(persistedSnapshot._meta.generatedAt).toBe(NOW);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"]).toEqual({
      input: 0.123,
      output: 0.456,
      cache_read: 0.01,
      cache_write: 0.02,
    });
  });

  it("falls back to last local snapshot when fetch fails", async () => {
    const { pricing, runtimeDirs, refresh } = await setup();

    const result = await refresh({ fetchFn: vi.fn().mockRejectedValue(new Error("network down")) });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.error).toContain("network down");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);

    const state = await pricing.readPricingRefreshState(runtimeDirs);
    expect(state?.lastResult).toBe("failed");
    expect(state?.lastError).toContain("network down");
  });

  it("refreshes local snapshot freshness when models.dev responds 304", async () => {
    const { pricing, refresh, readRuntimeSnapshot } = await setup();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { etag: "etag-304", "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT" },
      }),
    );

    const result = await refresh({ fetchFn });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.state.lastResult).toBe("not_modified");
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.getPricingSnapshotMeta().generatedAt).toBe(NOW);

    const persistedSnapshot = await readRuntimeSnapshot();
    expect(persistedSnapshot._meta.generatedAt).toBe(NOW);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"].input).toBe(0.15);
  });

  it("keeps models that models.dev no longer lists, preferring the runtime price", async () => {
    const { pricing, refresh, writeRuntimeSnapshot, readRuntimeSnapshot } = await setup();
    await writeRuntimeSnapshot(
      createRuntimeSnapshot(NOW - 4 * DAY_MS, 0.5, { "retired-in-both": { input: 5, output: 6 } }),
    );

    const result = await refresh({
      fetchFn: vi.fn().mockResolvedValue(modelsDevResponse({ input: 0.123, output: 0.456 })),
      bootstrapSnapshotOverride: createBootstrapSnapshot(NOW - 10 * DAY_MS, {
        "retired-in-both": { input: 1, output: 2 },
        "retired-bundled-only": { input: 3, output: 4 },
      }),
    });

    expect(result.updated).toBe(true);
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toEqual({ input: 0.123, output: 0.456 });
    expect(pricing.lookupCost("openai", "retired-in-both")).toEqual({ input: 5, output: 6 });
    expect(pricing.lookupCost("openai", "retired-bundled-only")).toEqual({ input: 3, output: 4 });
    expect(Object.keys((await readRuntimeSnapshot()).providers.openai)).toEqual([
      "gpt-4o-mini",
      "retired-bundled-only",
      "retired-in-both",
    ]);
  });

  it("prefers the runtime price of a retired model even when the bundled file is newer", async () => {
    const { pricing, refresh, writeRuntimeSnapshot, readRuntimeSnapshot } = await setup();
    // Bundled file rewritten later, but its kept price is an older observation.
    await writeRuntimeSnapshot(
      createRuntimeSnapshot(NOW - 20 * DAY_MS, 0.5, { "retired-model": { input: 7, output: 8 } }),
    );

    await refresh({
      fetchFn: vi.fn().mockResolvedValue(modelsDevResponse({ input: 0.123, output: 0.456 })),
      force: true,
      bootstrapSnapshotOverride: createBootstrapSnapshot(NOW - 2 * DAY_MS, {
        "retired-model": { input: 1, output: 2 },
      }),
    });

    expect((await readRuntimeSnapshot()).providers.openai["retired-model"]).toEqual({
      input: 7,
      output: 8,
    });
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 7, output: 8 });
  });

  it.each([
    [
      "a fresh runtime snapshot without refreshing",
      NOW - DAY_MS,
      7 * DAY_MS,
      { attempted: false, reason: "fresh" },
    ],
    [
      "an older runtime snapshot on 304",
      NOW - 4 * DAY_MS,
      3 * DAY_MS,
      { attempted: true, state: expect.objectContaining({ lastResult: "not_modified" }) },
    ],
  ])("fills retired bundled models into %s", async (_name, runtimeGeneratedAt, maxAgeMs, expected) => {
    const { pricing, refresh, writeRuntimeSnapshot } = await setup();
    // Saved by an older version after models.dev dropped the model.
    await writeRuntimeSnapshot(createRuntimeSnapshot(runtimeGeneratedAt, 0.5));

    const result = await refresh({
      fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
      maxAgeMs,
      bootstrapSnapshotOverride: createBootstrapSnapshot(NOW - 10 * DAY_MS, {
        "retired-model": { input: 3, output: 4 },
      }),
    });

    expect(result).toMatchObject(expected);
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.5);
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 3, output: 4 });
  });

  it("does not save kept models from providers outside the refresh allowlist", async () => {
    const { refresh, readRuntimeSnapshot } = await setup();
    const bundled = createBootstrapSnapshot(STALE_AT);
    bundled.providers.xai = { "grok-old": { input: 1, output: 2 } };

    await refresh({
      fetchFn: vi.fn().mockResolvedValue(modelsDevResponse({ input: 0.123, output: 0.456 })),
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: bundled,
    });

    const persistedSnapshot = await readRuntimeSnapshot();
    expect(persistedSnapshot._meta.providers).toEqual(["openai"]);
    expect(persistedSnapshot.providers.xai).toBeUndefined();
  });

  it("pins the bundled snapshot and skips runtime refresh attempts", async () => {
    const { pricing, runtimeDirs, refresh, writeRuntimeSnapshot } = await setup();
    await writeRuntimeSnapshot(createRuntimeSnapshot(NOW + 60_000, 9.99));
    const fetchFn = vi.fn();

    const result = await refresh({
      fetchFn,
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: createBootstrapSnapshot(NOW),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("selection_bundled");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);
    expect(await exists(pricing.getRuntimePricingRefreshStatePath(runtimeDirs))).toBe(false);
  });

  it.each([
    [
      "new prices on 200",
      null,
      STALE_AT,
      modelsDevResponse({ input: 0.222, output: 0.888 }),
      "success",
      0.222,
    ],
    [
      "the prior runtime prices on 304",
      createRuntimeSnapshot(STALE_AT - 60_000, 9.99),
      NOW,
      new Response(null, {
        status: 304,
        headers: { etag: "etag-304-manual", "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT" },
      }),
      "not_modified",
      9.99,
    ],
  ])("lets a manual refresh save %s while bundled selection stays active", async (_name, existing, bundledAt, response, lastResult, savedInput) => {
    const { pricing, refresh, writeRuntimeSnapshot, readRuntimeSnapshot } = await setup();
    if (existing) await writeRuntimeSnapshot(existing);
    const fetchFn = vi.fn().mockResolvedValue(response);

    const result = await refresh({
      fetchFn,
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
      bootstrapSnapshotOverride: createBootstrapSnapshot(bundledAt),
    });

    expect(result).toMatchObject({ attempted: true, updated: true, state: { lastResult } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);

    const persistedSnapshot = await readRuntimeSnapshot();
    expect(persistedSnapshot._meta.generatedAt).toBe(NOW);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"].input).toBe(savedInput);
  });

  it.each([
    ["the runtime snapshot even when the bundled one is newer", true, "runtime", 9.99],
    ["the bundled snapshot when no runtime snapshot exists", false, "bundled", 0.15],
  ])("pins runtime selection to %s", async (_name, hasRuntime, source, input) => {
    const { pricing, refresh, writeRuntimeSnapshot } = await setup();
    if (hasRuntime) await writeRuntimeSnapshot(createRuntimeSnapshot(NOW - 60_000, 9.99));
    const fetchFn = vi.fn();

    const result = await refresh({
      fetchFn,
      snapshotSelection: "runtime",
      bootstrapSnapshotOverride: createBootstrapSnapshot(NOW),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe(source);
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(input);
  });

  it("throttles refresh attempts using persisted lastAttemptAt state", async () => {
    const { runtimeDirs, refresh } = await setup();
    const firstResult = await refresh({
      fetchFn: vi.fn().mockRejectedValue(new Error("network down")),
    });
    expect(firstResult.attempted).toBe(true);
    expect(firstResult.updated).toBe(false);

    // A new process: only the persisted refresh state remembers the attempt.
    vi.resetModules();
    const secondLoad = await import("../src/lib/modelsdev-pricing.js");
    const throttledFetch = vi.fn();
    const secondResult = await secondLoad.maybeRefreshPricingSnapshot({
      nowMs: NOW + 60_000,
      runtimeDirs,
      fetchFn: throttledFetch,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(STALE_AT),
    });

    expect(secondResult.attempted).toBe(false);
    expect(secondResult.reason).toBe("throttled");
    expect(throttledFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a pre-header stall",
      (_signal?: AbortSignal | null) => new Promise<Response>(() => undefined),
    ],
    [
      "a stalled JSON body",
      async (signal?: AbortSignal | null) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(new Error("private body abort"));
              });
            },
          }),
        ),
    ],
  ])("times out %s with the shared timeout, without retrying or losing the snapshot", async (_name, respond) => {
    vi.useFakeTimers();
    const { pricing, runtimeDirs, refresh } = await setup();
    let receivedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return respond(init?.signal);
    });

    const pending = refresh({ fetchFn, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toMatchObject({
      attempted: true,
      updated: false,
      error: "Request timeout after 1s",
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);
    const state = await pricing.readPricingRefreshState(runtimeDirs);
    expect(state).toMatchObject({ lastResult: "failed", lastError: "Request timeout after 1s" });
  });

  it("dedupes concurrent attempts and only checks once per process window", async () => {
    const { refresh } = await setup();
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = refresh({ fetchFn });
    const second = refresh({ fetchFn });
    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
    resolveFetch?.(modelsDevResponse({ input: 0.2, output: 0.8 }));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.updated).toBe(true);
    expect(secondResult.updated).toBe(true);

    const thirdResult = await refresh({ nowMs: NOW + 30_000, fetchFn });
    expect(thirdResult.attempted).toBe(false);
    expect(thirdResult.reason).toBe("already_checked_this_process");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
