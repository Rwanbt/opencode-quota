/**
 * Small text helpers for the reports, the dialog tables and the providers: clamping, padding,
 * wrapping, bars, amounts and times.
 */

export type PercentDisplayMode = "remaining" | "used";

/**
 * Clamp a number to an integer within [min, max].
 */
export function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Clamp a value to a percentage [0..100], rounding to the nearest integer.
 * Returns 0 for non-finite inputs.
 */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Pad string to width, truncating from start if too long, adding spaces on left if too short.
 */
export function padLeft(str: string, width: number): string {
  if (str.length >= width) return str.slice(str.length - width);
  return " ".repeat(width - str.length) + str;
}

export function wrapDisplayText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (word.length > maxWidth) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let offset = 0; offset < word.length; offset += maxWidth) {
        lines.push(word.slice(offset, offset + maxWidth));
      }
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxWidth) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Render a progress bar of filled/empty blocks.
 */
export function bar(percentRemaining: number, width: number): string {
  const p = clampInt(percentRemaining, 0, 100);
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/** A dollar amount with two decimals ("$12.50"); "$0.00" for a non-finite number. */
export function fmtUsdAmount(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function pad2(n: number): string {
  return String(Math.trunc(n)).padStart(2, "0");
}

export function formatLocalCallTimestamp(atMs?: number): string {
  const safeMs = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : Date.now();
  const d = new Date(safeMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function abbreviateDisplayedModelName(name: string): string {
  return name.replace(/antigravity/gi, "agy");
}
