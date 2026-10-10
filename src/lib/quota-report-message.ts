/**
 * On OpenCode 2, quota slash commands from Web and Desktop post their report into the chat as
 * a user message that never starts a model turn. These helpers write the /quota report and
 * mark every such message, so the server plugin can keep it out of every model request.
 */
import type { QuotaSnapshot } from "../core/types.js";
import type { Notice } from "../rpc.js";
import { DEFAULT_WORDS } from "../view/format.js";
import { type RowSettings, type SurfaceRows, visibleGroups } from "../view/select.js";
import { plainLines } from "../view/text.js";

/** Metadata key on every quota report message. OpenCode stores message metadata with the message. */
export const QUOTA_REPORT_METADATA_KEY = "opencodeQuota";

export type QuotaReportMetadata = { command: string; at: number };

/**
 * First and last line of every quota report message; Web and Desktop show them too.
 * When OpenCode compacts a session, it copies recent message text into the checkpoint
 * before plugin hooks run, so the metadata is lost there. These lines let the plugin cut
 * the report back out of that text.
 */
const QUOTA_REPORT_START = "[OpenCode Quota report]";
const QUOTA_REPORT_END = "[End of OpenCode Quota report]";
const QUOTA_REPORT_BLOCKS = /\[OpenCode Quota report\][\s\S]*?\[End of OpenCode Quota report\]/g;

export function formatQuotaReportMessage(report: string): string {
  return `${QUOTA_REPORT_START}\n${report}\n${QUOTA_REPORT_END}`;
}

export function containsQuotaReport(text: string): boolean {
  return text.includes(QUOTA_REPORT_START);
}

/** Cuts every complete quota report, first to last line, out of the text. */
export function removeQuotaReports(text: string): string {
  return text.replace(QUOTA_REPORT_BLOCKS, "");
}

const EVERY_ROW: SurfaceRows = { enabled: true, hidden: [], providerOrder: [], rowOrder: {} };
/** Web and Desktop have no display settings: every provider and row, in the server's order. */
const NO_DISPLAY_CHOICES: RowSettings = {
  labels: {},
  window: {},
  surfaces: { sidebar: EVERY_ROW, collapsed: EVERY_ROW, statusLine: EVERY_ROW, toast: EVERY_ROW },
};

/** The /quota report of Web and Desktop: every limit in the server's words, then the notices. */
export function quotaMessageText(params: {
  snapshot: QuotaSnapshot;
  notices: Notice[];
  nowMs: number;
}): string {
  const { snapshot, nowMs } = params;
  const words = snapshot.words ?? DEFAULT_WORDS;
  const groups = visibleGroups(snapshot, NO_DISPLAY_CHOICES, "sidebar", words);
  const limits =
    groups.length > 0
      ? plainLines({ groups, words, nowMs, sessionTokens: snapshot.sessionTokens })
      : ["No quota providers found. Run /quota_status to see why."];
  const notices = params.notices.flatMap((notice) => [
    `- ${notice.message}`,
    ...(notice.url ? [`  ${notice.url}`] : []),
  ]);
  return ["Quota", ...limits, ...(notices.length > 0 ? ["", "Notices", ...notices] : [])].join(
    "\n",
  );
}
