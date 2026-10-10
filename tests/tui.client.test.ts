import { describe, expect, it, vi } from "vitest";
import type { QuotaSnapshot } from "../src/core/types.js";
import { createQuotaClient } from "../src/tui/client.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function snapshot(revision: number, input = 0): QuotaSnapshot {
  return {
    version: 6,
    providers: [],
    resetNotices: [],
    generatedAtMs: NOW,
    revision,
    sessionTokens: { input, cachedInput: 0, output: 0 },
  };
}

/** A quota RPC whose calls wait until the test answers them, oldest first or not. */
function fakeRpc() {
  const waiting: Array<(snapshot: QuotaSnapshot) => void> = [];
  const call = () =>
    new Promise<{ snapshot: QuotaSnapshot }>((resolve) =>
      waiting.push((answer) => resolve({ snapshot: answer })),
    );
  let changed: (snapshot: QuotaSnapshot) => void = () => {};
  const rpc = {
    snapshot: vi.fn(call),
    refresh: vi.fn(call),
    notices: vi.fn(async () => ({ homeLine: "" })),
    command: vi.fn(),
    events: {
      on: vi.fn(
        (_name: string, handler: (event: { data: { snapshot: QuotaSnapshot } }) => void) => {
          changed = (answer) => handler({ data: { snapshot: answer } });
          return () => {};
        },
      ),
    },
  };
  const client = createQuotaClient({
    location: { directory: process.cwd() },
    data: {},
    client: { rpc: () => rpc },
  });
  return {
    client,
    rpc,
    answer: (index: number, answer: QuotaSnapshot) => waiting[index]?.(answer),
    changed: (answer: QuotaSnapshot) => changed(answer),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TUI quota client", () => {
  it("keeps the snapshot with the highest revision, even one built in the same millisecond", async () => {
    const { client, answer, changed } = fakeRpc();
    const stop = client.start();
    client.watch();
    changed(snapshot(2));
    answer(0, snapshot(1));
    await settle();
    expect(client.snapshot()?.revision).toBe(2);
    stop();
  });

  it("keeps a session's part from the latest call that asked about it", async () => {
    const { client, answer } = fakeRpc();
    const stop = client.start();
    const first = client.refresh("turn", "ses_1");
    const second = client.refresh("turn", "ses_1");
    answer(1, snapshot(2, 200));
    await second;
    answer(0, snapshot(3, 100));
    await first;
    expect(client.snapshot("ses_1")).toMatchObject({
      revision: 3,
      sessionTokens: { input: 200 },
    });
    stop();
  });

  it("drops answers to calls made before the TUI stopped", async () => {
    const { client, rpc, answer, changed } = fakeRpc();
    const stop = client.start();
    client.watch("ses_1");
    stop();
    stop();
    answer(0, snapshot(1));
    changed(snapshot(2));
    await settle();
    expect(client.snapshot("ses_1")).toBeUndefined();

    // Started again, the surface still on screen asks again at once.
    const again = client.start();
    expect(rpc.snapshot).toHaveBeenCalledTimes(2);
    answer(1, snapshot(3));
    await settle();
    expect(client.snapshot("ses_1")?.revision).toBe(3);
    again();
  });
});
