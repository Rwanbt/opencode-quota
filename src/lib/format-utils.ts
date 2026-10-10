/**
 * Small text helpers for the reports and the providers: percents, amounts, times and model
 * names.
 */

/**
 * Clamp a value to a percentage [0..100], rounding to the nearest integer.
 * Returns 0 for non-finite inputs.
 */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
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
