/** @jsxImportSource @opentui/solid */
/**
 * The Quota panel in the session sidebar (§4.1) and its collapsed form (§4.2). Click the
 * title to collapse or expand it; OpenCode's plugin storage remembers the choice. The lines
 * come from `view/text.ts`; this file only colors them.
 */
import { type BoxRenderable, TextAttributes } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import { DEFAULT_WORDS } from "../view/format.js";
import { visibleGroups } from "../view/select.js";
import { collapsedLines, collapsedTitle, type Line, sidebarLines } from "../view/text.js";
import type { QuotaClient } from "./client.js";
import type { DisplaySettings } from "./display.js";
import { roleColor, segmentColor, type Theme } from "./theme.js";

/** What every always-on surface reads. */
export type SurfaceHost = {
  theme: () => Theme;
  display: () => DisplaySettings;
  quota: QuotaClient;
};

/** Columns the panel uses until it knows its real width. */
const DEFAULT_SIDEBAR_WIDTH = 36;

/** One line of a surface, each segment in its color. */
export function LineText(props: { line: Line; host: SurfaceHost }): JSX.Element {
  return (
    <text wrapMode="none" selectable={false} flexShrink={0}>
      {props.line.segments.length === 0 ? " " : null}
      {props.line.segments.map((segment) => (
        <span
          style={{
            fg: segmentColor(props.host.theme(), props.host.display(), segment),
            attributes: segment.bold ? TextAttributes.BOLD : undefined,
          }}
        >
          {segment.text}
        </span>
      ))}
    </text>
  );
}

export function SidebarPanel(props: {
  host: SurfaceHost;
  sessionID: string;
  open: () => boolean;
  setOpen: (open: boolean) => void;
}): JSX.Element {
  const host = props.host;
  const stop = host.quota.watch(props.sessionID);
  onCleanup(stop);
  const [width, setWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);
  const [nowMs, setNowMs] = createSignal(Date.now());
  // Reset times count down between snapshots.
  const clock = setInterval(() => setNowMs(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const display = () => host.display();
  const snapshot = () => host.quota.snapshot(props.sessionID);
  const words = () => snapshot()?.words ?? DEFAULT_WORDS;
  const groups = (surface: "sidebar" | "collapsed") => {
    const current = snapshot();
    return current ? visibleGroups(current, display(), surface, words()) : [];
  };
  const lines = (): Line[] => {
    const current = snapshot();
    if (!current) return [];
    if (!props.open()) {
      if (!display().surfaces.collapsed.enabled) return [];
      return collapsedLines({
        groups: groups("collapsed"),
        layout: display().layout,
        words: words(),
        nowMs: nowMs(),
        width: width(),
        window: display().window,
      });
    }
    return sidebarLines({
      groups: groups("sidebar"),
      layout: display().layout,
      words: words(),
      nowMs: nowMs(),
      width: width(),
      ...(display().sidebar.sessionTokens && current.sessionTokens
        ? { sessionTokens: current.sessionTokens }
        : {}),
    });
  };
  const title = () => (props.open() ? "▼ Quota" : collapsedTitle(groups("collapsed")));

  return (
    <Show when={display().surfaces.sidebar.enabled}>
      <box
        flexDirection="column"
        onSizeChange={function (this: BoxRenderable) {
          const measured = this.width;
          if (measured > 0) queueMicrotask(() => setWidth(measured));
        }}
      >
        <text
          fg={roleColor(host.theme(), display(), "title")}
          wrapMode="none"
          selectable={false}
          onMouseDown={() => props.setOpen(!props.open())}
        >
          <b>{title()}</b>
        </text>
        <Show when={snapshot()} fallback={<text fg={host.theme().text.muted}>Loading quota…</text>}>
          {lines().map((line) => (
            <LineText line={line} host={host} />
          ))}
        </Show>
      </box>
    </Show>
  );
}
