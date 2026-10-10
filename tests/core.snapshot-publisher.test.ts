import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotPublisher } from "../src/core/snapshot-publisher.js";
import type { ProviderSnapshot, QuotaSnapshot } from "../src/core/types.js";
import type { QuotaExport } from "../src/lib/quota-export-types.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function provider(fields: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    providerId: "copilot",
    label: "Copilot",
    rows: [
      {
        id: "copilot.allowance",
        providerId: "copilot",
        account: "pro",
        label: "Premium requests",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "month",
        prominence: "primary",
        percentRemaining: 80,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    okAtMs: NOW - 30_000,
    checkedAtMs: NOW - 30_000,
    refreshing: false,
    debug: [],
    ...fields,
  };
}

function snapshot(providers: ProviderSnapshot[], generatedAtMs = NOW): QuotaSnapshot {
  return { version: 6, providers, resetNotices: [], generatedAtMs, revision: generatedAtMs };
}

describe("snapshot publisher", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-quota-publisher-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function start(exportEnabled: boolean) {
    const path = join(root, "quota-export.json");
    const loadSettings = vi.fn(async () => ({
      export: { enabled: exportEnabled, path },
      telemetry: false,
    }));
    let exports = 0;
    const buildExport = vi.fn(async (): Promise<QuotaExport> => {
      exports += 1;
      return {
        version: 2,
        exportedAt: exports,
        fromCache: true,
        cacheAgeSeconds: 0,
        providers: { copilot: { status: "ok", fetchedAt: 1, entries: [] } },
      };
    });
    const log = vi.fn();
    const publisher = createSnapshotPublisher({ loadSettings, buildExport, log });
    const written = async () => JSON.parse(await readFile(path, "utf8"));
    return { publisher, loadSettings, buildExport, log, written, path };
  }

  it("writes the export after a change, and once more for all the snapshots that waited", async () => {
    const { publisher, loadSettings, buildExport, written } = start(true);
    publisher.publish(snapshot([provider()], NOW - 2));
    publisher.publish(snapshot([provider({ label: "Older" })], NOW - 1));
    publisher.publish(snapshot([provider({ label: "Newest" })], NOW));
    await publisher.idle();

    expect(loadSettings).toHaveBeenCalledTimes(2);
    expect(buildExport).toHaveBeenCalledTimes(2);
    expect(await written()).toMatchObject({ version: 2, exportedAt: 2 });
  });

  it("writes nothing when the export is off, and nothing after dispose", async () => {
    const off = start(false);
    off.publisher.publish(snapshot([provider()]));
    await off.publisher.idle();
    await expect(readFile(off.path)).rejects.toThrow();
    expect(off.buildExport).not.toHaveBeenCalled();

    const disposed = start(true);
    disposed.publisher.dispose();
    disposed.publisher.publish(snapshot([provider()]));
    await disposed.publisher.idle();
    expect(disposed.loadSettings).not.toHaveBeenCalled();
  });

  it("logs a failed publication and keeps publishing later snapshots", async () => {
    const { publisher, loadSettings, log, written } = start(true);
    loadSettings.mockRejectedValueOnce(new Error("settings unreadable"));
    publisher.publish(snapshot([provider()]));
    await publisher.idle();
    publisher.publish(snapshot([provider()]));
    await publisher.idle();

    expect(log).toHaveBeenCalledExactlyOnceWith(
      "could not publish the quota snapshot",
      expect.objectContaining({ message: "settings unreadable" }),
    );
    expect((await written()).providers.copilot.status).toBe("ok");
  });
});
