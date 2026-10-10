/**
 * Number formats for usage: money, token counts and shares, written the way T3 Code's usage
 * page writes them. Always US English, so the text is the same on every machine.
 */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 3,
});

/** "$1,234.56", "$0.00", and "<$0.01" for an amount above 0 that would show as $0.00. */
export function formatUsd(usd: number): string {
  const text = USD.format(usd);
  return usd > 0 && text === "$0.00" ? "<$0.01" : text;
}

/** Three significant digits: "950", "12.3K", "8.97M", "146M", "13.4B". */
export function formatTokens(count: number): string {
  return COMPACT.format(count);
}

/** A 0..1 share: "92.5%", "6%", "100%", and "<0.1%" above 0 that would show as 0%. */
export function formatShare(share: number): string {
  const text = (share * 100).toFixed(1);
  if (share > 0 && text === "0.0") return "<0.1%";
  return `${text.replace(/\.0$/, "")}%`;
}
