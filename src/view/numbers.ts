/**
 * Number formats for usage: money, token counts and shares, written the way T3 Code's usage
 * page writes them. Always US English, so the text is the same on every machine.
 */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  minimumSignificantDigits: 3,
  maximumSignificantDigits: 3,
});

/** "$1,234.56", "$0.00", and "<$0.01" for an amount above 0 that would show as $0.00. */
export function formatUsd(usd: number): string {
  const text = USD.format(usd);
  return usd > 0 && text === "$0.00" ? "<$0.01" : text;
}

/** Whole below 1,000, then always three significant digits: "950", "12.3K", "8.00M", "13.4B". */
export function formatTokens(count: number): string {
  const whole = Math.round(count);
  return whole < 1000 ? String(whole) : COMPACT.format(whole);
}

/** A 0..1 share with one decimal: "92.5%", "5.0%", "100.0%"; "<0.1%" above 0; "0%" for 0. */
export function formatShare(share: number): string {
  if (share === 0) return "0%";
  const text = (share * 100).toFixed(1);
  return share > 0 && text === "0.0" ? "<0.1%" : `${text}%`;
}
