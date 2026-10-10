/**
 * The TUI dialog's tables for /quota rows. The chat text keeps its own layout (see
 * buildQuotaCommandDocument); these only draw the same rows in the dialog.
 */

import { bar, padLeft, wrapDisplayText } from "./format-utils.js";
import { spreadTableGaps } from "./markdown-table.js";
import type { ReportBlock, ReportQuotaRow } from "./report-document.js";

/** The narrowest bar a quota table shrinks to. */
const QUOTA_COMMAND_BAR_WIDTH = 10;

/** The bar's length; a longer one only stretches the eye between a label and its percent. */
export const QUOTA_TABLE_BAR_WIDTH = 24;
/** The rows sit this far in from their provider, as in the chat text. */
const ROW_INDENT = "  ";

export type QuotaBlock = Extract<ReportBlock, { kind: "quota" }>;

/** A run of a laid-out line. Labels, reset times, and notes are muted; the rest is base. */
export type QuotaLineSegment = { text: string; muted: boolean };

/** A table line: the header (bold, accent), a provider (bold), or a row or its note. */
export type QuotaTableLine = {
  style: "header" | "provider" | "row";
  segments: QuotaLineSegment[];
};

export type QuotaTable = { title: string; lines: QuotaTableLine[] };

type ColumnId = "label" | "bar" | "value" | "usage" | "reset";
type ColumnTexts = Partial<Record<ColumnId, string>>;

type TableGroup = {
  title: string;
  /** The header labels, full and compact. A column the group leaves empty has none. */
  headers: Record<"full" | "compact", ColumnTexts>;
  providers: Array<{ provider: string; rows: ReportQuotaRow[] }>;
};

/**
 * Lays out a /quota report's rows as the dialog's two tables, which span `width` columns:
 * "Quota limits" holds the rows with a bar, "Spending & balances" the rows with a value. A
 * provider shows in each table it has rows in, in the report's order; a table without rows
 * is left out. Both tables share one set of columns, so the amounts start where the percents
 * do: the label, the bar, the percent (or amount), used/limit, and the reset time, the last
 * two only when a row has one. As in the token tables, the spare width is spread over the
 * gaps between the columns, and the headers turn compact when the full ones do not fit.
 * The bar keeps QUOTA_TABLE_BAR_WIDTH cells and shrinks only when the columns need the
 * room. Returns undefined when they do not fit even with a chat-length bar, compact
 * headers, and two-space gaps, so the dialog shows the chat lines.
 */
export function layoutQuotaTables(blocks: QuotaBlock[], width: number): QuotaTable[] | undefined {
  const used = blocks[0]?.percentMode === "used";
  const allRows = blocks.flatMap((block) => block.rows);
  const percentRows = allRows.filter((row) => row.barPercent !== undefined);
  const percentHeader = used ? "Used %" : "Left";
  // The percents are right-aligned under their header.
  const percentWidth = Math.max(
    percentHeader.length,
    ...percentRows.map((row) => row.value.length),
  );

  const group = (title: string, item: string, percent: boolean, headers: ColumnTexts) => {
    const providers = blocks
      .map((block) => ({
        provider: block.provider,
        rows: block.rows.filter((row) => (row.barPercent !== undefined) === percent),
      }))
      .filter((entry) => entry.rows.length > 0);
    const rows = providers.flatMap((entry) => entry.rows);
    const usage = rows.some((row) => row.usage);
    const reset = rows.some((row) => row.reset);
    return {
      title,
      headers: {
        full: {
          label: `Provider · ${item}`,
          ...headers,
          ...(usage ? { usage: used ? "Used/limit" : "Used" } : {}),
          ...(reset ? { reset: "Resets in" } : {}),
        },
        compact: {
          label: "Provider",
          ...headers,
          ...(usage ? { usage: "Used" } : {}),
          ...(reset ? { reset: "Resets" } : {}),
        },
      },
      providers,
    } satisfies TableGroup;
  };
  const groups = [
    group("Quota limits", "window", true, {
      bar: "Usage",
      value: padLeft(percentHeader, percentWidth),
    }),
    group("Spending & balances", "item", false, { value: "Amount" }),
  ].filter((entry) => entry.providers.length > 0);

  const columnIds: ColumnId[] = [
    "label",
    ...(percentRows.length > 0 ? (["bar"] as const) : []),
    "value",
    ...(allRows.some((row) => row.usage) ? (["usage"] as const) : []),
    ...(allRows.some((row) => row.reset) ? (["reset"] as const) : []),
  ];
  const cells = (row: ReportQuotaRow, barWidth: number): ColumnTexts => ({
    label: ROW_INDENT + row.label,
    ...(row.barPercent === undefined
      ? { value: row.value }
      : { bar: bar(row.barPercent, barWidth), value: padLeft(row.value, percentWidth) }),
    usage: row.usage,
    reset: row.reset,
  });

  for (let barWidth = QUOTA_TABLE_BAR_WIDTH; barWidth >= QUOTA_COMMAND_BAR_WIDTH; barWidth--) {
    for (const variant of ["full", "compact"] as const) {
      const lines = [
        ...groups.map((entry) => entry.headers[variant]),
        ...allRows.map((row) => cells(row, barWidth)),
      ];
      const widths = columnIds.map((id) =>
        Math.max(...lines.map((texts) => texts[id]?.length ?? 0)),
      );
      const naturalWidth = widths.reduce((sum, w) => sum + w, 0) + 2 * (columnIds.length - 1);
      if (naturalWidth > width) continue;

      const gaps = spreadTableGaps(columnIds.length - 1, width - naturalWidth);
      const starts = columnIds.map((_, i) =>
        widths.slice(0, i).reduce((sum, w, j) => sum + w + gaps[j], 0),
      );
      const place = (texts: ColumnTexts, mutedIds: ColumnId[]): QuotaLineSegment[] => {
        const segments: QuotaLineSegment[] = [];
        let at = 0;
        for (const [i, id] of columnIds.entries()) {
          const text = texts[id];
          if (!text) continue;
          segments.push({ text: " ".repeat(starts[i] - at) + text, muted: mutedIds.includes(id) });
          at = starts[i] + text.length;
        }
        return segments;
      };
      return groups.map((entry) => ({
        title: entry.title,
        lines: [
          { style: "header", segments: place(entry.headers[variant], []) },
          ...entry.providers.flatMap(({ provider, rows }) => [
            { style: "provider" as const, segments: [{ text: provider, muted: false }] },
            ...rows.flatMap((row) => [
              { style: "row" as const, segments: place(cells(row, barWidth), ["label", "reset"]) },
              // The notes sit under the row's bar (or amount), muted, wrapped at the edge.
              ...row.notes
                .flatMap((note) => wrapDisplayText(note, width - starts[1]))
                .map((line) => ({
                  style: "row" as const,
                  segments: [{ text: " ".repeat(starts[1]) + line, muted: true }],
                })),
            ]),
          ]),
        ],
      }));
    }
  }
  return undefined;
}
