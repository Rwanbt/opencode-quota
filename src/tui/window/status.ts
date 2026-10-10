/**
 * The lines of the quota window's Status tab: the /quota_status report, its title and section
 * titles marked so they can be bold. Pure.
 */

export type StatusLine = { text: string; heading: boolean };

/** The report's title starts with "# "; a section title is an unindented line that ends with ":". */
export function statusLines(text: string): StatusLine[] {
  return text.split("\n").map((line) => ({
    text: line,
    heading: line.startsWith("# ") || (/^[^\s-]/u.test(line) && line.endsWith(":")),
  }));
}
