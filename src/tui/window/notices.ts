/**
 * What the quota window's Notices tab shows: its setting lines (notices on or off, the count on
 * Home, mark all read) and the maintainer notices with their read state. Pure.
 */
import type { QuotaRpcNoticeListOutput } from "../../rpc.js";

export type NoticeBoard = QuotaRpcNoticeListOutput;

/** A setting line: a switch flips with ‹ › or a click, a button runs. */
export type NoticeOption = {
  id: "enabled" | "home" | "readAll";
  title: string;
  value: string;
  kind: "switch" | "button";
};

export type NoticeItem = {
  id: string;
  /** ● unread, ○ read. */
  mark: string;
  message: string;
  url?: string;
  read: boolean;
  /** What a click does. */
  action: string;
};

export function noticeOptions(board: NoticeBoard): NoticeOption[] {
  const unread = board.notices.filter((notice) => !notice.read).length;
  const onOff = (on: boolean) => (on ? "on" : "off");
  return [
    { id: "enabled", title: "Maintainer notices", value: onOff(board.enabled), kind: "switch" },
    { id: "home", title: "Count on the Home screen", value: onOff(board.home), kind: "switch" },
    ...(board.enabled
      ? [
          {
            id: "readAll",
            title: "Mark all as read",
            value: `${unread} unread`,
            kind: "button",
          } as const,
        ]
      : []),
  ];
}

/** The notices, or the one line that says why there is none. */
export function noticeItems(board: NoticeBoard): { items: NoticeItem[]; empty?: string } {
  if (!board.enabled) {
    return { items: [], empty: "Notices are off. Turn on 'Maintainer notices' above to see them." };
  }
  if (board.notices.length === 0) return { items: [], empty: "No notices right now." };
  return {
    items: board.notices.map((notice) => ({
      id: notice.id,
      mark: notice.read ? "○" : "●",
      message: notice.message,
      ...(notice.url ? { url: notice.url } : {}),
      read: notice.read,
      action: notice.read ? "read (click: unread)" : "click: mark read",
    })),
  };
}
