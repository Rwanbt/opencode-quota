import { describe, expect, it } from "vitest";

import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { fitTableToWidth, padTableColumns } from "../src/lib/markdown-table.js";
import {
  commandHeading,
  messageDocument,
  type ReportDocument,
  renderableSections,
  renderMarkdownReport,
  renderPlainTextReport,
} from "../src/lib/report-document.js";

describe("report-document", () => {
  it("renders stable plain-text section spacing across lines and kv blocks", () => {
    const out = renderPlainTextReport({
      sections: [
        {
          id: "status",
          title: "status:",
          blocks: [
            {
              kind: "kv",
              rows: [
                { key: "enabled", value: "true" },
                { key: "providers", trailingColon: true },
                { key: "openai", value: "available", indent: 1 },
              ],
            },
          ],
        },
        {
          id: "notes",
          blocks: [
            {
              kind: "lines",
              lines: ["note one", "note two"],
            },
          ],
        },
      ],
    });

    expect(out).toMatchInlineSnapshot(`
      "status:
      - enabled: true
      - providers:
        - openai: available

      note one
      note two"
    `);
  });

  it("renders stable markdown section spacing across tables and note blocks", () => {
    const out = renderMarkdownReport({
      sections: [
        {
          id: "summary",
          blocks: [
            {
              kind: "table",
              headers: ["Messages", "Cost"],
              aligns: ["right", "right"],
              rows: [["3", "$1.23"]],
            },
          ],
        },
        {
          id: "details",
          title: "Details",
          blocks: [
            {
              kind: "table",
              headers: ["Source", "Tokens"],
              aligns: ["left", "right"],
              rows: [["OpenAI", "123"]],
            },
            {
              kind: "lines",
              lines: ["Follow up note."],
            },
          ],
        },
      ],
    });

    expect(out).toMatchInlineSnapshot(`
      "| Messages |  Cost |
      | -------: | ----: |
      |        3 | $1.23 |

      ## Details

      | Source | Tokens |
      | ------ | -----: |
      | OpenAI |    123 |

      Follow up note."
    `);
  });

  it("builds a command heading: the full line for text, the facts and time for the dialog", () => {
    const generatedAtMs = Date.UTC(2026, 8, 29, 14, 0);
    const time = formatLocalCallTimestamp(generatedAtMs);

    expect(
      commandHeading({
        title: "Quota Status (opencode-quota v5.0.0) (/quota_status)",
        detail: "opencode-quota v5.0.0",
        generatedAtMs,
      }),
    ).toEqual({
      line: `# Quota Status (opencode-quota v5.0.0) (/quota_status) ${time}`,
      subtitle: `opencode-quota v5.0.0 · ${time}`,
    });
    expect(commandHeading({ title: "Usage (Last 7 days) (/quota_usage)", generatedAtMs })).toEqual({
      line: `# Usage (Last 7 days) (/quota_usage) ${time}`,
      subtitle: time,
    });
  });

  it("puts the heading line first in both text renderers", () => {
    const document: ReportDocument = {
      heading: { line: "# Report 16:00 29/09/2026", subtitle: "16:00 29/09/2026" },
      sections: [{ id: "notes", title: "Notes", blocks: [{ kind: "lines", lines: ["note"] }] }],
    };

    expect(renderPlainTextReport(document)).toBe("# Report 16:00 29/09/2026\n\nNotes\nnote");
    expect(renderMarkdownReport(document)).toBe("# Report 16:00 29/09/2026\n\n## Notes\n\nnote");
  });

  it("pads table columns to their widths without pipes or escaping", () => {
    expect(
      padTableColumns({
        headers: ["Model", "Cost"],
        rows: [["gpt|5", "$1.23"], ["claude-opus", "$10.00"], ["two\nlines"]],
        aligns: ["left", "right"],
      }),
    ).toEqual({
      header: ["Model      ", "  Cost"],
      rows: [
        ["gpt|5      ", " $1.23"],
        ["claude-opus", "$10.00"],
        ["two lines  ", "      "],
      ],
    });
  });

  describe("fitTableToWidth", () => {
    const table = {
      headers: ["Model", "Tok", "Cost"],
      fullHeaders: ["Model", "Tokens", "Cost"],
      rows: [
        ["gpt-5", "1.0K", "$1.23"],
        ["claude-opus", "20K", "$10.00"],
      ],
      aligns: ["left", "right", "right"] as Array<"left" | "right">,
    };
    // Natural widths: full labels 11 + 2 + 6 + 2 + 6 = 27, compact labels 11 + 2 + 4 + 2 + 6 = 25.

    it("uses the full labels and spreads the spare width over the gaps", () => {
      const out = fitTableToWidth({ ...table, width: 40 });
      // 13 spare columns over 2 gaps: the left gap takes the odd one.
      expect(out).toEqual({
        header: `Model      ${" ".repeat(9)}Tokens${" ".repeat(8)}  Cost`,
        rows: [
          `gpt-5      ${" ".repeat(9)}  1.0K${" ".repeat(8)} $1.23`,
          `claude-opus${" ".repeat(9)}   20K${" ".repeat(8)}$10.00`,
        ],
      });
      for (const line of [out.header, ...out.rows]) expect(line).toHaveLength(40);
    });

    it("uses the full labels at exactly their natural width", () => {
      const out = fitTableToWidth({ ...table, width: 27 });
      expect(out.header).toBe("Model        Tokens    Cost");
      expect(out.rows).toEqual(["gpt-5          1.0K   $1.23", "claude-opus     20K  $10.00"]);
    });

    it("falls back to the compact labels when the full ones do not fit", () => {
      const out = fitTableToWidth({ ...table, width: 26 });
      expect(out).toEqual({
        header: "Model          Tok    Cost",
        rows: ["gpt-5         1.0K   $1.23", "claude-opus    20K  $10.00"],
      });
      for (const line of [out.header, ...out.rows]) expect(line).toHaveLength(26);
    });

    it("keeps the natural compact layout when even the compact labels do not fit", () => {
      const natural = padTableColumns(table);
      expect(fitTableToWidth({ ...table, width: 24 })).toEqual({
        header: natural.header.join("  "),
        rows: natural.rows.map((row) => row.join("  ")),
      });
    });

    it("stretches a table without full labels using its labels", () => {
      const out = fitTableToWidth({ ...table, fullHeaders: undefined, width: 30 });
      expect(out.header).toBe("Model            Tok      Cost");
      expect(out.rows).toEqual([
        "gpt-5           1.0K     $1.23",
        "claude-opus      20K    $10.00",
      ]);
    });
  });

  it("keeps only sections with a title or a block that has content", () => {
    const document: ReportDocument = {
      sections: [
        { id: "empty", blocks: [{ kind: "lines", lines: [] }] },
        { id: "titled", title: "Title", blocks: [{ kind: "kv", rows: [] }] },
        {
          id: "mixed",
          blocks: [
            { kind: "table", headers: [], rows: [], aligns: [] },
            { kind: "lines", lines: ["kept"] },
          ],
        },
      ],
    };

    expect(renderableSections(document)).toEqual([
      { id: "titled", title: "Title", blocks: [] },
      { id: "mixed", blocks: [{ kind: "lines", lines: ["kept"] }] },
    ]);
  });

  it("renders a message document back to the same text with either renderer", () => {
    const text = "Invalid arguments for /quota\n\nThis command does not accept arguments.";

    expect(messageDocument(text)).toEqual({
      sections: [
        {
          id: "message",
          blocks: [
            {
              kind: "lines",
              lines: [
                "Invalid arguments for /quota",
                "",
                "This command does not accept arguments.",
              ],
            },
          ],
        },
      ],
    });
    expect(renderPlainTextReport(messageDocument(text))).toBe(text);
    expect(renderMarkdownReport(messageDocument(text))).toBe(text);
  });
});
