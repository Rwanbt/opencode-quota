import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuotaStore,
  type ProviderFetch,
  type ProviderIdentity,
  type QuotaStore,
  type StoreProvider,
} from "../src/core/store.js";
import type { QuotaRow, QuotaSnapshot } from "../src/core/types.js";

const START_MS = Date.parse("2026-10-10T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function row(key: string, percentRemaining: number, extra: Partial<QuotaRow> = {}): QuotaRow {
  return {
    id: `copilot.${key}`,
    providerId: "copilot",
    label: key,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    window: "week",
    prominence: "primary",
    percentRemaining,
    ...extra,
  };
}

function ok(rows: QuotaRow[]): ProviderFetch {
  return { rows, debug: [{ key: "source", value: "test" }] };
}

/** A provider whose identity and answers the test sets. */
function fakeProvider(id = "copilot") {
  let identity: ProviderIdentity = { key: "alice", persist: true };
  const fetch = vi.fn<() => Promise<ProviderFetch>>(async () => ok([row("allowance", 50)]));
  const provider: StoreProvider = {
    id,
    label: "Copilot",
    identity: async () => identity,
    fetch,
  };
  return {
    provider,
    fetch,
    signInAs(key: string, persist = true) {
      identity = { key, persist };
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("quota store", () => {
  let dir: string;
  let file: string;
  let clock: number;
  const stores: QuotaStore[] = [];

  function makeStore(
    providers: StoreProvider[],
    minIntervalMs = 5 * MINUTE,
    path: string | null = file,
  ) {
    const store = createQuotaStore({
      source: async () => ({ providers, minIntervalMs }),
      file: path,
      now: () => clock,
      log: () => {},
    });
    stores.push(store);
    return store;
  }

  function only(snapshot: QuotaSnapshot) {
    const [provider] = snapshot.providers;
    if (!provider) throw new Error("no provider in the snapshot");
    return provider;
  }

  async function savedFile(): Promise<{ entries: Record<string, { rows: QuotaRow[] }> }> {
    return JSON.parse(await readFile(file, "utf8"));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "opencode-quota-store-"));
    file = join(dir, "state", "snapshot-v6.json");
    clock = START_MS;
  });

  afterEach(async () => {
    // A store may still be writing after a snapshot() call; let it finish before the folder goes.
    await Promise.all(
      stores.splice(0).map((store) => store.refresh({ reason: "poll", providerIds: [] })),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("answers at once from the snapshot file after a restart", async () => {
    const first = fakeProvider();
    await makeStore([first.provider]).refresh({ reason: "manual" });

    const second = fakeProvider();
    const pending = deferred<ProviderFetch>();
    second.fetch.mockReturnValue(pending.promise);
    clock += 10 * MINUTE;
    const snapshot = await makeStore([second.provider]).snapshot();

    expect(only(snapshot)).toEqual({
      providerId: "copilot",
      label: "Copilot",
      rows: [row("allowance", 50)],
      okAtMs: START_MS,
      checkedAtMs: START_MS,
      refreshing: true,
      debug: [{ key: "source", value: "test" }],
    });
    // The poll it started is still running; the answer did not wait for it.
    expect(second.fetch).toHaveBeenCalledOnce();
    pending.resolve(ok([row("allowance", 40)]));
  });

  it("does nothing at all until asked", async () => {
    const source = vi.fn();
    createQuotaStore({ source, file, now: () => clock });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source).not.toHaveBeenCalled();
    await expect(readFile(file)).rejects.toThrow();
  });

  it("asks each provider once at a time", async () => {
    const copilot = fakeProvider();
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const store = makeStore([copilot.provider]);

    const first = store.refresh({ reason: "manual" });
    const second = store.refresh({ reason: "manual" });
    const instant = await store.snapshot();
    expect(only(instant).refreshing).toBe(true);
    pending.resolve(ok([row("allowance", 30)]));

    const [a, b] = await Promise.all([first, second]);
    expect(copilot.fetch).toHaveBeenCalledOnce();
    expect(only(a).rows).toEqual([row("allowance", 30)]);
    expect(only(b).rows).toEqual([row("allowance", 30)]);
    expect(only(b).refreshing).toBe(false);
  });

  it("keeps the minimum interval for polls, 30 s after a turn, none for manual", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider], 5 * MINUTE);
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);

    clock += 20 * SECOND;
    await store.refresh({ reason: "poll" });
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);

    clock += 11 * SECOND;
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);

    clock += 2 * MINUTE;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    await store.refresh({ reason: "manual" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);

    clock += 5 * MINUTE;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(4);
  });

  it("uses a provider's own interval and a turn floor never above the setting", async () => {
    const local = fakeProvider("cursor");
    local.provider.minIntervalMs = 0;
    const remote = fakeProvider("copilot");
    const store = makeStore([local.provider, remote.provider], 10 * SECOND);
    await store.refresh({ reason: "poll" });
    clock += 11 * SECOND;
    await store.refresh({ reason: "turn" });
    await store.refresh({ reason: "poll" });
    expect(local.fetch).toHaveBeenCalledTimes(3);
    expect(remote.fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes only the providers asked for", async () => {
    const copilot = fakeProvider("copilot");
    const openai = fakeProvider("openai");
    const store = makeStore([copilot.provider, openai.provider]);
    const snapshot = await store.refresh({ reason: "manual", providerIds: ["openai"] });
    expect(copilot.fetch).not.toHaveBeenCalled();
    expect(openai.fetch).toHaveBeenCalledOnce();
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
      "copilot",
      "openai",
    ]);
  });

  it("keeps the last rows when a refresh fails and backs off", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });

    clock += MINUTE;
    copilot.fetch.mockRejectedValue(new Error("fetch failed"));
    const failed = only(await store.refresh({ reason: "poll" }));
    expect(failed).toMatchObject({
      rows: [row("allowance", 50)],
      okAtMs: START_MS,
      checkedAtMs: START_MS + MINUTE,
      error: { code: "network", detail: "fetch failed" },
    });

    // 1 minute after the first failure, then 2 minutes after the second.
    clock += 59 * SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    clock += SECOND;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
    clock += 119 * SECOND;
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
    clock += SECOND;
    copilot.fetch.mockResolvedValue(ok([row("allowance", 20)]));
    const recovered = only(await store.refresh({ reason: "poll" }));
    expect(copilot.fetch).toHaveBeenCalledTimes(4);
    expect(recovered.rows).toEqual([row("allowance", 20)]);
    expect(recovered).not.toHaveProperty("error");
  });

  it("waits until the provider's own retry time after a rate limit", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({
      rows: [],
      error: { code: "rate_limited", retryAtMs: START_MS + 10 * MINUTE },
      debug: [],
    });
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });
    clock += 5 * MINUTE;
    await store.refresh({ reason: "turn" });
    expect(copilot.fetch).toHaveBeenCalledTimes(1);
    clock += 5 * MINUTE;
    await store.refresh({ reason: "poll" });
    expect(copilot.fetch).toHaveBeenCalledTimes(2);
    // A manual refresh is the user's call and always asks.
    await store.refresh({ reason: "manual" });
    expect(copilot.fetch).toHaveBeenCalledTimes(3);
  });

  it("records an empty answer as nothing reported", async () => {
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue({ rows: [], debug: [] });
    const snapshot = await makeStore([copilot.provider]).refresh({ reason: "manual" });
    expect(only(snapshot)).toMatchObject({ rows: [], error: { code: "no_data" } });
    expect(only(snapshot)).not.toHaveProperty("okAtMs");
  });

  it("shows rows only to the account that fetched them", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider]);
    await store.refresh({ reason: "manual" });

    copilot.signInAs("bob");
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const asBob = only(await store.snapshot());
    expect(asBob.rows).toEqual([]);
    expect(asBob).not.toHaveProperty("okAtMs");
    pending.resolve(ok([row("allowance", 90)]));
    await store.refresh({ reason: "poll" });

    copilot.signInAs("alice");
    const back = only(await store.snapshot());
    expect(back.rows).toEqual([row("allowance", 50)]);
    expect(copilot.fetch).toHaveBeenCalledTimes(2);

    // The file keeps both accounts, under hashed keys that never show the account itself.
    const saved = await savedFile();
    expect(Object.keys(saved.entries)).toHaveLength(2);
    for (const entry of Object.values(saved.entries)) expect(entry).not.toHaveProperty("persist");
    expect(JSON.stringify(saved)).not.toContain("alice");
    expect(JSON.stringify(saved)).not.toContain("bob");
  });

  it("drops a fetch when the login changed while it ran", async () => {
    const copilot = fakeProvider();
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    const store = makeStore([copilot.provider]);
    const running = store.refresh({ reason: "manual" });
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalled());
    copilot.signInAs("bob");
    pending.resolve(ok([row("allowance", 10)]));
    const snapshot = await running;
    expect(only(snapshot).rows).toEqual([]);
  });

  it("keeps rows of a login that can't be told apart in memory only", async () => {
    const copilot = fakeProvider();
    copilot.signInAs("settings-only", false);
    const store = makeStore([copilot.provider]);
    const snapshot = await store.refresh({ reason: "manual" });
    expect(only(snapshot).rows).toEqual([row("allowance", 50)]);
    expect((await savedFile()).entries).toEqual({});

    const listener = vi.fn();
    store.subscribe(listener);
    const pending = deferred<ProviderFetch>();
    copilot.fetch.mockReturnValueOnce(pending.promise);
    store.invalidateIdentity();
    await vi.waitFor(() => expect(copilot.fetch).toHaveBeenCalledTimes(2));
    expect(only(await store.snapshot()).rows).toEqual([]);
    pending.resolve(ok([row("allowance", 70)]));
    await vi.waitFor(() =>
      expect(only(listener.mock.lastCall?.[0]).rows).toEqual([row("allowance", 70)]),
    );
  });

  it("records a reset notice once when a window refills", async () => {
    const resetsAt = new Date(START_MS + HOUR).toISOString();
    const nextResetsAt = new Date(START_MS + HOUR + 7 * 24 * HOUR).toISOString();
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue(ok([row("weekly", 5, { resetsAt, account: "pro" })]));
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });

    clock += 2 * HOUR;
    copilot.fetch.mockResolvedValue(
      ok([row("weekly", 100, { resetsAt: nextResetsAt, account: "pro" })]),
    );
    const notice = {
      id: `copilot.weekly|pro|${resetsAt}`,
      rowId: "copilot.weekly",
      providerId: "copilot",
      account: "pro",
      label: "weekly",
      window: "week",
      percentRemaining: 100,
      atMs: START_MS + 2 * HOUR,
    };
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([notice]);

    clock += MINUTE;
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([notice]);
    // Another process sees it too.
    expect((await makeStore([copilot.provider], 0).snapshot()).resetNotices).toEqual([notice]);

    clock += HOUR;
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([]);
  });

  it("gives no reset notice for windows that don't refill or rows that didn't reset", async () => {
    const resetsAt = new Date(START_MS + HOUR).toISOString();
    const later = new Date(START_MS + 5 * HOUR).toISOString();
    const copilot = fakeProvider();
    copilot.fetch.mockResolvedValue(
      ok([
        row("session", 5, { window: "session", resetsAt }),
        row("weekly", 5, { resetsAt }),
        row("budget", 5, { type: "budget", resetsAt }),
      ]),
    );
    const store = makeStore([copilot.provider], 0);
    await store.refresh({ reason: "poll" });
    clock += 2 * HOUR;
    copilot.fetch.mockResolvedValue(
      ok([
        row("session", 100, { window: "session", resetsAt: later }),
        row("weekly", 3, { resetsAt: later }),
        row("budget", 100, { type: "budget", resetsAt: later }),
      ]),
    );
    expect((await store.refresh({ reason: "poll" })).resetNotices).toEqual([]);
  });

  it("tells subscribers about every change until they leave", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider]);
    const listener = vi.fn();
    const broken = vi.fn(() => {
      throw new Error("subscriber broke");
    });
    store.subscribe(broken);
    const leave = store.subscribe(listener);
    await store.refresh({ reason: "manual" });
    expect(listener).toHaveBeenCalledOnce();
    expect(only(listener.mock.calls[0]?.[0]).rows).toEqual([row("allowance", 50)]);

    leave();
    await store.refresh({ reason: "manual" });
    expect(listener).toHaveBeenCalledOnce();
    expect(broken).toHaveBeenCalledTimes(2);
  });

  it("merges the file with what other processes saved", async () => {
    const copilot = fakeProvider("copilot");
    const openai = fakeProvider("openai");
    const one = makeStore([copilot.provider]);
    const two = makeStore([openai.provider]);
    await one.refresh({ reason: "manual" });
    await two.refresh({ reason: "manual" });
    const saved = await savedFile();
    expect(Object.keys(saved.entries).map((key) => key.split("|")[0])).toEqual([
      "copilot",
      "openai",
    ]);
  });

  it("ignores a broken file and skips bad rows in a good one", async () => {
    const copilot = fakeProvider();
    await makeStore([copilot.provider]).refresh({ reason: "manual" });
    const saved = await savedFile();
    const [key] = Object.keys(saved.entries);
    if (!key) throw new Error("nothing saved");
    saved.entries[key]?.rows.push({ ...row("bad", 1), id: "openai.stolen" });
    await writeFile(file, JSON.stringify(saved));
    const restarted = only(await makeStore([copilot.provider], HOUR).snapshot());
    expect(restarted.rows).toEqual([row("allowance", 50)]);

    await writeFile(file, "{ not json");
    const fresh = only(await makeStore([copilot.provider], HOUR).snapshot());
    expect(fresh.rows).toEqual([]);
  });

  it("works without a file", async () => {
    const copilot = fakeProvider();
    const store = makeStore([copilot.provider], 5 * MINUTE, null);
    expect(only(await store.refresh({ reason: "manual" })).rows).toEqual([row("allowance", 50)]);
    await expect(readFile(file)).rejects.toThrow();
  });
});
