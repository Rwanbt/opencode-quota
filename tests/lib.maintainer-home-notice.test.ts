import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(state.root, "data"),
    configDir: join(state.root, "config"),
    cacheDir: join(state.root, "cache"),
    stateDir: join(state.root, "state"),
  }),
}));

// One announcement for Copilot users, active all the time.
vi.mock("../src/lib/maintainer-announcements.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/maintainer-announcements.js")>()),
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [
    {
      id: "copilot-credits",
      message: "If you use Copilot, GitHub billing is moving to AI Credits.",
      providerIds: ["copilot"],
    },
  ],
}));

import {
  __resetMaintainerHomeNoticeForTests,
  homeNoticeLine,
  listNotices,
  markNotices,
} from "../src/lib/maintainer-home-notice.js";

const NOTICE = "Notice: 1 unread maintainer notice, see /quota → Notices.";
const MINUTE = 60_000;
const MORNING = new Date(2026, 9, 10, 9, 0).getTime();

function lineAt(nowMs: number, frequency: "off" | "daily" | "always" = "daily") {
  return homeNoticeLine({ frequency, providerIds: ["copilot"], nowMs });
}

describe("Home maintainer notice", () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), "opencode-quota-home-notice-"));
    __resetMaintainerHomeNoticeForTests();
  });

  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  it.each([
    { name: "off", frequency: "off" as const, providerIds: ["copilot"], expected: "" },
    { name: "no matching provider", frequency: "always" as const, providerIds: [], expected: "" },
    { name: "always", frequency: "always" as const, providerIds: ["copilot"], expected: NOTICE },
  ])("answers $name", async ({ frequency, providerIds, expected }) => {
    await expect(homeNoticeLine({ frequency, providerIds, nowMs: MORNING })).resolves.toBe(
      expected,
    );
  });

  it("shows the daily notice for 10 minutes on the first Home screen of each day", async () => {
    const shown = [];
    for (const nowMs of [
      MORNING,
      MORNING + 10 * MINUTE - 1,
      MORNING + 10 * MINUTE,
      new Date(2026, 9, 10, 23, 59).getTime(),
      new Date(2026, 9, 11, 0, 1).getTime(),
    ]) {
      shown.push((await lineAt(nowMs)) === NOTICE);
    }
    expect(shown).toEqual([true, true, false, false, true]);
  });

  it("counts a showing from the future as used up when the clock goes back", async () => {
    await expect(lineAt(new Date(2026, 9, 10, 15, 0).getTime())).resolves.toBe(NOTICE);
    await expect(lineAt(new Date(2026, 9, 10, 13, 0).getTime())).resolves.toBe("");
  });

  it("keeps one process to once a day when the state file cannot be written", async () => {
    // A file where the state folder should be makes every read and write fail.
    await mkdir(join(state.root, "state"), { recursive: true });
    await writeFile(join(state.root, "state", "opencode-quota"), "not a folder");
    await expect(lineAt(MORNING)).resolves.toBe(NOTICE);
    await expect(lineAt(MORNING + 11 * MINUTE)).resolves.toBe("");
    await expect(lineAt(new Date(2026, 9, 11, 9, 0).getTime())).resolves.toBe(NOTICE);
  });

  it("does not use up the day's showing while no notice is active", async () => {
    await expect(
      homeNoticeLine({ frequency: "daily", providerIds: [], nowMs: MORNING }),
    ).resolves.toBe("");
    await expect(lineAt(MORNING + 60 * MINUTE)).resolves.toBe(NOTICE);
  });

  it("keeps the read state in the state dir; the Home line counts only unread notices", async () => {
    const notice = {
      id: "copilot-credits",
      message: "If you use Copilot, GitHub billing is moving to AI Credits.",
    };
    await expect(listNotices({ providerIds: ["copilot"] })).resolves.toEqual([
      { ...notice, read: false },
    ]);

    // An id that names no bundled notice is not kept.
    await markNotices(["copilot-credits", "gone"], true);
    await expect(listNotices({ providerIds: ["copilot"] })).resolves.toEqual([
      { ...notice, read: true },
    ]);
    const file = join(state.root, "state", "opencode-quota", "maintainer-announcements-read.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ read: ["copilot-credits"] });
    await expect(lineAt(MORNING, "always")).resolves.toBe("");
    // A day with nothing unread does not use up its showing.
    await expect(lineAt(MORNING)).resolves.toBe("");

    await markNotices(["copilot-credits"], false);
    await expect(lineAt(MORNING + MINUTE)).resolves.toBe(NOTICE);
  });
});
