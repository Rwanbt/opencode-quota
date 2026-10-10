/**
 * The maintainer notices clients show: the active ones with their read state, which every
 * OpenCode window shares through the state dir, and the line at the bottom of Home that counts
 * the unread ones. With the daily frequency that line shows on the first Home screen of each
 * day, for ten minutes, and the state dir remembers that day's showing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Notice } from "../rpc.js";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  getMaintainerAnnouncementsSummary,
} from "./maintainer-announcements.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type { MaintainerAnnouncementHomeFrequency } from "./types.js";

// A daily Home notice stays this long after it first shows on a day, so the
// footer's one-minute refresh does not hide it while you are on Home.
const DAILY_HOME_NOTICE_VISIBLE_MS = 10 * 60_000;

const STATE_FILE_OPTIONS = { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 };

type DailyHomeNoticeClaim = { day: string; shownAtMs: number };

/** Today's claim when the state file could not be written; keeps this process to once a day. */
let unsavedDailyHomeNoticeClaim: DailyHomeNoticeClaim | undefined;

function statePath(name: string): string {
  return join(getOpencodeRuntimeDirs().stateDir, "opencode-quota", name);
}

/** The ids of the notices marked read; none when the file is missing or unreadable. */
async function readNoticeIds(): Promise<Set<string>> {
  try {
    const state = JSON.parse(
      await readFile(statePath("maintainer-announcements-read.json"), "utf8"),
    ) as { read?: unknown };
    const ids = Array.isArray(state.read) ? state.read : [];
    return new Set(ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** Marks notices read or unread. Only the ids of bundled notices are kept. */
export async function markNotices(ids: readonly string[], read: boolean): Promise<void> {
  const known = new Set(BUNDLED_MAINTAINER_ANNOUNCEMENTS.map((announcement) => announcement.id));
  const readIds = await readNoticeIds();
  for (const id of ids) {
    if (read) readIds.add(id);
    else readIds.delete(id);
  }
  const kept = [...readIds].filter((id) => known.has(id)).sort();
  await writeJsonAtomic(
    statePath("maintainer-announcements-read.json"),
    { read: kept },
    STATE_FILE_OPTIONS,
  );
}

/**
 * The active notices, each with its read state.
 * @param providerIds the providers quota shows (a notice can target some of them).
 */
export async function listNotices(params: {
  providerIds: string[];
  nowMs?: number;
}): Promise<Notice[]> {
  const summary = getMaintainerAnnouncementsSummary({
    enabledProviders: params.providerIds,
    announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
    nowMs: params.nowMs ?? Date.now(),
  });
  const readIds = await readNoticeIds();
  return summary.activeAnnouncements.map(({ announcement }) => ({
    id: announcement.id,
    message: announcement.message,
    ...(announcement.url ? { url: announcement.url } : {}),
    read: readIds.has(announcement.id),
  }));
}

/**
 * Whether the daily Home notice may show now. The first call on each local day
 * starts that day's window and records it in the state dir.
 */
async function claimDailyHomeNotice(nowMs: number): Promise<boolean> {
  const now = new Date(nowMs);
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  let shownAtMs: number | undefined;
  try {
    const state = JSON.parse(
      await readFile(statePath("maintainer-announcements-home.json"), "utf8"),
    ) as { day?: unknown; shownAtMs?: unknown };
    if (state.day === day && Number.isFinite(state.shownAtMs)) {
      shownAtMs = state.shownAtMs as number;
    }
  } catch {
    // No state yet, or unreadable: fall back to this process's claim.
  }
  if (shownAtMs === undefined && unsavedDailyHomeNoticeClaim?.day === day) {
    shownAtMs = unsavedDailyHomeNoticeClaim.shownAtMs;
  }
  if (shownAtMs !== undefined) {
    // A claim from the future (the clock went back) counts as used up.
    const elapsedMs = nowMs - shownAtMs;
    return elapsedMs >= 0 && elapsedMs < DAILY_HOME_NOTICE_VISIBLE_MS;
  }
  const claim: DailyHomeNoticeClaim = { day, shownAtMs: nowMs };
  try {
    await writeJsonAtomic(
      statePath("maintainer-announcements-home.json"),
      claim,
      STATE_FILE_OPTIONS,
    );
  } catch {
    unsavedDailyHomeNoticeClaim = claim;
  }
  return true;
}

/**
 * The Home line that counts the unread notices, or "" when there is none to show now.
 * @param providerIds the providers quota shows (a notice can target some of them).
 */
export async function homeNoticeLine(params: {
  frequency: "off" | MaintainerAnnouncementHomeFrequency;
  providerIds: string[];
  nowMs?: number;
}): Promise<string> {
  if (params.frequency === "off") return "";
  const nowMs = params.nowMs ?? Date.now();
  const notices = await listNotices({ providerIds: params.providerIds, nowMs });
  const unread = notices.filter((notice) => !notice.read).length;
  // Only a day with an unread notice uses up that day's showing.
  if (unread === 0) return "";
  if (params.frequency === "daily" && !(await claimDailyHomeNotice(nowMs))) return "";
  const count = unread === 1 ? "1 unread maintainer notice" : `${unread} unread maintainer notices`;
  return `Notice: ${count}, see /quota → Notices.`;
}

export function __resetMaintainerHomeNoticeForTests(): void {
  unsavedDailyHomeNoticeClaim = undefined;
}
