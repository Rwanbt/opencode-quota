import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { asRecord } from "./json-guards.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  type OpenCodeConsoleCredential,
} from "./opencode-console-auth.js";

const CONSOLE_TIMEOUT_MS = 10_000;
const SESSION_ERROR =
  "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.";

/**
 * The OpenCode Console reports amounts in micro-cents:
 * one US dollar is 100,000,000 micro-cents (billing units).
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

/**
 * Where the monthly limit and usage come from: the org budget (budgets/org), or the
 * credit limit (billing/account) plus this month's usage costs (usage/cost-by-day).
 */
type OpenCodeZenBudgetSource = "org_budget" | "credit_limit";

interface OpenCodeZenBillingData {
  balance: number;
  /** Monthly limit in USD from `budgetSource`; null when there is no limit or its route failed. */
  monthlyLimit: number | null;
  /** Current-month usage in billing units from `budgetSource`; null when its route failed. */
  monthlyUsage: number | null;
  lastPayment: number | null;
  /** Auto-reload state; null (unknown) when billing/auto-recharge failed. */
  reload: boolean | null;
  reloadAmount: number | null;
  reloadTrigger: number | null;
  /** Org-budget reset ISO timestamp; only set when budgets/org supplies the monthly budget. */
  budgetResetIso: string | null;
  budgetSource: OpenCodeZenBudgetSource;
}

/**
 * billing/status (balance) is required. The other routes are optional: when one fails,
 * its fields are null and its error is listed in `errors`.
 */
type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData; errors: string[] }
  | { success: false; error: string };

type ConsoleRoute =
  | "billing/status"
  | "billing/account"
  | "billing/auto-recharge"
  | "budgets/org"
  | "usage/cost-by-day";

type ConsoleRouteResult<T> = { success: true; data: T } | { success: false; error: string };

/** Console micro-cent amounts arrive as decimal strings; numbers are accepted too. */
function parseMicroCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function invalidResponse(): never {
  throw new Error("Unexpected OpenCode Console response");
}

function parseDollars(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return invalidResponse();
}

/** A nullable micro-cent field: null stays null; a missing or malformed value is invalid. */
function parseNullableMicroCents(value: unknown): number | null {
  if (value === null) return null;
  const parsed = parseMicroCents(value);
  return parsed === null ? invalidResponse() : parsed;
}

function parseBalance(json: unknown): number {
  const balance = parseMicroCents(asRecord(json)?.balanceMicroCents);
  return balance === null ? invalidResponse() : Math.max(0, balance);
}

/** Returns the credit limit in USD, or null when the account has no limit. */
function parseCreditLimit(json: unknown): number | null {
  const limit = parseNullableMicroCents(asRecord(json)?.creditLimitMicroCents);
  return limit === null ? null : limit / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
}

function parseAutoRecharge(
  json: unknown,
): Pick<OpenCodeZenBillingData, "reload" | "reloadAmount" | "reloadTrigger"> {
  const autoRecharge = asRecord(json);
  if (!autoRecharge || typeof autoRecharge.enabled !== "boolean") return invalidResponse();

  return {
    reload: autoRecharge.enabled,
    reloadAmount: parseDollars(autoRecharge.rechargeAmountDollars),
    reloadTrigger: parseDollars(autoRecharge.thresholdDollars),
  };
}

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Sums the current UTC month's daily costs in micro-cents; an empty list means no usage. */
function parseMonthlyUsage(json: unknown, now: Date): number {
  if (!Array.isArray(json)) return invalidResponse();

  const month = currentUtcMonth(now);
  let total = 0;
  for (const item of json) {
    const day = asRecord(item);
    const cost = parseMicroCents(day?.totalCostMicroCents);
    if (typeof day?.date !== "string" || cost === null) return invalidResponse();
    if (day.date.slice(0, 7) === month) total += cost;
  }
  return Number.isFinite(total) ? total : invalidResponse();
}

/**
 * Parses the org budget; null when the org has no usable budget. The org has no
 * budget configured when the Console returns `null`, an empty body, `{}`, or a null
 * limit; without a positive limit and non-negative spend, Zen falls back to the
 * credit limit.
 */
function parseOrgBudget(
  json: unknown,
): { limitMicroCents: number; spentMicroCents: number; resetsAt: string | null } | null {
  if (json === null) return null;
  const budget = asRecord(json);
  if (!budget) return invalidResponse();
  if (Object.keys(budget).length === 0) return null;

  const { resetsAt } = budget;
  if (resetsAt !== null && resetsAt !== undefined && typeof resetsAt !== "string") {
    return invalidResponse();
  }
  const limit = parseNullableMicroCents(budget.limitMicroCents);
  const spent = parseNullableMicroCents(budget.spentMicroCents);
  if (limit === null || limit <= 0 || spent === null || spent < 0) return null;
  return {
    limitMicroCents: limit,
    spentMicroCents: spent,
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}

/** Single-line error text with the token and org id redacted. */
function redactedErrorText(error: unknown, credential: OpenCodeConsoleCredential): string {
  let text = sanitizeDisplayText(error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  for (const secret of [credential.accessToken, credential.orgId]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return (text || "unknown").slice(0, 120);
}

async function fetchConsoleRoute<T>(params: {
  route: ConsoleRoute;
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
  parse: (json: unknown) => T;
}): Promise<ConsoleRouteResult<T>> {
  try {
    return await fetchWithTimeout(`${consoleBaseUrl(params.credential)}/api/${params.route}`, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: consoleHeaders(params.credential),
      },
      timeoutMs: params.timeoutMs,
      consume: async (response): Promise<ConsoleRouteResult<T>> => {
        // Redirects and 401 mean the whole session is gone; a 403 is treated as
        // a per-route failure so optional routes can fall back gracefully.
        if ((response.status >= 300 && response.status < 400) || response.status === 401) {
          return { success: false, error: SESSION_ERROR };
        }
        if (!response.ok) {
          return {
            success: false,
            error: `OpenCode Console ${params.route} error ${response.status}`,
          };
        }
        if (response.headers.get("content-type")?.includes("text/html")) {
          return { success: false, error: SESSION_ERROR };
        }

        const text = await response.text();
        try {
          // An empty body carries no value, so the route parser sees it as JSON null.
          const json: unknown = text.trim() === "" ? null : JSON.parse(text);
          return { success: true, data: params.parse(json) };
        } catch {
          return {
            success: false,
            error: `Could not parse OpenCode Console ${params.route} response`,
          };
        }
      },
    });
  } catch (error) {
    return {
      success: false,
      error: `OpenCode Console ${params.route} request failed: ${redactedErrorText(error, params.credential)}`,
    };
  }
}

export async function queryOpenCodeZenQuota(
  credential: OpenCodeConsoleCredential,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  const request = {
    credential,
    timeoutMs: options.requestTimeoutMs ?? CONSOLE_TIMEOUT_MS,
  };
  const now = new Date();
  const [balance, creditLimit, autoRecharge, orgBudget, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    fetchConsoleRoute({ ...request, route: "budgets/org", parse: parseOrgBudget }),
    fetchConsoleRoute({
      ...request,
      route: "usage/cost-by-day",
      parse: (json) => parseMonthlyUsage(json, now),
    }),
  ]);

  const optional = [creditLimit, autoRecharge, orgBudget, monthlyUsage];
  if ([balance, ...optional].some((result) => !result.success && result.error === SESSION_ERROR)) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!balance.success) return balance;

  // Prefer the org budget; otherwise fall back to the credit limit plus this month's usage costs.
  let monthlyLimit = creditLimit.success ? creditLimit.data : null;
  let usage = monthlyUsage.success ? monthlyUsage.data : null;
  let budgetResetIso: string | null = null;
  let budgetSource: OpenCodeZenBudgetSource = "credit_limit";
  const budget = orgBudget.success ? orgBudget.data : null;
  if (budget) {
    monthlyLimit = budget.limitMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    usage = budget.spentMicroCents;
    budgetSource = "org_budget";
    // Normalize to canonical ISO so downstream result validation never sees a
    // parseable-but-non-ISO reset (e.g. "0") and drops the whole result.
    const resetTimeMs = budget.resetsAt === null ? Number.NaN : Date.parse(budget.resetsAt);
    budgetResetIso = Number.isFinite(resetTimeMs) ? new Date(resetTimeMs).toISOString() : null;
  }

  return {
    success: true,
    data: {
      balance: balance.data,
      monthlyLimit,
      monthlyUsage: usage,
      lastPayment: null,
      ...(autoRecharge.success
        ? autoRecharge.data
        : { reload: null, reloadAmount: null, reloadTrigger: null }),
      budgetResetIso,
      budgetSource,
    },
    errors: optional.flatMap((result) => (result.success ? [] : [result.error])),
  };
}
