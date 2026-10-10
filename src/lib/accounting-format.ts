/**
 * Accounting amounts travel as canonical decimal strings: digits with an optional fraction and
 * sign, no leading zeros, no exponent, and never a negative zero.
 */
const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function isCanonicalAccountingDecimal(value: string): boolean {
  if (!CANONICAL_DECIMAL_RE.test(value)) return false;
  if (!value.startsWith("-")) return true;
  return !/^0(?:\.0+)?$/u.test(value.slice(1));
}
