/**
 * Quota toasts (§4.4). OpenCode shows one toast at a time, so quota takes a turn only when
 * the display settings say so: after compaction and when every provider fails by default;
 * after each reply, after a question, and on a limit reset only when turned on. Toasts are
 * plain text (OpenCode colors only their border).
 *
 * Reset notices that arrive together show as one toast. While a turn's toast is being made,
 * they wait and show after it, so the turn's toast does not replace them at once.
 */
import type { QuotaSnapshot, ResetNotice } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import { DEFAULT_WORDS, levelOf } from "../view/format.js";
import { visibleGroups } from "../view/select.js";
import { plainLines } from "../view/text.js";
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
};

function wantsTurnToast(display: DisplaySettings, trigger: TurnEnd, anyLow: boolean): boolean {
  if (trigger === "compaction") return display.toast.afterCompaction;
  if (trigger === "question") return display.toast.afterQuestion;
  return display.toast.afterReply === "always" || (display.toast.afterReply === "low" && anyLow);
}

function resetMessage(notice: ResetNotice, snapshot: QuotaSnapshot, display: DisplaySettings) {
  const provider = snapshot.providers.find((item) => item.providerId === notice.providerId);
  const name = provider?.label ?? notice.providerId;
  const title = notice.account ? `${name} (${notice.account})` : name;
  const label = display.labels[notice.rowId] ?? notice.label;
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
  let waitingNotices: string[] = [];

  function showNotices(): void {
    if (turnsRunning > 0 || waitingNotices.length === 0) return;
    host.show({
      variant: "success",
      title: "Quota available",
      message: waitingNotices.join("\n"),
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
      const message = plainLines({
        groups,
        words,
        nowMs,
        ...(display.toast.sessionTokens && snapshot.sessionTokens
          ? { sessionTokens: snapshot.sessionTokens }
          : {}),
      }).join("\n");
      if (message) host.show({ variant: "info", title: TOAST_TITLE, message, duration });
      return;
    }
    if (allFail && display.toast.whenAllFail && !allFailShown) {
      allFailShown = true;
      const message = plainLines({ groups: groups.filter((group) => group.error), words, nowMs });
      if (message.length > 0) {
        host.show({
          variant: "error",
          title: TOAST_TITLE,
          message: message.join("\n"),
          duration,
        });
      }
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
        waitingNotices.push(resetMessage(notice, snapshot, display));
      }
      showNotices();
    },
  };
}
