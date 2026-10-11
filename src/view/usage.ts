/**
 * The usage view: a `UsageReport` laid out like T3 Code's usage page, adapted to a terminal, as
 * lines of text spans. A span has a role ("title", "muted", "provider:0", ...) and no color, so
 * the TUI Usage tab maps each span to one styled span and picks colors from its theme, and Web
 * `/quota` and the CLI print the same words as plain text (`usageText`).
 *
 * Sections, top to bottom: the total, the providers as a small table, a daily chart (beside
 * the total and the providers when it gets 32 columns there, as tall as they are), totals by
 * token kind, cost (or tokens) by type, and the breakdown by model or by day. In the TUI the
 * chart fills its width, the "by type" bar is a thin line across the view and each breakdown row
 * has a bar of its amount. `modelDetailView` lays out one model of the breakdown. Every line
 * fits in `width` terminal columns.
 */
import type { UsageByType, UsageModelRow, UsageReport, UsageRow } from "../core/usage.js";
import { usageRangeLabel } from "../core/usage-ranges.js";
import { getQuotaProviderDisplayLabel } from "../lib/provider-metadata.js";
import {
  columnsOf,
  padEndColumns,
  padStartColumns,
  sliceColumns,
  truncateColumns,
} from "./columns.js";
import { formatShare, formatTokens, formatUsd } from "./format.js";

/** What the view counts: money at API prices, or processed tokens. */
export type UsageMode = "cost" | "tokens";
export type UsageBreakdown = "model" | "day";
export type UsageViewOptions = { mode: UsageMode; breakdown: UsageBreakdown; width: number };
type UsageTextOptions = { mode: UsageMode; breakdown: UsageBreakdown; width?: number };
type ModelDetailOptions = { mode: UsageMode; width: number };

/** A part of the "by type" bar: the token kinds that have their own price. */
type UsagePart = "input" | "cacheRead" | "cacheWrite" | "output";

/**
 * What a span shows, so the TUI can color it:
 * - `title` the big total, `heading` a section name, `text` names, `value` the numbers that
 *   matter, `muted` labels, notes, padding and the chart's baseline, `warning` the share of
 *   tokens without a price;
 * - `bar` the daily chart's columns;
 * - `provider:<n>` the provider's place in `report.providers` (most cost first), on its list
 *   line and on its models, so a provider keeps one color across the view;
 * - `part:<kind>` one part of the "by type" bar and its legend mark.
 */
export type UsageRole =
  | "title"
  | "heading"
  | "text"
  | "value"
  | "muted"
  | "warning"
  | "bar"
  | `provider:${number}`
  | `part:${UsagePart}`;

type UsageSpan = { text: string; role: UsageRole };
export type UsageLine = UsageSpan[];

/**
 * The chart sits beside the total and the providers, like T3's page, when it gets this much;
 * below the roomy width the unpriced note is cut to the table's width to make room.
 */
const BESIDE_CHART_MIN_WIDTH = 32;
const BESIDE_CHART_ROOMY_WIDTH = 60;
/** The total and the provider list never get wider than this, so their numbers stay close. */
const LIST_MAX_WIDTH = 48;
const COLUMN_GAP = 3;
/** Between the total and providers on the left and the chart on the right. */
const SIDE_GAP = 4;
/** Narrower views are laid out at this width and then cut. */
const LAYOUT_MIN_WIDTH = 32;
const CHART_ROWS = 6;
/** Beside the providers, the chart grows with them up to this many rows. */
const CHART_ROWS_MAX = 12;
const DETAIL_CHART_ROWS = 5;
/** A day's column is at most this wide, so a short range does not draw a few huge blocks. */
const CHART_COLUMN_MAX = 16;
/** From this many cells, a chart column leaves its last cell empty, so the days stand apart. */
const CHART_GAP_FROM = 3;
/** One to eight eighths of a chart cell. */
const BLOCKS = "▁▂▃▄▅▆▇█";
/** The "by type" bar and its legend stay short, like T3's, on a wide view. */
const BY_TYPE_MAX_WIDTH = 64;
/** The provider color mark, before a provider and its models. */
const DOT = "● ";
const TEXT_MAX_WIDTH = 64;
const TEXT_BREAKDOWN_ROWS = 10;

/** The TUI's "by type" bar and its legend marks: a thin line, its parts told apart by color. */
const THIN_BAR = "━";
const THIN_MARK = "━━";
/** A breakdown row's bar needs this much room, else the row has none. */
const ROW_BAR_MIN_WIDTH = 8;
/** The breakdown's names get at most this wide when the rows have bars. */
const ROW_NAME_MAX_WIDTH = 40;

/** Shade marks, one per part, so the "by type" bar also reads without colors. */
const PART_MARKS: Record<UsagePart, string> = {
  input: "▒",
  cacheRead: "░",
  cacheWrite: "▓",
  output: "█",
};

const PART_LABELS: Record<UsagePart, string> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type View = {
  report: UsageReport;
  mode: UsageMode;
  breakdown: UsageBreakdown;
  /** The year of `report.generatedAtMs`; dates in other years show their year. */
  thisYear: number;
};

/**
 * What the output includes: the TUI view has the chart, every row and colors (`colored`: thin
 * bars told apart by color, bars in the breakdown); text has none of them.
 */
type Contents = { chart: boolean; breakdownRows: number; colored: boolean };

function span(text: string, role: UsageRole): UsageSpan {
  return { text, role };
}

function lineWidth(line: UsageLine): number {
  return line.reduce((sum, part) => sum + columnsOf(part.text), 0);
}

/** `line` cut to `width` columns: the last guard that keeps every line inside the view. */
function clip(line: UsageLine, width: number): UsageLine {
  const clipped: UsageLine = [];
  let room = width;
  for (const part of line) {
    const text = sliceColumns(part.text, Math.max(0, room));
    if (text) clipped.push(span(text, part.role));
    room -= columnsOf(text);
  }
  return clipped;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** A row's cost, or "no price" when all its tokens come from models without a price. */
export function costText(row: UsageRow): string {
  return row.tokens > 0 && row.unpricedTokens >= row.tokens ? "no price" : formatUsd(row.costUsd);
}

/** "Sep 11", or "Sep 11, 2025" outside `thisYear`. */
function shortDate(date: Date, thisYear: number): string {
  const text = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === thisYear ? text : `${text}, ${date.getFullYear()}`;
}

/** The local midnight of a report day like "2026-09-11". */
function dayDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function rangeTitle(report: UsageReport): string {
  if (report.range !== "between" || report.sinceMs === undefined || report.untilMs === undefined) {
    return usageRangeLabel(report.range);
  }
  const thisYear = new Date(report.generatedAtMs).getFullYear();
  return `${shortDate(new Date(report.sinceMs), thisYear)} to ${shortDate(new Date(report.untilMs), thisYear)}`;
}

/** The report's rows in the mode's order: the report's own (most cost first), or most tokens. */
function inModeOrder<T extends UsageRow>(rows: T[], mode: UsageMode): T[] {
  return mode === "cost" ? rows : [...rows].sort((a, b) => b.tokens - a.tokens);
}

function providerRole(report: UsageReport, providerID: string): UsageRole {
  const index = report.providers.findIndex((row) => row.providerID === providerID);
  return index < 0 ? "muted" : `provider:${index}`;
}

/** The total on one line, or two when it does not fit. */
function totalLines(view: View, width: number): UsageLine[] {
  const { totals } = view.report;
  const sessions = plural(totals.sessions, "session");
  const title =
    view.mode === "cost"
      ? span(formatUsd(totals.costUsd), "title")
      : span(`${formatTokens(totals.tokens.processed)} tokens`, "title");
  const detail =
    view.mode === "cost"
      ? `${sessions} · API estimate`
      : `${sessions} · ${formatUsd(totals.costUsd)} API estimate`;
  const fits = columnsOf(title.text) + 2 + columnsOf(detail) <= width;
  return fits ? [[title, span(`  ${detail}`, "muted")]] : [[title], [span(detail, "muted")]];
}

/** "Unpriced tokens excluded: 4.0% (exo-free)", when any tokens have no price. */
function unpricedLines(view: View, width: number): UsageLine[] {
  const { totals, models } = view.report;
  if (totals.unpricedShare <= 0) return [];
  const label = "Unpriced tokens excluded: ";
  const share = formatShare(totals.unpricedShare);
  const names = models.filter((row) => !row.priced && row.tokens > 0).map((row) => row.modelID);
  const shown =
    names.length > 3
      ? `${names.slice(0, 3).join(", ")} +${names.length - 3} more`
      : names.join(", ");
  const room = width - columnsOf(label) - columnsOf(share) - " ()".length;
  const line = [span(label, "muted"), span(share, "warning")];
  if (shown && room >= 2) line.push(span(` (${truncateColumns(shown, room)})`, "muted"));
  return [line];
}

type Metric = "cost" | "share" | "tokens";

const METRIC_HEADERS: Record<Metric, string> = { cost: "Cost", share: "Share", tokens: "Tokens" };

/** A table's number columns: the mode's amount, its share, then the other amount. */
function metricsOf(mode: UsageMode): Metric[] {
  return mode === "cost" ? ["cost", "share", "tokens"] : ["tokens", "share", "cost"];
}

function metricText(view: View, metric: Metric, row: UsageRow): string {
  if (metric === "cost") return costText(row);
  if (metric === "tokens") return formatTokens(row.tokens);
  return formatShare(view.mode === "cost" ? row.costShare : row.tokenShare);
}

function metricRole(view: View, metric: Metric, text: string): UsageRole {
  if (metric === "share" || text === "no price") return "muted";
  return metric === view.mode ? "value" : "text";
}

/** Each metric column's width: its header or its widest number. */
function metricWidths(view: View, metrics: Metric[], rows: UsageRow[]): number[] {
  return metrics.map((metric) =>
    Math.max(
      columnsOf(METRIC_HEADERS[metric]),
      ...rows.map((row) => columnsOf(metricText(view, metric, row))),
    ),
  );
}

/** The metric cells of one table line: right-aligned, two spaces before each. */
function metricSpans(
  view: View,
  metrics: Metric[],
  widths: number[],
  row: UsageRow | undefined,
): UsageLine {
  return metrics.map((metric, index) => {
    if (!row) return span(`  ${padStartColumns(METRIC_HEADERS[metric], widths[index])}`, "muted");
    const text = metricText(view, metric, row);
    return span(`  ${padStartColumns(text, widths[index])}`, metricRole(view, metric, text));
  });
}

/**
 * The providers as a table under a header: name, the mode's amount, its share and the other
 * amount. A narrow list drops the other amount, then the share, before names get short.
 */
function providerLines(view: View, width: number): UsageLine[] {
  const rows = inModeOrder(view.report.providers, view.mode);
  const names = rows.map((row) => getQuotaProviderDisplayLabel(row.providerID));
  const nameWidest = Math.max(columnsOf("Provider") - columnsOf(DOT), ...names.map(columnsOf));
  let metrics = metricsOf(view.mode);
  let widths = metricWidths(view, metrics, rows);
  const room = () => width - columnsOf(DOT) - widths.reduce((sum, item) => sum + item + 2, 0);
  while (metrics.length > 1 && room() < Math.min(nameWidest, 8)) {
    metrics = metrics.slice(0, -1);
    widths = widths.slice(0, -1);
  }
  const nameWidth = Math.max(1, Math.min(nameWidest, room()));
  return [
    [
      span(padEndColumns("Provider", columnsOf(DOT) + nameWidth), "muted"),
      ...metricSpans(view, metrics, widths, undefined),
    ],
    ...rows.map((row, index) => [
      span(DOT, providerRole(view.report, row.providerID)),
      span(padEndColumns(truncateColumns(names[index], nameWidth), nameWidth), "text"),
      ...metricSpans(view, metrics, widths, row),
    ]),
  ];
}

/** "Sep 11 … Sep 26 … Oct 10" under the chart: first, middle (when it fits) and last day. */
function dateAxis(
  columns: { first: string; last: string }[],
  columnStart: (index: number) => number,
  chartWidth: number,
  thisYear: number,
): string {
  const first = shortDate(dayDate(columns[0].first), thisYear);
  const last = shortDate(dayDate(columns[columns.length - 1].last), thisYear);
  const lastAt = chartWidth - columnsOf(last);
  if (lastAt < columnsOf(first) + 2) return truncateColumns(first, chartWidth);
  const middleIndex = Math.floor(columns.length / 2);
  const middle = shortDate(dayDate(columns[middleIndex].first), thisYear);
  const middleCenter = (columnStart(middleIndex) + columnStart(middleIndex + 1)) / 2;
  const middleAt = Math.round(middleCenter - columnsOf(middle) / 2);
  const middleFits = middleAt >= columnsOf(first) + 2 && middleAt + columnsOf(middle) + 2 <= lastAt;
  const axis = columns.length >= 3 && middleFits ? padEndColumns(first, middleAt) + middle : first;
  return padEndColumns(axis, lastAt) + last;
}

/** One day of a chart: its cost or its tokens. */
type ChartDay = { date: string; amount: number };

type ChartColumns = {
  columns: { first: string; last: string; amount: number }[];
  daysPerColumn: number;
  max: number;
};

/**
 * `days` in at most `plotWidth` columns: one day per column, or the same number of days per
 * column (the last may hold fewer) when the days do not fit.
 */
function chartColumns(days: ChartDay[], plotWidth: number): ChartColumns {
  const daysPerColumn = Math.ceil(days.length / Math.max(1, plotWidth));
  const columns: ChartColumns["columns"] = [];
  for (let index = 0; index < days.length; index += daysPerColumn) {
    const group = days.slice(index, index + daysPerColumn);
    columns.push({
      first: group[0].date,
      last: group[group.length - 1].date,
      amount: group.reduce((sum, day) => sum + day.amount, 0),
    });
  }
  return { columns, daysPerColumn, max: Math.max(...columns.map((column) => column.amount)) };
}

/** The report's days with the mode's amount: all of them, or one model's (0 on its other days). */
function chartDays(report: UsageReport, mode: UsageMode, model?: UsageModelRow): ChartDay[] {
  const amountOf = (row: { costUsd: number; tokens: number }) =>
    mode === "cost" ? row.costUsd : row.tokens;
  if (!model) return report.days.map((day) => ({ date: day.date, amount: amountOf(day) }));
  const modelDays = new Map(model.days.map((day) => [day.date, amountOf(day)]));
  return report.days.map((day) => ({ date: day.date, amount: modelDays.get(day.date) ?? 0 }));
}

/**
 * The daily chart: a title, `rows` rows of block characters (one column per day, or per few
 * days when the days do not fit) with the top value on the left, a baseline with 0, and a date
 * axis. Columns of 3 cells or more keep their last cell empty, so the days stand apart.
 * Nothing when the range has fewer than two days or nothing to draw.
 */
function chartLines(
  days: ChartDay[],
  mode: UsageMode,
  thisYear: number,
  width: number,
  rows: number,
): UsageLine[] {
  const formatAmount = mode === "cost" ? formatUsd : formatTokens;
  if (days.length < 2 || days.every((day) => day.amount <= 0)) return [];

  // The label column decides the room for the columns, and the columns decide the top value:
  // start at the width of "0" and widen the label column until the top value fits in it.
  let labelWidth = 1;
  let grouping = chartColumns(days, width - labelWidth - 1);
  while (columnsOf(formatAmount(grouping.max)) > labelWidth) {
    labelWidth = columnsOf(formatAmount(grouping.max));
    grouping = chartColumns(days, width - labelWidth - 1);
  }
  const { columns, daysPerColumn, max } = grouping;
  // `columns` were grouped for this plot width, so every column gets at least one cell.
  const plotWidth = Math.max(1, width - labelWidth - 1);
  const chartWidth = Math.min(plotWidth, columns.length * CHART_COLUMN_MAX);
  // Column `index` covers [columnStart(index), columnStart(index + 1)): widths differ by one at most.
  const columnStart = (index: number) => Math.floor((index * chartWidth) / columns.length);
  const gap = Math.floor(chartWidth / columns.length) >= CHART_GAP_FROM;
  // Each column's height in eighths of a row; a day above 0 always shows.
  const eighths = columns.map((column) =>
    column.amount <= 0 ? 0 : Math.max(1, Math.round((column.amount / max) * rows * 8)),
  );

  const [daily, amount] = mode === "cost" ? ["Daily cost", "Cost"] : ["Daily tokens", "Tokens"];
  const title = daysPerColumn === 1 ? daily : `${amount} per ${daysPerColumn} days`;
  const lines: UsageLine[] = [[span(title, "heading")]];
  for (let row = 0; row < rows; row += 1) {
    const below = (rows - 1 - row) * 8;
    const cells = columns.map((_, index) => {
      const fill = Math.min(8, Math.max(0, eighths[index] - below));
      const cell = fill === 0 ? " " : BLOCKS[fill - 1];
      const width = columnStart(index + 1) - columnStart(index);
      return gap ? `${cell.repeat(width - 1)} ` : cell.repeat(width);
    });
    const label = row === 0 ? formatAmount(max) : "";
    lines.push([
      span(`${padStartColumns(label, labelWidth)} `, "muted"),
      span(cells.join(""), "bar"),
    ]);
  }
  lines.push([
    span(`${padStartColumns("0", labelWidth)} `, "muted"),
    span("─".repeat(chartWidth), "muted"),
  ]);
  const axis = dateAxis(columns, columnStart, chartWidth, thisYear);
  lines.push([span(`${" ".repeat(labelWidth + 1)}${axis}`, "muted")]);
  return lines;
}

/** Label-over-value cells in as few rows as fit in `width`, the rows evenly filled. */
function grid(items: [label: string, value: string][], width: number): UsageLine[] {
  const cellMin =
    Math.max(...items.flatMap(([label, value]) => [columnsOf(label), columnsOf(value)])) + 2;
  const rows = Math.ceil(items.length / Math.max(1, Math.floor(width / cellMin)));
  const perRow = Math.ceil(items.length / rows);
  const cellWidth = Math.floor(width / perRow);
  const lines: UsageLine[] = [];
  for (let index = 0; index < items.length; index += perRow) {
    const row = items.slice(index, index + perRow);
    lines.push(row.map(([label]) => span(padEndColumns(label, cellWidth), "muted")));
    lines.push(row.map(([, value]) => span(padEndColumns(value, cellWidth), "value")));
  }
  return lines;
}

function totalsLines(view: View, width: number): UsageLine[] {
  const { tokens, cacheSavingsUsd } = view.report.totals;
  return [
    [span("Totals", "heading")],
    ...grid(
      [
        ["Processed tokens", formatTokens(tokens.processed)],
        ["Cached input", formatTokens(tokens.cachedInput)],
        ["Uncached input", formatTokens(tokens.uncachedInput)],
        ["Output", formatTokens(tokens.output)],
        ["Cache savings", formatUsd(cacheSavingsUsd)],
      ],
      width,
    ),
  ];
}

/**
 * `width` cells split in proportion to `amounts` (largest remainder); a part above 0 gets at
 * least one cell, taken from the widest part.
 */
function splitWidth(amounts: number[], width: number): number[] {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const exact = amounts.map((amount) => (amount / total) * width);
  const cells = exact.map(Math.floor);
  let left = width - cells.reduce((sum, count) => sum + count, 0);
  const byRemainder = amounts
    .map((_, index) => index)
    .sort((a, b) => exact[b] - cells[b] - (exact[a] - cells[a]));
  for (const index of byRemainder) {
    if (left <= 0) break;
    cells[index] += 1;
    left -= 1;
  }
  amounts.forEach((amount, index) => {
    const widest = cells.indexOf(Math.max(...cells));
    if (amount > 0 && cells[index] === 0 && cells[widest] > 1) {
      cells[widest] -= 1;
      cells[index] = 1;
    }
  });
  return cells;
}

/**
 * One stacked bar and its legend: cost by type, or tokens by type. Text gets a bar of shade
 * marks of at most 64 columns; `colored` (the TUI) a thin line as wide as `width`, a space
 * between its parts.
 */
function byTypeLines(
  kind: UsageMode,
  amounts: UsageByType,
  width: number,
  colored: boolean,
): UsageLine[] {
  const barWidth = colored ? width : Math.min(width, BY_TYPE_MAX_WIDTH);
  const parts = (["input", "cacheRead", "cacheWrite", "output"] as const).map((part) => ({
    part,
    amount: amounts[part],
  }));
  if (parts.every((part) => part.amount <= 0)) return [];

  const shown = parts.filter((part) => part.amount > 0).length;
  const gaps = colored ? shown - 1 : 0;
  const cells = splitWidth(
    parts.map((part) => part.amount),
    barWidth - gaps,
  );
  const bar: UsageLine = [];
  parts.forEach((part, index) => {
    if (cells[index] === 0) return;
    if (colored && bar.length > 0) bar.push(span(" ", "muted"));
    const mark = colored ? THIN_BAR : PART_MARKS[part.part];
    bar.push(span(mark.repeat(cells[index]), `part:${part.part}`));
  });
  const legend: UsageLine[] = [];
  for (const part of parts) {
    const amount = kind === "cost" ? formatUsd(part.amount) : formatTokens(part.amount);
    const item = [
      span(colored ? THIN_MARK : PART_MARKS[part.part], `part:${part.part}`),
      span(` ${PART_LABELS[part.part]} `, "muted"),
      span(amount, "value"),
    ];
    const current = legend[legend.length - 1];
    if (current && lineWidth(current) + 3 + lineWidth(item) <= barWidth) {
      current.push(span("   ", "muted"), ...item);
    } else {
      legend.push(item);
    }
  }
  const title = kind === "cost" ? "Cost by type" : "Tokens by type";
  return [[span(title, "heading")], bar, ...legend];
}

type BreakdownEntry = { name: string; dot: UsageRole | undefined; row: UsageRow };

function breakdownEntries(view: View): BreakdownEntry[] {
  const { report } = view;
  if (view.breakdown === "day") {
    return report.days
      .filter((row) => row.tokens > 0)
      .reverse()
      .map((row) => {
        const date = dayDate(row.date);
        return {
          name: `${WEEKDAYS[date.getDay()]}, ${shortDate(date, view.thisYear)}`,
          dot: undefined,
          row,
        };
      });
  }
  return breakdownModels(report, view.mode).map((row) => ({
    name: modelName(report, row),
    dot: providerRole(report, row.providerID),
    row,
  }));
}

/** A model's id, with its provider when more than one provider serves that id. */
function modelName(report: UsageReport, model: UsageModelRow): string {
  const providers = report.models.filter((row) => row.modelID === model.modelID).length;
  return providers > 1 ? `${model.providerID}/${model.modelID}` : model.modelID;
}

/**
 * The models of the model breakdown, in its order. In `usageView` with the model breakdown,
 * the last lines are these models' rows, one each, in this order.
 */
export function breakdownModels(report: UsageReport, mode: UsageMode): UsageModelRow[] {
  return inModeOrder(
    report.models.filter((row) => row.tokens > 0),
    mode,
  );
}

/**
 * The breakdown table: #, Model or Day, then the mode's amount, Share and the other amount.
 * `colored` (the TUI) puts a bar of each row's amount between the names and the numbers, the
 * biggest row's bar full, when there is room for it.
 */
function breakdownLines(view: View, width: number, maxRows: number, colored: boolean): UsageLine[] {
  const entries = breakdownEntries(view);
  const shown = entries.slice(0, maxRows);
  const metrics = metricsOf(view.mode);
  const widths = metricWidths(
    view,
    metrics,
    shown.map((entry) => entry.row),
  );
  const numberWidth = String(shown.length).length;
  const dotWidth = view.breakdown === "model" ? columnsOf(DOT) : 0;
  const metricsWidth = widths.reduce((sum, metricWidth) => sum + metricWidth + 2, 0);
  const fixed = numberWidth + 2 + dotWidth + metricsWidth;
  const nameWidest = Math.min(
    ROW_NAME_MAX_WIDTH,
    Math.max(4, ...shown.map((entry) => columnsOf(entry.name))),
  );
  const barRoom = width - fixed - nameWidest - 2;
  const barWidth = colored && barRoom >= ROW_BAR_MIN_WIDTH ? barRoom : 0;
  const nameWidth = barWidth > 0 ? nameWidest : Math.max(4, width - fixed);
  const amountOf = (row: UsageRow) => (view.mode === "cost" ? row.costUsd : row.tokens);
  const most = Math.max(0, ...shown.map((entry) => amountOf(entry.row)));
  const barSpans = (entry: BreakdownEntry): UsageLine => {
    if (barWidth === 0) return [];
    const amount = amountOf(entry.row);
    const filled = most > 0 && amount > 0 ? Math.max(1, Math.round((amount / most) * barWidth)) : 0;
    return [
      span("  ", "muted"),
      span(THIN_BAR.repeat(filled), entry.dot ?? "bar"),
      span(" ".repeat(barWidth - filled), "muted"),
    ].filter((part) => part.text.length > 0);
  };

  const nameHeader = view.breakdown === "model" ? "Model" : "Day";
  const lines: UsageLine[] = [
    [span("Breakdown", "heading")],
    [
      span(
        `${padStartColumns("#", numberWidth)}  ${padEndColumns(nameHeader, dotWidth + nameWidth)}${barWidth > 0 ? " ".repeat(barWidth + 2) : ""}`,
        "muted",
      ),
      ...metricSpans(view, metrics, widths, undefined),
    ],
  ];
  shown.forEach((entry, position) => {
    lines.push([
      span(`${padStartColumns(String(position + 1), numberWidth)}  `, "muted"),
      ...(entry.dot ? [span(DOT, entry.dot)] : []),
      span(padEndColumns(truncateColumns(entry.name, nameWidth), nameWidth), "text"),
      ...barSpans(entry),
      ...metricSpans(view, metrics, widths, entry.row),
    ]);
  });
  if (entries.length > shown.length) {
    lines.push([span(`and ${entries.length - shown.length} more`, "muted")]);
  }
  return lines;
}

/** `right` beside `left`, starting at column `rightStart`. */
function sideBySide(left: UsageLine[], right: UsageLine[], rightStart: number): UsageLine[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const leftLine = left[index] ?? [];
    const rightLine = right[index] ?? [];
    if (rightLine.length === 0) return leftLine;
    const gap = " ".repeat(Math.max(0, rightStart - lineWidth(leftLine)));
    return [...leftLine, span(gap, "muted"), ...rightLine];
  });
}

function buildView(
  report: UsageReport,
  options: UsageViewOptions,
  contents: Contents,
): UsageLine[] {
  const width = Math.max(0, Math.floor(options.width));
  if (report.totals.tokens.processed <= 0) {
    return [clip([span("No usage in this range.", "muted")], width)];
  }
  const view: View = {
    report,
    mode: options.mode,
    breakdown: options.breakdown,
    thisYear: new Date(report.generatedAtMs).getFullYear(),
  };
  const layoutWidth = Math.max(LAYOUT_MIN_WIDTH, width);

  const listWidth = Math.min(LIST_MAX_WIDTH, layoutWidth);
  const providers = providerLines(view, listWidth);
  const total = totalLines(view, listWidth);
  const listWith = (noteWidth: number) =>
    [...total, ...unpricedLines(view, noteWidth), [], ...providers].map((line) =>
      clip(line, listWidth),
    );
  const list = listWith(listWidth);
  let top = list;
  if (contents.chart) {
    // Beside the list when the chart gets room there; the unpriced note may give up its model
    // names (cut to the table's width) for that.
    const tableWidth = Math.max(LAYOUT_MIN_WIDTH, ...[...providers, ...total].map(lineWidth));
    const besideList = [list, listWith(Math.min(listWidth, tableWidth))].find(
      (lines, index) =>
        layoutWidth - Math.max(...lines.map(lineWidth)) - SIDE_GAP >=
        (index === 0 ? BESIDE_CHART_ROOMY_WIDTH : BESIDE_CHART_MIN_WIDTH),
    );
    if (besideList) {
      const listUsed = Math.max(...besideList.map(lineWidth));
      // As tall as the list: the chart's title, baseline and dates take 3 lines.
      const rows = Math.min(CHART_ROWS_MAX, Math.max(CHART_ROWS, besideList.length - 3));
      const chart = chartLines(
        chartDays(report, view.mode),
        view.mode,
        view.thisYear,
        layoutWidth - listUsed - SIDE_GAP,
        rows,
      );
      top = sideBySide(besideList, chart, listUsed + SIDE_GAP);
    } else {
      const chart = chartLines(
        chartDays(report, view.mode),
        view.mode,
        view.thisYear,
        layoutWidth,
        CHART_ROWS,
      );
      if (chart.length > 0) top = [...list, [], ...chart];
    }
  }
  const sections = [
    top,
    totalsLines(view, layoutWidth),
    byTypeLines(
      view.mode,
      view.mode === "cost" ? report.totals.costByType : report.totals.tokensByType,
      layoutWidth,
      contents.colored,
    ),
    breakdownLines(view, layoutWidth, contents.breakdownRows, contents.colored),
  ].filter((lines) => lines.length > 0);
  return sections
    .flatMap((lines, index) => (index === 0 ? lines : [[], ...lines]))
    .map((line) => clip(line, width));
}

/** The usage view for the TUI Usage tab: lines of role-tagged spans, each at most `width`. */
export function usageView(report: UsageReport, options: UsageViewOptions): UsageLine[] {
  return buildView(report, options, {
    chart: true,
    breakdownRows: Number.POSITIVE_INFINITY,
    colored: true,
  });
}

/** Below this width per side, cost by type and tokens by type stack in the model detail. */
const DETAIL_SIDE_MIN_WIDTH = 30;

/** The model detail's first line: the provider's dot and the model's name, cut to `width`. */
export function modelDetailTitle(
  report: UsageReport,
  model: UsageModelRow,
  width: number,
): UsageLine {
  const room = Math.max(0, Math.floor(width));
  const name = truncateColumns(modelName(report, model), room - columnsOf(DOT));
  return clip([span(DOT, providerRole(report, model.providerID)), span(name, "title")], room);
}

/**
 * One model of the breakdown, like T3 Code's model popup: its name, provider and share, then
 * Cost, Tokens, cost per 1M tokens and cache hit (cache reads ÷ all input tokens), its daily
 * chart over the report's days, and cost by type and tokens by type, side by side when they
 * fit. Every line fits in `width`.
 */
export function modelDetailView(
  report: UsageReport,
  model: UsageModelRow,
  options: ModelDetailOptions,
): UsageLine[] {
  const width = Math.max(0, Math.floor(options.width));
  const layoutWidth = Math.max(LAYOUT_MIN_WIDTH, width);
  const { mode } = options;
  const thisYear = new Date(report.generatedAtMs).getFullYear();
  const share =
    mode === "cost"
      ? `${formatShare(model.costShare)} of cost`
      : `${formatShare(model.tokenShare)} of tokens`;
  const { input, cacheRead, cacheWrite } = model.tokensByType;
  const allInput = input + cacheRead + cacheWrite;
  let perMillion = "—";
  if (!model.priced) perMillion = "no price";
  else if (model.tokens > 0) perMillion = formatUsd((model.costUsd / model.tokens) * 1_000_000);

  const lines: UsageLine[] = [
    modelDetailTitle(report, model, width),
    [span(`${getQuotaProviderDisplayLabel(model.providerID)} · ${share}`, "muted")],
    [],
    ...grid(
      [
        ["Cost", costText(model)],
        ["Tokens", formatTokens(model.tokens)],
        ["Per 1M tokens", perMillion],
        ["Cache hit", allInput > 0 ? formatShare(cacheRead / allInput) : "—"],
      ],
      layoutWidth,
    ),
  ];
  const chart = chartLines(
    chartDays(report, mode, model),
    mode,
    thisYear,
    layoutWidth,
    DETAIL_CHART_ROWS,
  );
  if (chart.length > 0) lines.push([], ...chart);

  const sideWidth = Math.floor((layoutWidth - COLUMN_GAP) / 2);
  const sideBySideFits = sideWidth >= DETAIL_SIDE_MIN_WIDTH;
  const byTypeWidth = sideBySideFits ? sideWidth : layoutWidth;
  const costByType = byTypeLines("cost", model.costByType, byTypeWidth, true);
  const tokensByType = byTypeLines("tokens", model.tokensByType, byTypeWidth, true);
  if (sideBySideFits && costByType.length > 0) {
    lines.push([], ...sideBySide(costByType, tokensByType, sideWidth + COLUMN_GAP));
  } else {
    for (const section of [costByType, tokensByType]) {
      if (section.length > 0) lines.push([], ...section);
    }
  }
  return lines.map((line) => clip(line, width));
}

/**
 * The usage view as plain text for Web `/quota` and the CLI: a range title, no chart, the top
 * 10 breakdown rows, at most 64 columns.
 */
export function usageText(report: UsageReport, options: UsageTextOptions): string {
  const width = Math.min(TEXT_MAX_WIDTH, options.width ?? TEXT_MAX_WIDTH);
  const lines = buildView(
    report,
    { mode: options.mode, breakdown: options.breakdown, width },
    { chart: false, breakdownRows: TEXT_BREAKDOWN_ROWS, colored: false },
  );
  const title = truncateColumns(`Usage · ${rangeTitle(report)}`, width);
  const texts = lines.map((line) =>
    line
      .map((part) => part.text)
      .join("")
      .trimEnd(),
  );
  return [title, ...texts].join("\n");
}
