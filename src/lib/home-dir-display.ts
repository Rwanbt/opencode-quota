import type { ReportBlock, ReportDocument } from "./report-document.js";

/**
 * Characters that may end a home-dir match: a path separator (the path goes on below home),
 * whitespace, or punctuation the reports put around paths. Anything else, e.g. the "s" in
 * "/Users/alicesmith" or the "." in "/Users/alice.old", means a different folder.
 *
 * Whitespace ends a match on purpose, so prose such as "not found at /Users/alice is missing"
 * hides the user name. The known cost: a folder whose name continues after a space, e.g.
 * "/Users/alice backup/project", shows as "~ backup/project".
 */
const HOME_DIR_END = "(?=$|[/\\\\\\s|,;:)\\]\"'`])";

/**
 * What may come right before a home-dir match: the start of the text, whitespace, or a
 * delimiter the reports put before paths ("path=", "(", a quote, "a | b", "key:"). Anything
 * else, e.g. "/mnt/备份/Users/alice", means the match is deeper inside another path.
 */
const HOME_DIR_START = "(?<=^|[\\s\"'`=(\\[:,|])";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The home dir without trailing separators, or null when it is empty or a filesystem root
 * ("/", "C:\"), which would turn every path into "~".
 */
function normalizeHomeDir(homeDir: string): string | null {
  const trimmed = homeDir.replace(/[/\\]+$/u, "");
  if (trimmed === "" || /^[A-Za-z]:$/u.test(trimmed)) return null;
  return trimmed;
}

function replaceWholeHomeDir(text: string, home: string): string {
  const pattern = new RegExp(`${HOME_DIR_START}${escapeRegExp(home)}${HOME_DIR_END}`, "gu");
  return text.replace(pattern, "~");
}

/**
 * Shows the home dir as "~" so pasted reports do not reveal the computer's user name:
 * "/Users/alice/.config" -> "~/.config", "/Users/alice" -> "~". Only whole home-dir
 * matches change; "/Users/alicesmith" stays as it is. Display only, never for reading files.
 */
export function replaceHomeDirWithTilde(text: string, homeDir: string): string {
  const home = normalizeHomeDir(homeDir);
  if (!home) return text;
  // A JSON-quoted Windows path doubles its backslashes, e.g. a quoted command in
  // checked_commands: "C:\\Users\\Alice Smith\\.local\\bin\\claude" -> "~\\.local\\bin\\claude".
  const jsonEscapedHome = home.replace(/\\/gu, "\\\\");
  const withoutEscapedHome =
    jsonEscapedHome === home ? text : replaceWholeHomeDir(text, jsonEscapedHome);
  return replaceWholeHomeDir(withoutEscapedHome, home);
}

// Optional fields are only set when the input has them. An optional field set to `undefined`
// is not a JSON value, and OpenCode rejects a command result that contains one.
function replaceHomeDirInBlock(block: ReportBlock, homeDir: string): ReportBlock {
  const tilde = (text: string) => replaceHomeDirWithTilde(text, homeDir);

  switch (block.kind) {
    case "lines":
      return { ...block, lines: block.lines.map(tilde) };
    case "kv":
      return {
        ...block,
        rows: block.rows.map((row) => ({
          ...row,
          key: tilde(row.key),
          ...(row.value !== undefined && { value: tilde(row.value) }),
        })),
      };
    case "table":
      return {
        ...block,
        headers: block.headers.map(tilde),
        ...(block.fullHeaders !== undefined && { fullHeaders: block.fullHeaders.map(tilde) }),
        rows: block.rows.map((row) => row.map(tilde)),
      };
  }
}

/** The same document with the home dir shown as "~" in every piece of text it displays. */
export function replaceHomeDirWithTildeInDocument(
  document: ReportDocument,
  homeDir: string,
): ReportDocument {
  const tilde = (text: string) => replaceHomeDirWithTilde(text, homeDir);
  const heading = document.heading;

  return {
    ...document,
    ...(heading !== undefined && {
      heading: {
        ...heading,
        line: tilde(heading.line),
        ...(heading.subtitle !== undefined && { subtitle: tilde(heading.subtitle) }),
      },
    }),
    sections: document.sections.map((section) => ({
      ...section,
      ...(section.title !== undefined && { title: tilde(section.title) }),
      blocks: section.blocks.map((block) => replaceHomeDirInBlock(block, homeDir)),
    })),
  };
}
