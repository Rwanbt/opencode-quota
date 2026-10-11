/** @jsxImportSource @opentui/solid */
/**
 * The bodies of the quota window's Limits, Notices and Status tabs. Their text comes from pure
 * builders: `limits.ts`, and `noticeOptions`, `noticeItems` and `statusLines` here; the views
 * only color it and handle clicks.
 */
import { TextAttributes } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";
import { sanitizeDisplayText } from "../../lib/display-sanitize.js";
import type { QuotaRpcNoticeListOutput } from "../../rpc.js";
import { LineText, type SurfaceHost } from "../sidebar.js";
import { limitsLines } from "./limits.js";
import type { WindowTheme } from "./shell.js";

/** The Notices tab's data: its two settings and the maintainer notices with their read state. */
export type NoticeBoard = QuotaRpcNoticeListOutput;

/** A Notices setting line: a switch flips with ‹ › or a click, a button runs. */
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

/** The Notices tab's setting lines: notices on or off, the count on Home, mark all read. */
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

export type StatusLine = { text: string; heading: boolean };

/**
 * The Status tab's lines: the /quota_status report, its title ("# ") and its section titles (an
 * unindented line that ends with ":") marked so they can be bold.
 */
export function statusLines(text: string): StatusLine[] {
  return text.split("\n").map((line) => ({
    text: line,
    heading: line.startsWith("# ") || (/^[^\s-]/u.test(line) && line.endsWith(":")),
  }));
}

export type StatusReport =
  | { state: "loading" }
  | { state: "ready"; text: string }
  | { state: "failed"; message: string };

export function LimitsView(props: {
  host: SurfaceHost;
  sessionID: string;
  nowMs: number;
  width: number;
}): JSX.Element {
  const snapshot = () => props.host.quota.snapshot(props.sessionID);
  const lines = () => {
    const current = snapshot();
    if (!current) return [];
    const display = props.host.display();
    return limitsLines({ snapshot: current, display, nowMs: props.nowMs, width: props.width });
  };
  return (
    <Show
      when={snapshot()}
      fallback={<text fg={props.host.theme().text.muted}>Loading quota…</text>}
    >
      {lines().map((line) => (
        <LineText line={line} host={props.host} />
      ))}
    </Show>
  );
}

/** Click a notice to mark it read, or unread again. */
export function NoticesView(props: {
  theme: WindowTheme;
  board: NoticeBoard | undefined;
  toggle: (id: string, read: boolean) => void;
}): JSX.Element {
  const theme = () => props.theme;
  const body = () => (props.board ? noticeItems(props.board) : { items: [], empty: "Loading…" });
  return (
    <box flexDirection="column" marginTop={1}>
      <Show when={body().empty}>
        <text fg={theme().text.muted} wrapMode="word" selectable={false}>
          {`   ${body().empty}`}
        </text>
      </Show>
      {body().items.map((item) => (
        <box
          flexDirection="row"
          marginBottom={1}
          onMouseUp={() => props.toggle(item.id, item.read)}
        >
          <text
            fg={item.read ? theme().text.muted : theme().hue.accent[500]}
            wrapMode="none"
            selectable={false}
          >
            {`   ${item.mark} `}
          </text>
          <box flexDirection="column" flexShrink={1}>
            <text
              fg={item.read ? theme().text.muted : theme().text.base}
              attributes={item.read ? TextAttributes.NONE : TextAttributes.BOLD}
              wrapMode="word"
            >
              {sanitizeDisplayText(item.message)}
            </text>
            <Show when={item.url}>
              <text fg={theme().text.muted} wrapMode="none">
                {sanitizeDisplayText(item.url ?? "")}
              </text>
            </Show>
            <text fg={theme().text.muted} wrapMode="none" selectable={false}>
              {item.action}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

/** The /quota_status report as text you can select. */
export function StatusView(props: { theme: WindowTheme; report: StatusReport }): JSX.Element {
  const theme = () => props.theme;
  const lines = () => {
    const report = props.report;
    if (report.state === "loading") return [{ text: "Loading the report…", heading: false }];
    if (report.state === "failed") {
      return [{ text: `Couldn't load the report: ${report.message}`, heading: false }];
    }
    return statusLines(report.text);
  };
  return (
    <box flexDirection="column" marginTop={1} paddingLeft={3}>
      {lines().map((line) => (
        <text
          fg={line.heading ? theme().text.action.primary.selected : theme().text.base}
          attributes={line.heading ? TextAttributes.BOLD : TextAttributes.NONE}
          wrapMode="word"
        >
          {line.text || " "}
        </text>
      ))}
    </box>
  );
}
