import type { AccountingCountUnit, AccountingQuantity } from "./entries.js";

/**
 * Accounting amounts travel as canonical decimal strings: digits with an optional fraction and
 * sign, no leading zeros, no exponent, and never a negative zero.
 */
const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export const COUNT_LABELS: Readonly<
  Record<AccountingCountUnit, [singular: string, plural: string]>
> = {
  request: ["request", "requests"],
  token: ["token", "tokens"],
  credit: ["credit", "credits"],
  message: ["message", "messages"],
  interaction: ["interaction", "interactions"],
  unit: ["unit", "units"],
};

export function isCanonicalAccountingDecimal(value: string): boolean {
  if (!CANONICAL_DECIMAL_RE.test(value)) return false;
  if (!value.startsWith("-")) return true;
  return !/^0(?:\.0+)?$/u.test(value.slice(1));
}

function splitDecimal(decimal: string): {
  negative: boolean;
  integer: string;
  fraction: string;
} {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [integer = "0", fraction = ""] = unsigned.split(".", 2);
  return { negative, integer, fraction };
}

function groupInteger(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function isBelowOneCent(integer: string, fraction: string): boolean {
  return (
    integer === "0" &&
    fraction.length > 0 &&
    !/^0+$/u.test(fraction) &&
    fraction.padEnd(2, "0").slice(0, 2) === "00"
  );
}

/** Two decimals, rounded half up; "<0.01" for a positive amount below one cent. */
function formatCurrencyAmount(decimal: string): string {
  const { negative, integer, fraction } = splitDecimal(decimal);
  if (isBelowOneCent(integer, fraction)) {
    if (!negative) return "<0.01";
    return `-${integer}.${fraction}`;
  }

  const padded = `${fraction}000`;
  let cents = Number(padded.slice(0, 2));
  let roundedInteger = integer;
  if (Number(padded[2]) >= 5) cents += 1;
  if (cents === 100) {
    roundedInteger = (BigInt(integer) + 1n).toString();
    cents = 0;
  }
  return `${negative ? "-" : ""}${groupInteger(roundedInteger)}.${String(cents).padStart(2, "0")}`;
}

function formatExactAmount(decimal: string): string {
  const { negative, integer, fraction } = splitDecimal(decimal);
  return `${negative ? "-" : ""}${groupInteger(integer)}${fraction ? `.${fraction}` : ""}`;
}

/** A provider quantity as the export file writes it: "USD 10.00", "1,500 tokens", "3 pts". */
export function formatAccountingQuantity(quantity: AccountingQuantity): string {
  if (!isCanonicalAccountingDecimal(quantity.decimal)) {
    throw new TypeError("Accounting quantity decimal must be canonical");
  }

  if (quantity.unit.kind === "currency") {
    return `${quantity.unit.code} ${formatCurrencyAmount(quantity.decimal)}`;
  }

  const amount = formatExactAmount(quantity.decimal);
  if (quantity.unit.kind === "custom") return `${amount} ${quantity.unit.symbol}`;

  const labels = COUNT_LABELS[quantity.unit.unit];
  const singular = /^1(?:\.0+)?$/u.test(quantity.decimal);
  return `${amount} ${singular ? labels[0] : labels[1]}`;
}
