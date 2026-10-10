/**
 * The maintainer notice line at the bottom of Home ("Notice: Maintainer announcement
 * available. Run /quota_announcements."). With the daily frequency it shows on the first Home
 * screen of each day, for ten minutes, and the state dir remembers that day's showing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  formatMaintainerAnnouncementHomeCountLine,
  getMaintainerAnnouncementsSummary,
} from "./maintainer-announcements.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

// A daily Home notice stays this long after it first shows on a day, so the
// footer's one-minute refresh does not hide it while you are on Home.
const DAILY_HOME_NOTICE_VISIBLE_MS = 10 * 60_000;

type DailyHomeNoticeClaim = { day: string; shownAtMs: number };

/** Today's claim when the state file could not be written; keeps this process to once a day. */
let unsavedDailyHomeNoticeClaim: DailyHomeNoticeClaim | undefined;

/**
 * Whether the daily Home notice may show now. The first call on each local day
 * starts that day's window and records it in the state dir.
 */
async function claimDailyHomeNotice(nowMs: number): Promise<boolean> {
  const statePath = join(
    getOpencodeRuntimeDirs().stateDir,
    "opencode-quota",
    "maintainer-announcements-home.json",
  );
  const now = new Date(nowMs);
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  let shownAtMs: number | undefined;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      day?: unknown;
      shownAtMs?: unknown;
    };
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
    await writeJsonAtomic(statePath, claim, {
      trailingNewline: true,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  } catch {
    unsavedDailyHomeNoticeClaim = claim;
  }
  return true;
}

/**
 * The Home notice line, or "" when there is none to show now.
 * @param providerIds the providers quota shows (an announcement can target some of them).
 */
export async function homeNoticeLine(params: {
  frequency: "off" | "daily" | "always";
  providerIds: string[];
  nowMs?: number;
}): Promise<string> {
  if (params.frequency === "off") return "";
  const nowMs = params.nowMs ?? Date.now();
  const summary = getMaintainerAnnouncementsSummary({
    enabledProviders: params.providerIds,
    announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
    nowMs,
  });
  // Only a day with an active notice uses up that day's showing.
  if (summary.activeCount === 0) return "";
  if (params.frequency === "daily" && !(await claimDailyHomeNotice(nowMs))) return "";
  return formatMaintainerAnnouncementHomeCountLine(summary.activeCount);
}

export function __resetMaintainerHomeNoticeForTests(): void {
  unsavedDailyHomeNoticeClaim = undefined;
}
