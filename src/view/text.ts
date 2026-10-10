/**
 * The lines of every quota surface, built from the visible groups (`select.ts`). The TUI
 * draws each segment in its color role; toasts and the CLI print the plain text.
 */
import { describeError } from "../core/errors.js";
import type { SessionTokens, Words } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import { columnsOf } from "./columns.js";
import {
  type BarShape,
  barParts,
  fit,
  percentText,
  percentWord,
  resetText,
  rowValueText,
  sessionTokensText,
} from "./format.js";
import { type Group, pickRow, type VisibleRow, type WindowChoice } from "./select.js";

/** Every colored thing quota draws; the TUI maps each to a theme color. */
export type ColorRole =
  | "title"
  | "provider"
  | "account"
  | "label"
  | "good"
  | "warning"
  | "low"
  | "empty"
  | "percent"
  | "reset"
  | "value"
  | "error"
  | "statusName"
  | "separator"
  | "arrows";

/**
 * A piece of a line. `role` "bar" is the filled part of a bar, drawn in its level color.
 * `percent` is the row's percent left, for roles that follow the bar color.
 */
export type Segment = { text: string; role: ColorRole | "bar"; percent?: number; bold?: boolean };

/** A line of a surface. `id` is the provider or row it shows ("" for a spacer). */
export type Line = { id: string; segments: Segment[] };

export type Layout = {
  bar: BarShape;
  barWidth: number;
  indent: number;
  labelWidth: number;
  /** Empty lines between providers in the sidebar. */
  providerGap: number;
  /** Between providers on the status line. */
  separator: string;
};

export function lineText(line: Line): string {
  return line.segments.map((segment) => segment.text).join("");
}

function barSegments(shape: BarShape, percent: number, width: number): Segment[] {
  const [filled, empty] = barParts(shape, percent, width);
  return [
    { text: filled, role: "bar", percent },
    { text: empty, role: "empty", percent },
  ];
}

/** The words for a group's last error ("Sign in again"); undefined when its last check worked. */
function errorWords(group: Group, nowMs: number): Segment | undefined {
  return group.error
    ? { text: describeError(group.error, group.name, nowMs), role: "error" }
    : undefined;
}

/** The words after a group's title: its error, or "not checked yet" before the first check. */
function groupState(group: Group, nowMs: number): Segment | undefined {
  if (group.error) return errorWords(group, nowMs);
  if (group.unchecked) return { text: "not checked yet", role: "value" };
  return undefined;
}

/** Marks rows kept from an earlier check when there is no room for the error's words. */
const ERROR_MARK = "⚠";

/** Cuts the segments so their text fits in `width` terminal columns. */
function cut(segments: Segment[], width: number): Segment[] {
  const clipped: Segment[] = [];
  let room = width;
  for (const segment of segments) {
    if (room <= 0) break;
    const text = columnsOf(segment.text) > room ? fit(segment.text, room) : segment.text;
    clipped.push({ ...segment, text });
    room -= columnsOf(text);
  }
  return clipped;
}

/**
 * Cuts the segments so their text fits in `width` terminal columns. An error never goes
 * away: when not even the start of its words fits, the line ends in " ⚠" instead.
 */
function clip(segments: Segment[], width: number): Segment[] {
  const clipped = cut(segments, width);
  const error = segments.find((segment) => segment.role === "error");
  if (!error) return clipped;
  const kept = clipped.find((segment) => segment.role === "error");
  const mark = ` ${ERROR_MARK}`;
  if ((kept && /[\p{L}\p{N}]|⚠/u.test(kept.text)) || width < columnsOf(mark)) return clipped;
  const rest = segments.filter((segment) => segment !== error);
  return [...cut(rest, width - columnsOf(mark)), { ...error, text: mark }];
}

export type SidebarInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  /** Columns the sidebar gives quota. */
  width: number;
  sessionTokens?: SessionTokens;
};

/** §4.1: the expanded Quota panel, below its title line. */
export function sidebarLines(input: SidebarInput): Line[] {
  const { layout, words, nowMs, width } = input;
  const percentRows = input.groups.flatMap((group) =>
    group.rows.filter((item) => item.row.percentRemaining !== undefined),
  );
  const resetWidth =
    1 + Math.max(0, ...percentRows.map((item) => resetText(item.row, nowMs, words).length));
  // A long word ("remaining") makes the bar shorter; when even that doesn't fit, the word goes.
  const word = percentWord(words);
  const fixed = layout.indent + layout.labelWidth + 1 + 5 + resetWidth;
  const barRoom = (withWord: boolean) => width - fixed - (withWord && word ? word.length + 1 : 0);
  const keepWord = layout.bar === "none" ? barRoom(true) >= 0 : barRoom(true) >= 3;
  const barWidth =
    layout.bar === "none" ? 0 : Math.max(0, Math.min(layout.barWidth, barRoom(keepWord)));
  const wordText = keepWord && word ? ` ${word}` : "";

  const rowLine = ({ row, label }: VisibleRow): Line => {
    const percent = row.percentRemaining;
    const labelText = `${" ".repeat(layout.indent)}${fit(label, layout.labelWidth)} `;
    const labelSegment: Segment = { text: labelText, role: "label", percent };
    if (percent === undefined) {
      return {
        id: row.id,
        segments: clip([labelSegment, { text: rowValueText(row), role: "value" }], width),
      };
    }
    return {
      id: row.id,
      segments: [
        labelSegment,
        ...barSegments(layout.bar, percent, barWidth),
        {
          text: `${percentText(words, percent, false).padStart(5)}${wordText}`,
          role: "percent",
          percent,
        },
        { text: resetText(row, nowMs, words).padStart(resetWidth), role: "reset", percent },
      ],
    };
  };

  const lines: Line[] = [];
  input.groups.forEach((group, index) => {
    if (index > 0) {
      for (let gap = 0; gap < layout.providerGap; gap++) lines.push({ id: "", segments: [] });
    }
    const state = groupState(group, nowMs);
    lines.push({
      id: group.providerId,
      segments: clip(
        [
          { text: group.name, role: "provider", bold: true },
          ...(group.account ? [{ text: ` (${group.account})`, role: "account" as const }] : []),
          ...(state ? [{ ...state, text: `  ${state.text}` }] : []),
        ],
        width,
      ),
    });
    lines.push(...group.rows.map(rowLine));
  });
  if (input.sessionTokens) {
    for (let gap = 0; gap < layout.providerGap; gap++) lines.push({ id: "", segments: [] });
    lines.push({
      id: "session",
      segments: clip(
        [
          { text: "Session", role: "label", bold: true },
          { text: `  ${sessionTokensText(input.sessionTokens)}`, role: "value" },
        ],
        width,
      ),
    });
  }
  return lines;
}

/** §4.2: the collapsed panel's title. A provider with several accounts counts once. */
export function collapsedTitle(groups: Group[]): string {
  const count = new Set(groups.map((group) => group.providerId)).size;
  const errors = new Set(groups.filter((group) => group.error).map((group) => group.providerId))
    .size;
  const providers = `${count} ${count === 1 ? "provider" : "providers"}`;
  return `▶ Quota (${providers}${errors ? `, ${errors} ${errors === 1 ? "error" : "errors"}` : ""})`;
}

/** A row's short window name, for example "5h" or "7d"; else its label. */
function shortWindow(item: VisibleRow): string {
  return item.row.window ? WINDOWS[item.row.window].short : item.label;
}

export type CollapsedInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  width: number;
  /** Preferred window by provider id. */
  window: Record<string, WindowChoice>;
};

/**
 * §4.2: one line per provider with its preferred window. When the last check failed, the
 * error's words take the place of the reset time next to the rows kept from before.
 */
export function collapsedLines(input: CollapsedInput): Line[] {
  const { layout, words, nowMs } = input;
  const barWidth = layout.bar === "none" ? 0 : Math.min(layout.barWidth, 10);
  return input.groups.map((group) => {
    const picked = pickRow(group, input.window[group.providerId]);
    const percent = picked?.row.percentRemaining;
    const name: Segment = { text: `${fit(group.title, 9)} `, role: "provider", percent };
    const state = groupState(group, nowMs);
    if (!picked || percent === undefined) {
      const value: Segment = state ?? {
        text: picked ? rowValueText(picked.row) : "",
        role: "value",
      };
      return { id: group.providerId, segments: clip([name, value], input.width) };
    }
    const error = errorWords(group, nowMs);
    return {
      id: group.providerId,
      segments: clip(
        [
          name,
          { text: `${fit(shortWindow(picked), 4)} `, role: "label", percent },
          ...barSegments(layout.bar, percent, barWidth),
          {
            text: percentText(words, percent, words.percent === "used").padStart(5),
            role: "percent",
            percent,
          },
          error
            ? { ...error, text: `  ${error.text}` }
            : { text: resetText(picked.row, nowMs, words).padStart(8), role: "reset", percent },
        ],
        input.width,
      ),
    };
  });
}

/** How much one status line segment shows, from the most to the least. */
export type StatusLevel = "full" | "bar" | "reset" | "numbers";
export const STATUS_LEVELS: readonly StatusLevel[] = ["full", "bar", "reset", "numbers"];
/** The status line's little bar. */
export const STATUS_BAR_WIDTH = 5;

export type StatusInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  window: Record<string, WindowChoice>;
};

/** A provider's name on the status line: with its account only when it shows several. */
function statusName(input: StatusInput, group: Group): string {
  const accounts = input.groups.filter((other) => other.providerId === group.providerId).length;
  return accounts > 1 ? group.title : group.name;
}

/**
 * One provider's status line segment at a level of detail (without the separator). When the
 * last check failed, the error's words take the place of the reset time next to the rows kept
 * from before, or "⚠" where the level shows no reset time.
 */
export function statusSegment(input: StatusInput, group: Group, level: StatusLevel): Line {
  const { layout, words, nowMs } = input;
  const picked = pickRow(group, input.window[group.providerId]);
  const percent = picked?.row.percentRemaining;
  const name: Segment = { text: statusName(input, group), role: "statusName", percent };
  if (!picked || percent === undefined) {
    const state = groupState(group, nowMs);
    const value = state ?? { text: picked ? rowValueText(picked.row) : "", role: "value" };
    return { id: group.providerId, segments: [name, { ...value, text: ` ${value.text}` }] };
  }
  const withBar = layout.bar !== "none" && (level === "full" || level === "bar");
  const withReset = level === "full" || level === "reset";
  const error = errorWords(group, nowMs);
  const reset = withReset ? resetText(picked.row, nowMs, words) : "";
  const after: Segment | undefined = error
    ? { ...error, text: ` ${withReset ? error.text : ERROR_MARK}` }
    : reset
      ? { text: ` ${reset}`, role: "reset", percent }
      : undefined;
  return {
    id: group.providerId,
    segments: [
      name,
      ...(withBar
        ? [
            { text: " ", role: "separator" as const },
            ...barSegments(layout.bar, percent, STATUS_BAR_WIDTH),
          ]
        : []),
      {
        text: ` ${percentText(words, percent, words.percent === "used")}`,
        role: "percent",
        percent,
      },
      ...(after ? [after] : []),
    ],
  };
}

export type StatusLayout = {
  level: StatusLevel;
  /** The first group shown (the line scrolls when not all groups fit). */
  start: number;
  shown: Line[];
  /** Groups after the shown ones: the "+N ›" marker. */
  hiddenAfter: number;
};

/** Cuts the name (the first segment) so the rest still fits in `width`; else cuts the end. */
function shortenName(segments: Segment[], width: number): Segment[] {
  const [name, ...rest] = segments;
  const nameWidth = width - columnsOf(rest.map((segment) => segment.text).join(""));
  if (!name || nameWidth < 2) return clip(segments, width);
  return [{ ...name, text: fit(name.text, nameWidth) }, ...rest];
}

/**
 * §4.3 "all" mode: the most detail that fits every group in `room` columns ("% only" when
 * nothing else fits), then the groups that fit from `start`, keeping room for the "‹ " and
 * " +N ›" markers. When not even the first of them fits, its name is cut short, so the
 * markers stay. `level` fixes the detail instead of "auto".
 */
export function statusLayout(
  input: StatusInput,
  room: number,
  start: number,
  level: StatusLevel | "auto",
): StatusLayout {
  const { groups } = input;
  const separator = input.layout.separator;
  const widthAt = (candidate: StatusLevel) =>
    groups.reduce(
      (sum, group) => sum + columnsOf(lineText(statusSegment(input, group, candidate))),
      0,
    ) +
    Math.max(0, groups.length - 1) * columnsOf(separator);
  const chosen =
    level !== "auto"
      ? level
      : (STATUS_LEVELS.find((candidate) => widthAt(candidate) <= room) ?? "numbers");
  const first = Math.max(0, Math.min(start, groups.length - 1));
  const shown: Line[] = [];
  let used = first > 0 ? 2 : 0;
  const markerWidth = (index: number) =>
    index < groups.length - 1 ? columnsOf(` +${groups.length - index} ›`) : 0;
  for (let index = first; index < groups.length; index++) {
    const segment = statusSegment(input, groups[index] as Group, chosen);
    const width = columnsOf(lineText(segment)) + (shown.length > 0 ? columnsOf(separator) : 0);
    if (used + width + markerWidth(index) > room) break;
    shown.push(segment);
    used += width;
  }
  const firstGroup = groups[first];
  const left = room - used - markerWidth(first);
  if (shown.length === 0 && firstGroup && left > 0) {
    const segment = statusSegment(input, firstGroup, chosen);
    shown.push({ ...segment, segments: shortenName(segment.segments, left) });
  }
  return { level: chosen, start: first, shown, hiddenAfter: groups.length - first - shown.length };
}

/**
 * §4.3 "one provider, big bar" (v5's prompt bar): the first group with a 10-cell bar. The
 * error's words take the place of the reset time; without a percent row the line shows the
 * group's error or value instead of a bar.
 */
export function bigStatusLine(input: StatusInput): Line | undefined {
  const group = input.groups[0];
  if (!group) return undefined;
  const picked = pickRow(group, input.window[group.providerId]);
  const percent = picked?.row.percentRemaining;
  if (!picked || percent === undefined) return statusSegment(input, group, "full");
  const error = errorWords(group, input.nowMs);
  const reset = resetText(picked.row, input.nowMs, input.words);
  const after: Segment | undefined = error
    ? { ...error, text: ` · ${error.text}` }
    : reset
      ? { text: ` · ${reset}`, role: "reset", percent }
      : undefined;
  return {
    id: group.providerId,
    segments: [
      { text: `${statusName(input, group)} ${shortWindow(picked)} `, role: "statusName", percent },
      ...barSegments(input.layout.bar, percent, 10),
      { text: ` ${percentText(input.words, percent, true)}`, role: "percent", percent },
      ...(after ? [after] : []),
    ],
  };
}

/**
 * §4.4: plain text, one line per visible row, then a line per provider error. Toasts and
 * the CLI print these.
 */
export function plainLines(params: {
  groups: Group[];
  words: Words;
  nowMs: number;
  sessionTokens?: SessionTokens;
}): string[] {
  const { words, nowMs } = params;
  const lines = params.groups.flatMap((group) => {
    const rows = group.rows.map(({ row, label }) => {
      const name = fit(`${group.title} ${label}`, 19);
      if (row.percentRemaining === undefined) return `${name} ${rowValueText(row)}`.trimEnd();
      const percent = percentText(words, row.percentRemaining, true).padEnd(13);
      return `${name} ${percent} ${resetText(row, nowMs, words)}`.trimEnd();
    });
    const state = groupState(group, nowMs);
    return state ? [...rows, `${fit(group.title, 19)} ${state.text}`] : rows;
  });
  return params.sessionTokens
    ? [...lines, `Session  ${sessionTokensText(params.sessionTokens)}`]
    : lines;
}
