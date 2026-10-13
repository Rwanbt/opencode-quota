/**
 * Quota toasts (§4.4). OpenCode shows one toast at a time, so quota takes a turn only when
 * the display settings say so: after compaction and when every provider fails by default;
 * after each reply, after a question, and on a limit reset only when turned on. Toasts are
 * plain text (OpenCode colors only their border) in the grouped or detailed layout
 * (`toast.layout`), with bars in the sidebar's bar shape.
 *
 * Reset notices that arrive together show as one toast. While a turn's toast is being made,
 * they wait and show after it, so the turn's toast does not replace them at once. When the TUI
 * leaves its server, waiting notices are dropped unshown, so a later snapshot can bring them.
 */
import type { QuotaSnapshot, ResetNotice, SessionTokens, Words } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import { DEFAULT_WORDS, levelOf } from "../view/format.js";
import { type Group, visibleGroups } from "../view/select.js";
import { type Line, lineText, toastLines } from "../view/text.js";
import type { QuotaClient } from "./client.js";
import type { DisplaySettings } from "./display.js";

export const TOAST_TITLE = "OpenCode Quota";

type ToastOptions = {
  variant: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  duration: number;
};

export type TurnEnd = "reply" | "compaction" | "question";

export type ToastHost = {
  show: (toast: ToastOptions) => void;
  display: () => DisplaySettings;
  /** The terminal's columns, which a toast's width follows. */
  terminalWidth: () => number;
  quota: QuotaClient;
  /** Subagent (child) sessions never show quota toasts. */
  isChildSession: (sessionID: string) => boolean;
  now?: () => number;
};

export type Toasts = {
  /**
   * A turn ended in `sessionID`: refresh quota, then show the toast the settings ask for,
   * then the reset notices that arrived meanwhile.
   */
  afterTurn(trigger: TurnEnd, sessionID: string): Promise<void>;
  /** Shows the reset notices of a snapshot that this TUI has not shown yet, in one toast. */
  showResetNotices(snapshot: QuotaSnapshot): void;
  /** The TUI left its server: drops the notices still waiting, as not shown. */
  cancel(): void;
};

/**
 * The columns of a toast's text: OpenCode's toast is at most 60 columns and 6 fewer than the
 * terminal, inside a border and 2 columns of padding on each side.
 */
export function toastRoom(terminalWidth: number): number {
  return Math.min(60, terminalWidth - 6) - 6;
}

/** `groups` in the toast layout the settings pick, as wide as the toast's text. */
function quotaLines(
  groups: Group[],
  words: Words,
  display: DisplaySettings,
  nowMs: number,
  terminalWidth: number,
  sessionTokens?: SessionTokens,
): Line[] {
  return toastLines({
    groups,
    words,
    nowMs,
    layout: display.toast.layout,
    bar: display.layout.bar,
    room: toastRoom(terminalWidth),
    runsOut: display.runsOut.toast,
    ...(sessionTokens ? { sessionTokens } : {}),
  });
}

function joinLines(lines: Line[]): string {
  return lines.map(lineText).join("\n");
}

/** The rows the Toast tab shows, in its layout, then the session tokens. */
export function toastText(
  snapshot: QuotaSnapshot,
  display: DisplaySettings,
  nowMs: number,
  terminalWidth: number,
): string {
  const words = snapshot.words ?? DEFAULT_WORDS;
  const groups = visibleGroups(snapshot, display, "toast", words);
  const tokens = display.toast.sessionTokens ? snapshot.sessionTokens : undefined;
  return joinLines(quotaLines(groups, words, display, nowMs, terminalWidth, tokens));
}

function wantsTurnToast(display: DisplaySettings, trigger: TurnEnd, anyLow: boolean): boolean {
  if (trigger === "compaction") return display.toast.afterCompaction;
  if (trigger === "question") return display.toast.afterQuestion;
  return display.toast.afterReply === "always" || (display.toast.afterReply === "low" && anyLow);
}

function resetMessage(notice: ResetNotice, snapshot: QuotaSnapshot, display: DisplaySettings) {
  const provider = snapshot.providers.find((item) => item.providerId === notice.providerId);
  const name = provider?.label ?? notice.providerId;
  const title = notice.account ? `${name} (${notice.account})` : name;
  const label = display.toast.names[notice.rowId] ?? notice.label;
  const left = Math.max(0, Math.min(100, Math.round(notice.percentRemaining)));
  return `${WINDOWS[notice.window].label} quota reset: ${title} ${label} is available again (${left}% left).`;
}

export function createToasts(host: ToastHost): Toasts {
  const now = host.now ?? Date.now;
  /** Notices from before this TUI started were news to the TUI that saw them then. */
  const startedAtMs = now();
  const shownNotices = new Set<string>();
  /** The "every provider fails" toast shows once until some provider answers again. */
  let allFailShown = false;
  /** Turns whose toast is being made; reset notices wait for them. */
  let turnsRunning = 0;
  let waitingNotices: Array<{ id: string; message: string }> = [];

  function showNotices(): void {
    if (turnsRunning > 0 || waitingNotices.length === 0) return;
    host.show({
      variant: "success",
      title: "Quota available",
      message: waitingNotices.map((notice) => notice.message).join("\n"),
      duration: host.display().toast.seconds * 1000,
    });
    waitingNotices = [];
  }

  async function turnToast(trigger: TurnEnd, sessionID: string): Promise<void> {
    const snapshot = await host.quota.refresh("turn", sessionID);
    const display = host.display();
    if (!snapshot || !display.surfaces.toast.enabled) return;
    const words = snapshot.words ?? DEFAULT_WORDS;
    const nowMs = now();
    const groups = visibleGroups(snapshot, display, "toast", words);
    const allFail =
      snapshot.providers.length > 0 && snapshot.providers.every((provider) => provider.error);
    if (!allFail) allFailShown = false;
    const anyLow = groups.some((group) =>
      group.rows.some(
        ({ row }) =>
          row.percentRemaining !== undefined &&
          levelOf(row.percentRemaining, display.thresholds) !== "good",
      ),
    );
    const duration = display.toast.seconds * 1000;
    if (wantsTurnToast(display, trigger, anyLow)) {
      const message = toastText(snapshot, display, nowMs, host.terminalWidth());
      if (message) host.show({ variant: "info", title: TOAST_TITLE, message, duration });
      return;
    }
    if (allFail && display.toast.whenAllFail && !allFailShown) {
      allFailShown = true;
      const failing = groups.filter((group) => group.error);
      const message = joinLines(quotaLines(failing, words, display, nowMs, host.terminalWidth()));
      if (message) host.show({ variant: "error", title: TOAST_TITLE, message, duration });
    }
  }

  return {
    async afterTurn(trigger, sessionID) {
      if (host.isChildSession(sessionID)) return;
      turnsRunning += 1;
      try {
        await turnToast(trigger, sessionID);
      } finally {
        turnsRunning -= 1;
        showNotices();
      }
    },

    showResetNotices(snapshot) {
      const display = host.display();
      for (const notice of snapshot.resetNotices) {
        if (shownNotices.has(notice.id)) continue;
        shownNotices.add(notice.id);
        const wanted =
          display.toast.resetNotice === "all" ||
          (display.toast.resetNotice === "weekly" && notice.window === "week");
        if (!wanted || !display.surfaces.toast.enabled || notice.atMs < startedAtMs) continue;
        waitingNotices.push({ id: notice.id, message: resetMessage(notice, snapshot, display) });
      }
      showNotices();
    },

    cancel() {
      for (const notice of waitingNotices) shownNotices.delete(notice.id);
      waitingNotices = [];
    },
  };
}
