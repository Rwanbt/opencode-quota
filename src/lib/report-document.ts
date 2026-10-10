import { formatLocalCallTimestamp } from "./format-utils.js";
import { renderMarkdownTable, type WidthMode } from "./markdown-table.js";

/**
 * A report's first line. The text shows `line`. The TUI dialog has its own title, so it
 * shows `subtitle` instead: the facts in the line that its title lacks, and the time.
 */
export type ReportHeading = {
  line: string;
  subtitle?: string;
};

export type ReportKvRow = {
  key: string;
  value?: string;
  indent?: 0 | 1;
  trailingColon?: boolean;
};

export type ReportBlock =
  | { kind: "lines"; lines: string[] }
  | { kind: "kv"; rows: ReportKvRow[] }
  | {
      kind: "table";
      headers: string[];
      /** Longer labels, one per column, that the TUI dialog shows when the table fits with them. */
      fullHeaders?: string[];
      rows: string[][];
      aligns: Array<"left" | "right">;
      widthMode?: WidthMode;
    };

export type ReportSection = {
  id: string;
  title?: string;
  blocks: ReportBlock[];
};

export type ReportDocument = {
  heading?: ReportHeading;
  sections: ReportSection[];
};

function hasBlockContent(block: ReportBlock): boolean {
  switch (block.kind) {
    case "lines":
      return block.lines.length > 0;
    case "kv":
      return block.rows.length > 0;
    case "table":
      return block.headers.length > 0 || block.rows.length > 0;
  }
}

/** The sections every renderer shows: empty blocks dropped, then sections left with nothing. */
export function renderableSections(document: ReportDocument): ReportSection[] {
  return document.sections
    .map((section) => ({ ...section, blocks: section.blocks.filter(hasBlockContent) }))
    .filter((section) => section.title || section.blocks.length > 0);
}

/**
 * A command report's heading: "# <title> <time>" in text, "<detail> · <time>" in the dialog.
 * The title echoes the command, e.g. "Quota Status (opencode-quota v5.0.0) (/quota_status)";
 * the detail repeats the facts in it that the dialog title lacks, e.g. "opencode-quota v5.0.0".
 */
export function commandHeading(params: {
  title: string;
  detail?: string;
  generatedAtMs?: number;
}): ReportHeading {
  const time = formatLocalCallTimestamp(params.generatedAtMs);
  return {
    line: `# ${params.title} ${time}`,
    subtitle: params.detail ? `${params.detail} · ${time}` : time,
  };
}

/** A document of one plain message; it renders back to the same text. */
export function messageDocument(text: string): ReportDocument {
  return { sections: [{ id: "message", blocks: [{ kind: "lines", lines: text.split("\n") }] }] };
}

export function renderKvRow(row: ReportKvRow): string {
  const indent = row.indent === 1 ? "  " : "";
  if (row.value !== undefined) {
    return `${indent}- ${row.key}: ${row.value}`;
  }
  return `${indent}- ${row.key}${row.trailingColon ? ":" : ""}`;
}

function renderPlainTextBlock(block: ReportBlock): string[] {
  switch (block.kind) {
    case "lines":
      return block.lines;
    case "kv":
      return block.rows.map(renderKvRow);
    case "table":
      return [
        renderMarkdownTable({
          headers: block.headers,
          rows: block.rows,
          aligns: block.aligns,
          widthMode: block.widthMode,
        }),
      ];
  }
}

function renderMarkdownBlock(block: ReportBlock): string[] {
  switch (block.kind) {
    case "lines":
      return block.lines;
    case "kv":
      return block.rows.map(renderKvRow);
    case "table":
      return [
        renderMarkdownTable({
          headers: block.headers,
          rows: block.rows,
          aligns: block.aligns,
          widthMode: block.widthMode,
        }),
      ];
  }
}

export function renderPlainTextReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) lines.push(document.heading.line);

  for (const section of renderableSections(document)) {
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(section.title);
    }

    for (const [index, block] of section.blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...renderPlainTextBlock(block));
    }
  }

  return lines.join("\n");
}

export function renderMarkdownReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) lines.push(document.heading.line);

  for (const section of renderableSections(document)) {
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(`## ${section.title}`);
      if (section.blocks.length > 0) lines.push("");
    }

    for (const [index, block] of section.blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...renderMarkdownBlock(block));
    }
  }

  return lines.join("\n");
}
