/**
 * The lines of the quota window's Limits tab: every provider and row of the snapshot, in the
 * sidebar's order and under your row names. A row with a percent shows a wide bar with the
 * even-use marker (│), its percent, its reset and its pace (`core/pace.ts`). A window too
 * narrow for all of that on one line (an 80-column terminal) shows the reset and the pace on a
 * line under the bar, and the pace on one more line when the two don't fit together. Pure.
 */
import { describeError } from "../../core/errors.js";
import { paceOf, paceText } from "../../core/pace.js";
import type { QuotaSnapshot, Words } from "../../core/types.js";
import {
  type BarShape,
  barParts,
  DEFAULT_WORDS,
  evenUseCell,
  fit,
  formatDuration,
  percentText,
  resetText,
  rowValueText,
} from "../../view/format.js";
import { type Group, type RowSettings, type VisibleRow, visibleGroups } from "../../view/select.js";
import type { Line, Segment } from "../../view/text.js";

const INDENT = "   ";
const LABEL_WIDTH = 16;
const PERCENT_WIDTH = 15;
const RESET_WIDTH = 22;
/** Columns left after the reset for the pace words; the bar gets shorter to keep them. */
const PACE_WIDTH = 31;
const MIN_BAR_WIDTH = 8;
const MAX_BAR_WIDTH = 30;
/** Where the bar starts; the narrow layout's reset and pace line starts there too. */
const BAR_COLUMN = INDENT.length + LABEL_WIDTH + 1;
/** What one line holds besides the bar: label, percent, reset and pace. */
const WIDE_FIXED = BAR_COLUMN + 2 + PERCENT_WIDTH + RESET_WIDTH + PACE_WIDTH;
/** What the narrow layout's bar line holds besides the bar: label and percent. */
const NARROW_FIXED = BAR_COLUMN + 2 + PERCENT_WIDTH;

/** The bar's width, and whether the reset and the pace go under the bar. */
type RowLayout = { barWidth: number; narrow: boolean; width: number };

export type LimitsInput = {
  snapshot: QuotaSnapshot;
  /** The display settings: row names, the sidebar's order and the bar shape. */
  display: RowSettings & { layout: { bar: BarShape } };
  nowMs: number;
  /** Columns inside the window. */
  width: number;
};

/** A bar with the even-use marker │ in place of one of its cells; filled, empty and │ each in their color. */
function markedBar(
  shape: Exclude<BarShape, "none">,
  percent: number,
  width: number,
  evenLeft: number | undefined,
): Segment[] {
  const [filled, empty] = barParts(shape, percent, width);
  const cells: Segment[] = [
    ...[...filled].map((text): Segment => ({ text, role: "bar", percent })),
    ...[...empty].map((text): Segment => ({ text, role: "empty", percent })),
  ];
  if (evenLeft !== undefined) cells[evenUseCell(evenLeft, width)] = { text: "│", role: "label" };
  const segments: Segment[] = [];
  for (const cell of cells) {
    const last = segments[segments.length - 1];
    if (last && last.role === cell.role) last.text += cell.text;
    else segments.push({ ...cell });
  }
  return segments;
}

/** What the provider line says after the name: the error, "checking…", or when it was checked. */
function providerState(group: Group, snapshot: QuotaSnapshot, nowMs: number): Segment {
  if (group.error) return { text: describeError(group.error, group.name, nowMs), role: "error" };
  const provider = snapshot.providers.find((item) => item.providerId === group.providerId);
  if (provider?.refreshing) return { text: "checking…", role: "value" };
  const checkedAtMs = provider?.checkedAtMs ?? provider?.okAtMs;
  if (checkedAtMs === undefined) return { text: "not checked yet", role: "value" };
  const minutes = Math.floor((nowMs - checkedAtMs) / 60_000);
  if (minutes < 1) return { text: "checked just now", role: "value" };
  return { text: `checked ${formatDuration(minutes * 60_000, "short", 0)} ago`, role: "value" };
}

function rowLines(
  item: VisibleRow,
  words: Words,
  shape: Exclude<BarShape, "none">,
  layout: RowLayout,
  nowMs: number,
): Line[] {
  const { row } = item;
  const percent = row.percentRemaining;
  const label: Segment = {
    text: `${INDENT}${fit(item.label, LABEL_WIDTH)} `,
    role: "label",
    percent,
  };
  if (percent === undefined) {
    return [{ id: row.id, segments: [label, { text: rowValueText(row), role: "value" }] }];
  }
  const pace = paceOf(row, nowMs);
  const reset = resetText(row, nowMs, words);
  const bar = [label, ...markedBar(shape, percent, layout.barWidth, pace?.evenLeft)];
  const percentWords = percentText(words, percent, true);
  const resetWords = reset ? `resets in ${reset}` : "";
  const paceSegment: Segment | undefined = pace && {
    text: paceText(pace, words),
    role: pace.kind === "fast" ? "warning" : "value",
  };
  if (!layout.narrow) {
    return [
      {
        id: row.id,
        segments: [
          ...bar,
          { text: `  ${fit(percentWords, PERCENT_WIDTH)}`, role: "percent", percent },
          { text: fit(resetWords, RESET_WIDTH), role: "reset", percent },
          ...(paceSegment ? [paceSegment] : []),
        ],
      },
    ];
  }
  const under = { text: " ".repeat(BAR_COLUMN), role: "label" } as const;
  const resetSegment: Segment = { text: resetWords, role: "reset", percent };
  const lines: Line[] = [
    { id: row.id, segments: [...bar, { text: `  ${percentWords}`, role: "percent", percent }] },
  ];
  const together = BAR_COLUMN + resetWords.length + 3 + (paceSegment?.text.length ?? 0);
  if (resetWords && paceSegment && together <= layout.width) {
    const dot: Segment = { text: " · ", role: "reset", percent };
    lines.push({ id: row.id, segments: [under, resetSegment, dot, paceSegment] });
    return lines;
  }
  if (resetWords) lines.push({ id: row.id, segments: [under, resetSegment] });
  if (paceSegment) lines.push({ id: row.id, segments: [under, paceSegment] });
  return lines;
}

export function limitsLines(input: LimitsInput): Line[] {
  const { snapshot, display, nowMs } = input;
  // Every row: the supplementary ones too, and none hidden.
  const words: Words = { ...(snapshot.words ?? DEFAULT_WORDS), detail: "detailed" };
  const sidebar = { ...display.surfaces.sidebar, hidden: [] };
  const settings: RowSettings = { ...display, surfaces: { ...display.surfaces, sidebar } };
  const groups = visibleGroups(snapshot, settings, "sidebar", {
    ...words,
    onlyCurrentModel: false,
  });
  if (groups.length === 0) {
    return [
      {
        id: "",
        segments: [{ text: " No quota providers found. The Status tab says why.", role: "value" }],
      },
    ];
  }
  const shape = display.layout.bar === "none" ? "line" : display.layout.bar;
  const narrow = input.width < WIDE_FIXED + MIN_BAR_WIDTH;
  const room = input.width - (narrow ? NARROW_FIXED : WIDE_FIXED);
  const layout: RowLayout = {
    barWidth: Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, room)),
    narrow,
    width: input.width,
  };
  return groups.flatMap((group, index) => {
    const state = providerState(group, snapshot, nowMs);
    const title: Line = {
      id: group.id,
      segments: [
        { text: ` ${group.name}`, role: "provider", bold: true },
        ...(group.account ? [{ text: ` · ${group.account}`, role: "account" } as const] : []),
        { ...state, text: `   ${state.text}` },
      ],
    };
    const rows = group.rows.flatMap((item) => rowLines(item, words, shape, layout, nowMs));
    return index > 0 ? [{ id: "", segments: [] }, title, ...rows] : [title, ...rows];
  });
}
