/**
 * Shared formatting primitives: the `/quota` report (quota-command-format.ts, quota-columns.ts),
 * provider percentages and amounts, and the resetTimeDecimals setting check.
 */

import type { PercentDisplayMode, PercentLabelStyle } from "./types.js";

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
 * Pad string to width, truncating if too long, adding spaces on right if too short.
 */
export function padRight(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
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

/**
 * Resolve the displayed percent for toast/sidebar percent rows without
 * changing the underlying provider-normalized percentRemaining value.
 */
export function resolveDisplayedPercent(
  percentRemaining: number,
  mode: PercentDisplayMode = "remaining",
): number {
  const remaining = Math.max(0, Math.round(percentRemaining));
  const used = Math.max(0, Math.round(100 - percentRemaining));
  return mode === "used" ? used : remaining;
}

export function formatDisplayedPercentLabel(
  percentRemaining: number,
  mode: PercentDisplayMode = "remaining",
  style: PercentLabelStyle = "full",
): string {
  const displayedPercent = resolveDisplayedPercent(percentRemaining, mode);
  const percent = `${displayedPercent}%`;
  return style === "bare" ? percent : `${percent} ${mode === "used" ? "used" : "left"}`;
}

export function formatQuotaModeHeading(mode: PercentDisplayMode = "remaining"): string {
  return `Quota [${mode === "used" ? "Used" : "Remaining"}]`;
}

/**
 * Format a token count with K/M suffix for compactness.
 *
 * Examples:
 * - 500 -> "500"
 * - 1500 -> "1.5K"
 * - 15000 -> "15K"
 * - 1500000 -> "1.5M"
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 10_000) {
    return `${(count / 1_000).toFixed(0)}K`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
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

export interface FormatResetCountdownOptions {
  /** Join exact compound countdown units with spaces. */
  spaced?: boolean;
}

/**
 * Format a reset countdown for the `/quota` report.
 *
 * Returns a precise-to-minute value like "2d 5h 14m", "3h 45m", or "14m"; "" without a time.
 * When reset time is in the past or invalid, returns "reset".
 */
export function formatResetCountdown(iso?: string, opts?: FormatResetCountdownOptions): string {
  if (!iso) return "";
  const resetDate = new Date(iso);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "reset";

  // Round up partial minutes so the countdown never understates the time left.
  const diffMinutes = Math.ceil(diffMs / 60_000);
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;

  const separator = opts?.spaced ? " " : "";
  if (days > 0) return [`${days}d`, `${hours}h`, `${minutes}m`].join(separator);
  if (hours > 0) return [`${hours}h`, `${minutes}m`].join(separator);
  return `${minutes}m`;
}

export const MAX_RESET_TIME_DECIMALS = 4;

export function isResetTimeDecimals(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_RESET_TIME_DECIMALS
  );
}
