/**
 * The `/quota` quick look: the quotas next to what OpenCode's own history used, like a short
 * take on T3 Code's usage page. Pure. The TUI dialog draws `quickLookView`; the TUI toast, the
 * TUI chat form and Web/Desktop `/quota` print `quickLookText`.
 *
 * Both forms show one list with a block per provider. A provider OpenCode used gets its cost
 * line and, when quota checks it too, its limit bars under it; a quota provider OpenCode did
 * not use shows "no usage in OpenCode". `quotaProviderIdsOfUsage` matches the two.
 */
import { describeError } from "../core/errors.js";
import { paceOf, paceText } from "../core/pace.js";
import type { QuotaSnapshot, Words } from "../core/types.js";
import type { UsageProviderRow, UsageReport } from "../core/usage.js";
import { USAGE_RANGES, type UsageRange, usageRangeLabel } from "../core/usage-ranges.js";
import { WINDOWS } from "../core/windows.js";
import {
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
} from "../lib/provider-metadata.js";
import { columnsOf, padStartColumns, sliceColumns } from "./columns.js";
import {
  barParts,
  DEFAULT_WORDS,
  evenUseCell,
  fit,
  formatShare,
  formatTokens,
  formatUsd,
  type Level,
  levelOf,
  percentText,
  resetText,
  rowValueText,
  type Thresholds,
} from "./format.js";
import { type Group, type RowSettings, type VisibleRow, visibleGroups } from "./select.js";
import {
  byTypeBarLines,
  costText,
  dailyChartLines,
  type UsageMode,
  type UsageRole,
} from "./usage.js";

/**
 * What a span shows, so the TUI can color it: the usage view's roles, a bar's level color
 * (`good`, `warning`, `low`) and its empty part, the even-use `marker`, a provider's `error`,
 * and a `chip`, the picked mode or range.
 */
export type QuickLookRole = UsageRole | Level | "empty" | "marker" | "error" | "chip";
type QuickLookSpan = { text: string; role: QuickLookRole };
export type QuickLookLine = QuickLookSpan[];

/** The ranges the quick look offers: the usage ranges without "between", which needs dates. */
export type QuickLookRange = Exclude<UsageRange, "between">;
export const DEFAULT_QUICK_LOOK_RANGE: QuickLookRange = "7d";

export type QuickLookInput = {
  /** Undefined before the first snapshot arrives. */
  snapshot: QuotaSnapshot | undefined;
  /** The usage of `range`; undefined while it loads or after it failed (`usageNote` says so). */
  usage: UsageReport | undefined;
  usageNote?: string;
  range: QuickLookRange;
  mode: UsageMode;
  /** Your row names, order and hidden rows (the sidebar's). */
  settings: RowSettings;
  thresholds: Thresholds;
  nowMs: number;
  width: number;
};

/** The dialog: a fixed header and key line, and the body between them, which scrolls. */
type QuickLookView = { header: QuickLookLine; body: QuickLookLine[]; keys: QuickLookLine };

type QuickLookTextInput = {
  snapshot: QuotaSnapshot | undefined;
  usage: UsageReport | undefined;
  settings: RowSettings;
  nowMs: number;
  /** The columns a line may take (the toast's); without it lines are as long as they get. */
  width?: number;
};

/** A provider's block: its usage (when OpenCode used it) and its quota groups (when checked). */
type Block = { name: string; dot: UsageRole; usage?: UsageProviderRow; groups: Group[] };
/** The widths of the provider name and limit label columns, shared by every block. */
type Columns = { name: number; label: number };

const SESSION_RANGES: ReadonlySet<UsageRange> = new Set(["session", "session_tree"]);
const INDENT = "    ";
/** The provider name column: as wide as the longest name, within these bounds. */
const NAME_MIN_WIDTH = 10;
const NAME_MAX_WIDTH = 24;
const AMOUNT_WIDTH = 10;
/** The limit label column: as wide as the longest label, within these bounds. */
const LABEL_MIN_WIDTH = 6;
const LABEL_MAX_WIDTH = 16;
const BAR_WIDTH = 20;
/** Narrower than this under the percent, the reset and pace words go under the label. */
const UNDER_MIN_WIDTH = 16;
/** The total and its two lines beside the chart. */
const TOTALS_WIDTH = 38;
const COLUMN_GAP = 3;
/** Below this the chart goes under the totals. */
const CHART_MIN_WIDTH = 24;
const CHART_ROWS = 2;
/** The "by type" bar stays short, like the usage view's. */
const BY_TYPE_MAX_WIDTH = 64;
const TEXT_NAME_MAX = 20;
/** A short-text line that goes on under the one before starts this far in. */
const TEXT_CONTINUE = "  ";
const KEY_HINTS = "c/t cost or tokens · ←/→ range · u full usage · s settings · esc close";

function span(text: string, role: QuickLookRole): QuickLookSpan {
  return { text, role };
}

function lineWidth(line: QuickLookLine): number {
  return line.reduce((sum, part) => sum + columnsOf(part.text), 0);
}

function clip(line: QuickLookLine, width: number): QuickLookLine {
  const clipped: QuickLookLine = [];
  let room = width;
  for (const part of line) {
    const text = sliceColumns(part.text, Math.max(0, room));
    if (text) clipped.push(span(text, part.role));
    room -= columnsOf(text);
  }
  return clipped;
}

/** `right` beside `left`, starting at column `rightStart`. */
function sideBySide(
  left: QuickLookLine[],
  right: QuickLookLine[],
  rightStart: number,
): QuickLookLine[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const leftLine = left[index] ?? [];
    const rightLine = right[index] ?? [];
    if (rightLine.length === 0) return leftLine;
    const gap = " ".repeat(Math.max(0, rightStart - lineWidth(leftLine)));
    return [...leftLine, span(gap, "muted"), ...rightLine];
  });
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function clampWidth(width: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, width));
}

/** "7 days" for "Last 7 days": the range's label as the range picker shows it. */
function rangeLabel(range: UsageRange): string {
  return usageRangeLabel(range).replace(/^Last /u, "");
}

/**
 * The matching table: the quota providers an OpenCode provider id (a model's `providerID`,
 * like "github-copilot" or "zai-coding-plan") stands for. The id itself (a custom provider
 * named after it), then every quota provider that lists it among its OpenCode ids.
 */
export function quotaProviderIdsOfUsage(usageProviderID: string): string[] {
  return [usageProviderID, ...getQuotaProviderIdsForRuntimeId(usageProviderID)];
}

/**
 * The quota group serves what OpenCode used under `usageProviderID`: its quota provider is one
 * that id stands for, or it shows a custom definition serving that id (`customRowProviders`).
 */
function groupServesUsage(
  group: Group,
  usageProviderID: string,
  customRowProviders: Readonly<Record<string, string>>,
): boolean {
  if (quotaProviderIdsOfUsage(usageProviderID).includes(group.providerId)) return true;
  const prefixes = Object.keys(customRowProviders).filter(
    (prefix) => customRowProviders[prefix] === usageProviderID,
  );
  return group.rows.some(({ row }) => prefixes.some((prefix) => row.id.startsWith(prefix)));
}

/** The ranges ←/→ step through, in order; the session ones only inside a session. */
export function quickLookRanges(inSession: boolean): QuickLookRange[] {
  return USAGE_RANGES.map((item) => item.range).filter(
    (range): range is QuickLookRange =>
      range !== "between" && (inSession || !SESSION_RANGES.has(range)),
  );
}

/** The range `delta` steps from `range`, stopping at the first and the last. */
export function stepRange(
  range: QuickLookRange,
  delta: number,
  inSession: boolean,
): QuickLookRange {
  const ranges = quickLookRanges(inSession);
  const index = Math.max(0, ranges.indexOf(range));
  return ranges[Math.max(0, Math.min(ranges.length - 1, index + delta))] ?? range;
}

/** There are providers, but `onlyCurrentModel` hides them all: none serves the session's model. */
function servesNoCurrentModel(snapshot: QuotaSnapshot): boolean {
  return snapshot.providers.length > 0 && (snapshot.words ?? DEFAULT_WORDS).onlyCurrentModel;
}

/**
 * The providers and rows the quick look shows: the sidebar's, and with `onlyCurrentModel` only
 * those serving the session's current model.
 */
function quotaGroups(snapshot: QuotaSnapshot | undefined, settings: RowSettings): Group[] {
  if (!snapshot) return [];
  return visibleGroups(snapshot, settings, "sidebar", snapshot.words ?? DEFAULT_WORDS);
}

/**
 * One block per provider OpenCode used (most cost, or most tokens, first) with the quota groups
 * it matches, then one per quota group no used provider matched, in the sidebar's order.
 */
function blocksOf(
  groups: Group[],
  snapshot: QuotaSnapshot | undefined,
  report: UsageReport | undefined,
  mode: UsageMode,
): Block[] {
  const customRowProviders = snapshot?.customRowProviders ?? {};
  const used = (report?.providers ?? []).filter((row) => row.tokens > 0);
  const ordered = mode === "cost" ? used : [...used].sort((a, b) => b.tokens - a.tokens);
  const claimed = new Set<Group>();
  const usedBlocks = ordered.map((row): Block => {
    const own = groups.filter(
      (group) => !claimed.has(group) && groupServesUsage(group, row.providerID, customRowProviders),
    );
    for (const group of own) claimed.add(group);
    const index = report?.providers.indexOf(row) ?? 0;
    // One group: its title names the account ("Custom providers (Team)").
    const name = own.length === 1 ? own[0].title : own[0]?.name;
    return {
      name: name ?? getQuotaProviderDisplayLabel(row.providerID),
      dot: `provider:${index}`,
      usage: row,
      groups: own,
    };
  });
  const unused = groups.filter((group) => !claimed.has(group));
  const quotaBlocks = unused.map(
    (group, index): Block => ({
      name: group.title,
      dot: `provider:${(report?.providers.length ?? 0) + index}`,
      groups: [group],
    }),
  );
  return [...usedBlocks, ...quotaBlocks];
}

/** "Quota  Last 7 days" on the left; the Cost/Tokens toggle and the range on the right. */
function headerLine(input: QuickLookInput, width: number): QuickLookLine {
  const left = [span("Quota", "heading"), span(`  ${usageRangeLabel(input.range)}`, "muted")];
  const right = [
    span(" Cost ", input.mode === "cost" ? "chip" : "muted"),
    span(" ", "muted"),
    span(" Tokens ", input.mode === "tokens" ? "chip" : "muted"),
    span("    ‹ ", "muted"),
    span(` ${rangeLabel(input.range)} `, "chip"),
    span(" ›", "muted"),
  ];
  const gap = Math.max(2, width - lineWidth(left) - lineWidth(right));
  return [...left, span(" ".repeat(gap), "muted"), ...right];
}

/** The big total with sessions, tokens and cache savings, and the small daily chart beside it. */
function totalLines(input: QuickLookInput, width: number): QuickLookLine[] {
  const report = input.usage;
  if (!report) return [[span(input.usageNote ?? "Loading usage…", "muted")]];
  const { totals } = report;
  if (totals.tokens.processed <= 0) return [[span("No usage in this range.", "muted")]];
  const sessions = plural(totals.sessions, "session");
  const tokens = `${formatTokens(totals.tokens.processed)} tokens`;
  const saved = `cache saved ${formatUsd(totals.cacheSavingsUsd)}`;
  const left: QuickLookLine[] =
    input.mode === "cost"
      ? [
          [span(formatUsd(totals.costUsd), "title")],
          [span(`${sessions} · API estimate`, "muted")],
          [span(`${tokens} · ${saved}`, "muted")],
        ]
      : [
          [span(tokens, "title")],
          [span(`${sessions} · ${formatUsd(totals.costUsd)} API estimate`, "muted")],
          [span(saved, "muted")],
        ];
  const chartWidth = width - TOTALS_WIDTH - COLUMN_GAP;
  if (chartWidth < CHART_MIN_WIDTH) {
    const chart = dailyChartLines(report, { mode: input.mode, width, rows: CHART_ROWS });
    return chart.length > 0 ? [...left, [], ...chart] : left;
  }
  const chart = dailyChartLines(report, { mode: input.mode, width: chartWidth, rows: CHART_ROWS });
  return sideBySide(left, chart, TOTALS_WIDTH + COLUMN_GAP);
}

/** The cost line: the amount, its share, the other amount and the sessions. */
function usageLine(block: Block, mode: UsageMode, columns: Columns): QuickLookLine {
  const head = [span("● ", block.dot), span(fit(block.name, columns.name), "heading")];
  const row = block.usage;
  if (!row) {
    return [
      ...head,
      span(padStartColumns("—", AMOUNT_WIDTH), "muted"),
      span("  no usage in OpenCode", "muted"),
    ];
  }
  const sessions = plural(row.sessions, "session");
  const [amount, detail] =
    mode === "cost"
      ? [
          costText(row),
          `${formatShare(row.costShare)} of cost · ${formatTokens(row.tokens)} tokens · ${sessions}`,
        ]
      : [
          formatTokens(row.tokens),
          `${formatShare(row.tokenShare)} of tokens · ${costText(row)} · ${sessions}`,
        ];
  return [
    ...head,
    span(padStartColumns(amount, AMOUNT_WIDTH), "value"),
    span(`  ${detail}`, "muted"),
  ];
}

/** A bar of `BAR_WIDTH` cells in its level's color, with the even-use mark │ when known. */
function markedBar(percent: number, level: Level, evenLeft: number | undefined): QuickLookLine {
  const [filled, empty] = barParts("blocks", percent, BAR_WIDTH);
  const cells = [
    ...[...filled].map((text) => span(text, level)),
    ...[...empty].map((text) => span(text, "empty")),
  ];
  if (evenLeft !== undefined) cells[evenUseCell(evenLeft, BAR_WIDTH)] = span("│", "marker");
  const merged: QuickLookLine = [];
  for (const cell of cells) {
    const last = merged[merged.length - 1];
    if (last && last.role === cell.role) last.text += cell.text;
    else merged.push({ ...cell });
  }
  return merged;
}

/** `text` in lines of at most `width` columns, broken between words; a longer word is cut. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const joined = current ? `${current} ${word}` : word;
    if (columnsOf(joined) <= width) {
      current = joined;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    while (columnsOf(current) > width) {
      const head = sliceColumns(current, width);
      if (!head) break;
      lines.push(head);
      current = current.slice(head.length);
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * A limit: its bar with the even-use mark, % left, the reset and the pace words. The reset and
 * the pace follow on the bar's line while they fit in `input.width`; otherwise they go under the
 * percent, wrapped to the columns left there.
 */
function limitLines(
  item: VisibleRow,
  input: QuickLookInput,
  words: Words,
  columns: Columns,
): QuickLookLine[] {
  const { row } = item;
  const label = span(`${INDENT}${fit(item.label, columns.label)} `, "muted");
  const percent = row.percentRemaining;
  if (percent === undefined) return [[label, span(rowValueText(row), "text")]];
  const level = levelOf(percent, input.thresholds);
  const reset = resetText(row, input.nowMs, words);
  const pace = paceOf(row, input.nowMs);
  const percentWidth = columnsOf(percentText(words, 100, true));
  const lines: QuickLookLine[] = [
    [
      label,
      ...markedBar(percent, level, pace?.evenLeft),
      span(`  ${padStartColumns(percentText(words, percent, true), percentWidth)}`, level),
    ],
  ];
  const after: QuickLookSpan[] = [
    ...(reset ? [span(`resets in ${reset}`, "muted")] : []),
    ...(pace ? [span(paceText(pace, words), pace.kind === "fast" ? "warning" : "muted")] : []),
  ];
  // Under the percent; in a very narrow dialog, under the label instead.
  const percentStart = INDENT.length + columns.label + 1 + BAR_WIDTH + 2;
  const under = input.width - percentStart >= UNDER_MIN_WIDTH ? percentStart : INDENT.length;
  const room = Math.max(1, input.width - under);
  for (const part of after) {
    const last = lines[lines.length - 1];
    if (lineWidth(last) + 3 + columnsOf(part.text) <= input.width) {
      last.push(span(" · ", "muted"), part);
      continue;
    }
    for (const piece of wrapWords(part.text, room)) {
      lines.push([span(" ".repeat(under), "muted"), span(piece, part.role)]);
    }
  }
  return lines;
}

/** A block: its cost line, then each quota group's error and limits. */
function blockLines(block: Block, input: QuickLookInput, columns: Columns): QuickLookLine[] {
  const words = input.snapshot?.words ?? DEFAULT_WORDS;
  const lines: QuickLookLine[] = [usageLine(block, input.mode, columns)];
  for (const group of block.groups) {
    if (block.groups.length > 1 && group.account) {
      lines.push([span(`${INDENT}${group.account}`, "muted")]);
    }
    if (group.error) {
      lines.push([
        span(`${INDENT}${describeError(group.error, group.name, input.nowMs)}`, "error"),
      ]);
    } else if (group.unchecked) {
      lines.push([span(`${INDENT}not checked yet`, "muted")]);
    }
    for (const item of group.rows) lines.push(...limitLines(item, input, words, columns));
  }
  return lines;
}

/**
 * The quick look dialog. Header: the range and the Cost/Tokens and range pickers. Body: the
 * totals and the daily chart, one block per provider, cost (or tokens) by type, with a blank
 * line between them. Keys: what each key does. Every line fits in `width` columns.
 */
export function quickLookView(input: QuickLookInput): QuickLookView {
  const width = Math.max(0, Math.floor(input.width));
  const sized = { ...input, width };
  const blocks = blocksOf(
    quotaGroups(input.snapshot, input.settings),
    input.snapshot,
    input.usage,
    input.mode,
  );
  const longest = (texts: string[]) => Math.max(0, ...texts.map((text) => columnsOf(text)));
  const labels = blocks.flatMap((block) => block.groups.flatMap((group) => group.rows));
  const columns: Columns = {
    name: clampWidth(
      longest(blocks.map((block) => block.name)) + 2,
      NAME_MIN_WIDTH,
      NAME_MAX_WIDTH,
    ),
    label: clampWidth(longest(labels.map((item) => item.label)), LABEL_MIN_WIDTH, LABEL_MAX_WIDTH),
  };
  const empty = !input.snapshot
    ? "Loading quota…"
    : servesNoCurrentModel(input.snapshot)
      ? "No quota provider serves the session's current model."
      : "No quota providers found.";
  const blockSections =
    blocks.length > 0
      ? blocks.map((block) => blockLines(block, sized, columns))
      : [[[span(empty, "muted")]]];
  const byType =
    input.usage && input.usage.totals.tokens.processed > 0
      ? byTypeBarLines(input.usage, {
          mode: input.mode,
          width: Math.min(width, BY_TYPE_MAX_WIDTH),
        })
      : [];
  const sections = [totalLines(sized, width), ...blockSections, byType];
  const body = sections
    .filter((lines) => lines.length > 0)
    .flatMap((lines, index) => (index === 0 ? lines : [[], ...lines]))
    .map((line) => clip(line, width));
  return {
    header: clip(headerLine(sized, width), width),
    body,
    keys: clip([span(KEY_HINTS, "muted")], width),
  };
}

/** A group's error and its limits in a few words: "5h 41% left · 7d 68% left". */
function shortLimits(group: Group, words: Words, nowMs: number): string[] {
  const error = group.error ? [describeError(group.error, group.name, nowMs)] : [];
  const limits = group.rows.map(({ row, label }) => {
    const name = row.window ? WINDOWS[row.window].short : fit(label, LABEL_MAX_WIDTH).trimEnd();
    if (row.percentRemaining === undefined) return `${name} ${rowValueText(row)}`;
    const percent = `${name} ${percentText(words, row.percentRemaining, true)}`;
    const pace = words.runsOut ? paceOf(row, nowMs) : undefined;
    return pace?.kind === "fast" ? `${percent} ${paceText(pace, words)}` : percent;
  });
  return [...error, ...limits];
}

/** A piece of a short-text line, and what goes before it when it follows on the same line. */
type Piece = { text: string; before: string };

/**
 * The pieces on lines of at most `width` columns: a piece never splits (a wider one gets a line
 * of its own), and a line that goes on starts with `TEXT_CONTINUE`. No width: one line.
 */
function flowPieces(pieces: Piece[], width: number | undefined): string[] {
  const lines: string[] = [];
  let line = "";
  for (const piece of pieces) {
    const joined = line ? `${line}${piece.before}${piece.text}` : piece.text;
    if (!line || width === undefined || columnsOf(joined) <= width) {
      line = joined;
      continue;
    }
    lines.push(line.trimEnd());
    line = `${TEXT_CONTINUE}${piece.text}`;
  }
  return line ? [...lines, line.trimEnd()] : lines;
}

/**
 * The quick look as short text for the toast and the chat: the range and totals, then one line
 * per provider with its limits and its cost. Pace words show only with `words.runsOut`. With
 * `width`, a line that would be wider goes on under itself, never inside an amount or a limit.
 */
export function quickLookText(input: QuickLookTextInput): string {
  const { usage, nowMs, width } = input;
  const words = input.snapshot?.words ?? DEFAULT_WORDS;
  const blocks = blocksOf(
    quotaGroups(input.snapshot, input.settings),
    input.snapshot,
    usage,
    "cost",
  );
  const header: Piece[] = [{ text: "Quota", before: "" }];
  if (usage) {
    const totals =
      usage.totals.tokens.processed > 0
        ? [formatUsd(usage.totals.costUsd), `${formatTokens(usage.totals.tokens.processed)} tokens`]
        : ["no usage"];
    for (const text of [rangeLabel(usage.range), ...totals]) header.push({ text, before: " · " });
  }
  const nameWidth = Math.min(
    TEXT_NAME_MAX,
    Math.max(0, ...blocks.map((block) => columnsOf(block.name))),
  );
  const lines = blocks.flatMap((block) => {
    const limits = block.groups.flatMap((group) => shortLimits(group, words, nowMs));
    const pieces: Piece[] = [
      { text: `● ${fit(block.name, nameWidth)}`, before: "" },
      ...limits.map((text, index) => ({ text, before: index === 0 ? "  " : " · " })),
      ...(block.usage ? [{ text: costText(block.usage), before: "  " }] : []),
    ];
    return flowPieces(pieces, width);
  });
  if (lines.length === 0 && input.snapshot) {
    lines.push(
      servesNoCurrentModel(input.snapshot)
        ? "No quota provider serves the session's current model. Run /quota_status to see why."
        : "No quota providers found. Run /quota_status to see why.",
    );
  }
  return [...flowPieces(header, width), ...lines].join("\n");
}
