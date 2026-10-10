/**
 * Temporary shim (until the adapters emit rows, S14-S19): turns today's provider result into
 * v6 rows with stable ids. Each provider has a key rule that reads the legacy name, label and
 * semantic of an entry and returns the row key from the plan's key table; the account comes
 * from the entry's group. Value mapping follows ADR 0001: rate_limit is a quota, spend is
 * usage, local runtime accounting is a local estimation.
 */

import type {
  AccountingAcquisitionMethod,
  AccountingQuantity,
  AccountingResultType,
  QuotaProviderDiagnostic,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { customRowKey } from "../lib/quota-providers.js";
import { classifyError } from "./errors.js";
import { publicDebugValue, publicDetail } from "./redact.js";
import type { ProviderFetch } from "./store.js";
import type {
  Amount,
  AmountUnit,
  DebugDetail,
  QuotaRow,
  QuotaWindow,
  RowMethod,
  RowType,
} from "./types.js";
import { validateRows } from "./validate.js";
import { classifyWindow } from "./windows.js";

const DEBUG_VALUE_MAX_LENGTH = 300;

/** What a key rule returns: the row key, its default label and its window. */
type RowKey = { key: string; label?: string; window?: QuotaWindow };
type KeyRule = (entry: QuotaToastEntry) => RowKey | undefined;

/** Lower-case, underscores for anything else, for keys built from provider text. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

/** The legacy row label without its trailing colon, for example "5h:" → "5h". */
function legacyLabel(entry: QuotaToastEntry): string {
  return (entry.label ?? "").replace(/:+$/u, "").trim();
}

function namedMetric(entry: QuotaToastEntry): string | undefined {
  return entry.semantic?.metric.kind === "named" ? entry.semantic.metric.name : undefined;
}

function componentMetric(entry: QuotaToastEntry): string | undefined {
  return entry.semantic?.metric.kind === "component" ? entry.semantic.metric.component : undefined;
}

const FIVE_HOUR: RowKey = { key: "five_hour", label: "5h", window: "five_hour" };
const WEEKLY: RowKey = { key: "weekly", label: "Weekly", window: "week" };
const MONTHLY: RowKey = { key: "monthly", label: "Monthly", window: "month" };
const DAILY: RowKey = { key: "daily", label: "Daily", window: "day" };

/** Keys for the common legacy window labels; each provider allows only its own. */
const WINDOW_LABEL_KEYS: Readonly<Record<string, RowKey>> = {
  "5h": FIVE_HOUR,
  weekly: WEEKLY,
  monthly: MONTHLY,
  daily: DAILY,
  session: { key: "session", label: "Session", window: "session" },
  mcp: { key: "mcp", label: "MCP", window: "mcp" },
  "code review": { key: "code_review", label: "Code review", window: "code_review" },
};

/** A rule for providers whose rows are named by window label ("5h:", "Weekly:", ...). */
function byWindowLabel(...allowed: string[]): KeyRule {
  return (entry) => {
    const rowKey = WINDOW_LABEL_KEYS[legacyLabel(entry).toLowerCase()];
    return rowKey && allowed.includes(rowKey.key) ? rowKey : undefined;
  };
}

/** A rule for providers whose rows have fixed legacy names. */
function byName(names: Readonly<Record<string, RowKey>>): KeyRule {
  return (entry) => names[entry.name];
}

const anthropicKey: KeyRule = (entry) => {
  if (entry.name.endsWith("Usage Credits")) {
    return { key: "extra_usage", label: "Extra usage", window: "month" };
  }
  if (namedMetric(entry) === "Fable weekly" || legacyLabel(entry) === "Fable") {
    return { key: "weekly_fable", label: "Fable", window: "week" };
  }
  return byWindowLabel("five_hour", "weekly")(entry);
};

const COPILOT_ALLOWANCE_LABELS: Readonly<Record<string, string>> = {
  "Copilot AI Credits": "Credits",
  "Copilot Premium Interactions": "Premium interactions",
  "Copilot Premium Requests": "Premium requests",
};

const copilotKey: KeyRule = (entry) => {
  if (entry.name === "Copilot Additional Usage") {
    return { key: "additional_budget", label: "Budget", window: "month" };
  }
  // Without a billing token Copilot shows only the plan; it stands in for the allowance.
  if (entry.name === "Copilot") return { key: "allowance", label: "Plan" };
  const label = COPILOT_ALLOWANCE_LABELS[entry.name];
  return label ? { key: "allowance", label, window: "month" } : undefined;
};

const openaiKey: KeyRule = (entry) => {
  // "ChatGPT quota unavailable for API key": an account that has no ChatGPT plan to show.
  if (entry.accounting.resultType === "status") return { key: "status", label: "Status" };
  return byWindowLabel("five_hour", "weekly", "monthly", "code_review")(entry);
};

const openrouterKey: KeyRule = (entry) => ({ key: "key", label: legacyLabel(entry) || "Key" });

const cursorKey: KeyRule = (entry) => {
  const metric = namedMetric(entry);
  if (metric === "Auto+Composer") {
    return { key: "auto_composer", label: "Auto+Composer", window: "month" };
  }
  if (metric === "API" || metric === "Known API") {
    return { key: "api", label: metric, window: "month" };
  }
  return undefined;
};

const geminiTierKeys: Readonly<Record<string, string>> = {
  "Gemini Pro": "pro",
  "Gemini Flash": "flash",
  "Gemini Flash Lite": "flash_lite",
};

const geminiCliKey: KeyRule = (entry) => {
  const model = legacyLabel(entry);
  if (!model) return undefined;
  const tier = geminiTierKeys[model];
  const short = model.replace(/^Gemini\s+/u, "") || model;
  return tier ? { key: tier, label: short } : { key: `model.${slug(short)}`, label: short };
};

const AGY_FAMILY_KEYS: Readonly<Record<string, string>> = {
  Gemini: "gemini",
  "Claude/GPT": "claude_gpt",
};

/** The family label: after "): " in the one-login group, between group and window otherwise. */
function agyFamily(entry: QuotaToastEntry): string | undefined {
  const group = entry.group ?? "";
  const companion = /^AGY \(.*\): (.+)$/u.exec(group);
  if (companion) return companion[1];
  const windowLabel = legacyLabel(entry);
  if (!group || !entry.name.startsWith(`${group} `) || !entry.name.endsWith(` ${windowLabel}`)) {
    return undefined;
  }
  return entry.name.slice(group.length + 1, entry.name.length - windowLabel.length - 1).trim();
}

const googleAgyKey: KeyRule = (entry) => {
  const family = agyFamily(entry);
  const window = byWindowLabel("five_hour", "weekly")(entry);
  if (!family || !window) return undefined;
  const familyKey = AGY_FAMILY_KEYS[family] ?? slug(family);
  if (!familyKey) return undefined;
  return {
    key: `${familyKey}.${window.key}`,
    label: `${family} ${window.label}`,
    window: window.window,
  };
};

const nanogptKey: KeyRule = (entry) => {
  if (entry.name === "nanogpt-day-quota") return DAILY;
  if (entry.name === "nanogpt-month-quota") return MONTHLY;
  if (entry.name === "nanogpt-current-balance" && entry.kind === "quantity") {
    const unit = entry.quantity.unit;
    return unit.kind === "currency"
      ? { key: `balance.${slug(unit.code)}`, label: "Balance" }
      : { key: "balance.nano", label: "Balance" };
  }
  return undefined;
};

/** Kimi names its windows; the weekly one keeps the key `weekly`, others become `limit.*`. */
const kimiKey: KeyRule = (entry) => {
  const name = legacyLabel(entry);
  if (!name) return undefined;
  const window = classifyWindow(name);
  if (window === "week") return { key: "weekly", label: name, window };
  const limit = slug(name.replace(/\s+limit$/iu, "")) || slug(name);
  return limit ? { key: `limit.${limit}`, label: name, ...(window ? { window } : {}) } : undefined;
};

const DEEPSEEK_BALANCE_LABELS: Readonly<Record<string, string>> = {
  total_balance: "Balance",
  granted_balance: "Granted",
  topped_up_balance: "Topped up",
};

const deepseekKey: KeyRule = (entry) => {
  if (entry.name === "deepseek-availability") return { key: "available", label: "Available" };
  const component = componentMetric(entry);
  const label = component ? DEEPSEEK_BALANCE_LABELS[component] : undefined;
  if (!component || !label || entry.kind !== "quantity") return undefined;
  const unit = entry.quantity.unit;
  const currency = unit.kind === "currency" ? unit.code : undefined;
  return currency ? { key: `${component}.${slug(currency)}`, label } : undefined;
};

const xaiKey: KeyRule = (entry) => {
  const period = legacyLabel(entry);
  if (!period) return undefined;
  const window = classifyWindow(period);
  return { key: "credits", label: period, ...(window ? { window } : {}) };
};

const xiaomiKey: KeyRule = (entry) => {
  if (entry.semantic?.metric.kind === "window" && entry.semantic.metric.window === "month") {
    return { key: "monthly_tokens", label: "Monthly", window: "month" };
  }
  return byName({
    "xiaomi-mimo-total_balance": { key: "total_balance", label: "Balance" },
    "xiaomi-mimo-cash_balance": { key: "cash_balance", label: "Cash" },
    "xiaomi-mimo-gift_balance": { key: "gift_balance", label: "Gift" },
  })(entry);
};

/**
 * Custom sources: `custom.<definition id>.<window id or mapping name>`; the source label is the
 * account. The adapters bring the key (`rowKey`: a local window's id, a json-v1 mapping's
 * name), so renaming a window keeps it and two windows with one label stay apart; quota-v1
 * entries are keyed by their name the same way.
 */
const customKey: KeyRule = (entry) => {
  const definitionId = entry.accounting.sourceId ?? "";
  const group = entry.group ?? "";
  const rest =
    group && entry.name.startsWith(`${group} `) ? entry.name.slice(group.length + 1) : "";
  const part = entry.rowKey ?? (rest ? customRowKey(rest) : "");
  if (!definitionId || !part) return undefined;
  const label = legacyLabel(entry) || rest;
  const window = classifyWindow(rest);
  return { key: `custom.${definitionId}.${part}`, label, ...(window ? { window } : {}) };
};

/** The key rule of every provider, by provider id. */
const KEY_RULES: Readonly<Record<string, KeyRule>> = {
  anthropic: anthropicKey,
  copilot: copilotKey,
  openai: openaiKey,
  openrouter: openrouterKey,
  kilo: byName({
    "kilo-gateway-credits": { key: "pass_credits", label: "Pass credits" },
    "kilo-gateway-remaining-credits": { key: "pass_credits", label: "Pass credits" },
    "kilo-gateway-total-balance": { key: "balance", label: "Balance" },
  }),
  cursor: cursorKey,
  "alibaba-coding-plan": byWindowLabel("five_hour", "weekly", "monthly"),
  "alibaba-token-plan": byWindowLabel("five_hour", "weekly"),
  synthetic: byWindowLabel("five_hour", "weekly"),
  chutes: byName({ Chutes: DAILY }),
  "google-gemini-cli": geminiCliKey,
  "google-agy": googleAgyKey,
  zai: byWindowLabel("five_hour", "weekly", "mcp"),
  zhipu: byWindowLabel("five_hour", "weekly", "mcp"),
  nanogpt: nanogptKey,
  "minimax-coding-plan": byName({
    "minimax-token-plan-5h": FIVE_HOUR,
    "minimax-token-plan-week": WEEKLY,
  }),
  "minimax-china-coding-plan": byName({
    "minimax-token-plan-5h": FIVE_HOUR,
    "minimax-token-plan-week": WEEKLY,
  }),
  "kimi-code-plan-global": kimiKey,
  "kimi-code-plan-cn": kimiKey,
  deepseek: deepseekKey,
  xai: xaiKey,
  xiaomi: xiaomiKey,
  "opencode-go": byWindowLabel("five_hour", "weekly", "monthly"),
  opencode: byName({
    "zen-monthly-budget": MONTHLY,
    "zen-monthly-spend": MONTHLY,
    "zen-current-balance": { key: "balance", label: "Balance" },
    "zen-auto-reload": { key: "auto_reload", label: "Auto reload" },
  }),
  "ollama-cloud": byWindowLabel("session", "weekly", "monthly"),
  "quota-providers": customKey,
};

/** Brand words at the start of a provider's groups; what follows names the account or plan. */
const GROUP_BRANDS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["Claude"],
  copilot: ["Copilot"],
  openai: ["OpenAI"],
  openrouter: ["OpenRouter"],
  kilo: ["Kilo Gateway"],
  cursor: ["Cursor"],
  "alibaba-coding-plan": ["Alibaba Coding Plan"],
  "alibaba-token-plan": ["Alibaba Personal Token Plan"],
  synthetic: ["Synthetic"],
  chutes: ["Chutes"],
  "google-gemini-cli": ["Gemini CLI"],
  "google-agy": ["Google AGY", "AGY"],
  zai: ["Z.ai"],
  zhipu: ["Zhipu"],
  nanogpt: ["NanoGPT"],
  "minimax-coding-plan": ["MiniMax Token Plan"],
  "minimax-china-coding-plan": ["MiniMax Token Plan (CN)", "MiniMax Token Plan"],
  "kimi-code-plan-global": ["Kimi Code"],
  "kimi-code-plan-cn": ["Kimi Code (CN)", "Kimi Code"],
  deepseek: ["DeepSeek"],
  xai: ["xAI"],
  xiaomi: ["Xiaomi MiMo"],
  "opencode-go": ["OpenCode Go"],
  opencode: ["OpenCode Zen"],
  "ollama-cloud": ["Ollama Cloud"],
};

/** "(Pro)" → "Pro", ": Standard [code]" → "Standard". */
function unwrap(text: string): string {
  let result = text.trim().replace(/^:\s*/u, "");
  const parens = /^\((.*)\)$/u.exec(result);
  if (parens) result = parens[1] ?? "";
  const withoutCode = result.replace(/\s*\[[^\]]*\]$/u, "").trim();
  return withoutCode || result.trim();
}

function stripBrand(providerId: string, text: string): string {
  const brand = (GROUP_BRANDS[providerId] ?? []).find(
    (name) => text === name || text.startsWith(`${name} `) || text.startsWith(`${name}:`),
  );
  return brand ? text.slice(brand.length) : text;
}

/**
 * The account or plan in a legacy group: "OpenAI (Pro)" → "Pro", "[Claude Work] (active)" →
 * "Work", "[OpenAI Work] (Business)" → "Work (Business)". "(active)" is dropped: it moves
 * when the user switches logins, and the account must stay the same.
 */
export function accountFromGroup(
  providerId: string,
  group: string | undefined,
): string | undefined {
  if (!group) return undefined;
  let text = group.replace(/\s*\(active\)/gu, "").trim();
  if (providerId === "quota-providers") return text || undefined;
  if (providerId === "anthropic") text = text.replace(/\s*Usage Credits$/u, "");
  if (providerId === "google-agy") text = text.replace(/:\s[^:]*$/u, "");
  const bracket = /^\[([^\]]*)\]\s*(.*)$/u.exec(text);
  const alias = unwrap(stripBrand(providerId, bracket ? (bracket[1] ?? "") : text));
  const category = bracket ? (bracket[2] ?? "").trim() : "";
  const account = alias && category ? `${alias} ${category}` : alias || unwrap(category);
  return account || undefined;
}

/** ADR 0001: rate_limit is a quota and spend is usage. */
function rowType(resultType: AccountingResultType): RowType {
  if (resultType === "rate_limit") return "quota";
  if (resultType === "spend") return "usage";
  return resultType;
}

/** ADR 0001: OpenCode's own history counted locally is a local estimation. */
function rowMethod(method: AccountingAcquisitionMethod): RowMethod {
  return method === "local_runtime_accounting" ? "local_estimation" : method;
}

function toAmount(quantity: AccountingQuantity): Amount {
  return { decimal: quantity.decimal, unit: { ...quantity.unit } };
}

/** "1,200.50" → "1200.5"; undefined when it is not a plain number. */
function canonicalDecimal(text: string): string | undefined {
  const plain = text.replace(/,/gu, "");
  if (!/^\d+(?:\.\d+)?$/u.test(plain)) return undefined;
  const [integer = "0", fraction = ""] = plain.split(".");
  const whole = integer.replace(/^0+(?=\d)/u, "");
  const decimals = fraction.replace(/0+$/u, "");
  return decimals ? `${whole}.${decimals}` : whole;
}

const REQUESTS: AmountUnit = { kind: "count", unit: "request" };
const USD: AmountUnit = { kind: "currency", code: "USD" };

const COPILOT_PAIR_UNITS: Readonly<Record<string, AmountUnit>> = {
  "Copilot AI Credits": { kind: "count", unit: "credit" },
  "Copilot Premium Interactions": { kind: "count", unit: "interaction" },
  "Copilot Premium Requests": REQUESTS,
  "Copilot Additional Usage": USD,
};

/**
 * The unit of a compact "used/limit" summary, only for rows whose adapter is known to write
 * used before limit. Others give no amounts: custom remote mappings may write
 * "remaining/limit", and Kimi and Synthetic don't name the unit or round the numbers.
 */
function pairUnit(providerId: string, entry: QuotaToastEntry): AmountUnit | undefined {
  if (providerId === "alibaba-coding-plan") return REQUESTS;
  if (providerId === "copilot") return COPILOT_PAIR_UNITS[entry.name];
  if (
    providerId === "quota-providers" &&
    entry.accounting.acquisitionMethod === "local_estimation"
  ) {
    return entry.accounting.resultType === "budget" ? USD : REQUESTS;
  }
  return undefined;
}

/** Used and limit from a compact "26/100" or "$2.00/$10.00" in `unit`; nothing when unclear. */
function usedAndLimitFromRight(
  right: string | undefined,
  unit: AmountUnit | undefined,
): { used?: Amount; limit?: Amount } {
  const match = /^(\$?)([\d,]+(?:\.\d+)?)\/(\$?)([\d,]+(?:\.\d+)?)$/u.exec(right?.trim() ?? "");
  if (!unit || !match || match[1] !== match[3]) return {};
  if ((match[1] === "$") !== (unit.kind === "currency")) return {};
  const used = canonicalDecimal(match[2] ?? "");
  const limit = canonicalDecimal(match[4] ?? "");
  if (used === undefined || limit === undefined) return {};
  return { used: { decimal: used, unit }, limit: { decimal: limit, unit } };
}

function valueFields(providerId: string, entry: QuotaToastEntry): Record<string, unknown> {
  switch (entry.kind) {
    case "value":
      return { text: entry.value };
    case "quantity":
      return { amount: toAmount(entry.quantity) };
    case "boolean":
      return { flag: entry.value };
    default: {
      const basis = entry.basis;
      const amounts = basis
        ? {
            ...(basis.used ? { used: toAmount(basis.used.quantity) } : {}),
            ...(basis.limit ? { limit: toAmount(basis.limit.quantity) } : {}),
            ...(basis.remaining ? { remaining: toAmount(basis.remaining.quantity) } : {}),
          }
        : usedAndLimitFromRight(entry.right, pairUnit(providerId, entry));
      return {
        percentRemaining: entry.percentRemaining,
        ...amounts,
        ...(entry.fixedWindow ? { windowStartedAt: entry.fixedWindow.startedAtIso } : {}),
      };
    }
  }
}

/** The candidate row for one entry (checked later by `validateRows`), or why it has none. */
function candidateRow(
  providerId: string,
  entry: QuotaToastEntry,
): Record<string, unknown> | string {
  const rule = KEY_RULES[providerId];
  if (!rule) return "unknown provider";
  const rowKey = rule(entry);
  if (!rowKey) return "no row key";
  const account = accountFromGroup(providerId, entry.group);
  const window = rowKey.window ?? classifyWindow(legacyLabel(entry));
  return {
    id: `${providerId}.${rowKey.key}`,
    providerId,
    ...(account ? { account } : {}),
    label: rowKey.label || legacyLabel(entry) || entry.name,
    type: rowType(entry.accounting.resultType),
    method: rowMethod(entry.accounting.acquisitionMethod),
    authority: entry.accounting.authority,
    ...(window ? { window } : {}),
    prominence: entry.semantic?.prominence ?? "primary",
    ...valueFields(providerId, entry),
    ...(entry.resetTimeIso ? { resetsAt: entry.resetTimeIso } : {}),
  };
}

/** A candidate row and the login it came from ("" when the provider has one login). */
type Candidate = { row: Record<string, unknown>; login: string };

/**
 * Drops a row repeated for one login (same id and account). Logins that share an account text
 * keep it here; the store tells them apart, as it also sees logins that failed this time.
 */
function dropRepeatedRows(candidates: readonly Candidate[], debug: DebugDetail[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter(({ row, login }) => {
    const slot = `${String(row.id)}\u001f${String(row.account ?? "")}\u001f${login}`;
    if (!seen.has(slot)) {
      seen.add(slot);
      return true;
    }
    debug.push({ key: "dropped_row", value: `${String(row.id)}: repeated row` });
    return false;
  });
}

/**
 * Debug details are kept for /quota_status, as a public issue may show them (see
 * `publicDetail`): hidden before they are cut, so a cut never leaves part of a hidden value.
 */
function detail(key: string, value: string): DebugDetail {
  return {
    key: publicDetail(key, 64),
    value: publicDebugValue(key, value, DEBUG_VALUE_MAX_LENGTH),
  };
}

/** One custom definition's check, never its URL or key: outcome, login source, files read. */
function customCheckDetail(diagnostic: QuotaProviderDiagnostic): DebugDetail {
  const parts = [`outcome=${diagnostic.outcome}`];
  if (diagnostic.httpStatus !== undefined) parts.push(`http_status=${diagnostic.httpStatus}`);
  if (diagnostic.mode === "remote-api") {
    const paths = new Set([...diagnostic.checkedPaths, ...diagnostic.credentialDatabasePaths]);
    parts.push(
      `credential_source=${diagnostic.credentialSource ?? "(none)"}`,
      `checked_paths=${[...paths].join(" | ") || "(none)"}`,
    );
  } else {
    const lastUpdate = diagnostic.stateLastUpdatedAt;
    parts.push(
      `state_health=${diagnostic.stateHealth ?? "missing"}`,
      `state_version=${diagnostic.stateVersion ?? "(none)"}`,
      `state_last_update=${lastUpdate ? new Date(lastUpdate).toISOString() : "(none)"}`,
    );
  }
  return detail(`custom_${diagnostic.sourceId}_check`, parts.join(" "));
}

/**
 * Today's provider result as v6 rows, the error to show, and the debug details. `rowLogins`
 * holds source ids here; the provider source keys them before the store gets them.
 */
export function rowsFromLegacyResult(
  providerId: string,
  result: QuotaProviderResult,
  nowMs: number = Date.now(),
): ProviderFetch {
  const debug: DebugDetail[] = [
    ...(result.statusDetails ?? []).map((item) => detail(item.key, item.value)),
    ...(result.rawDetails ?? []).map((item) => detail(item.key, item.value)),
    ...(result.diagnostics ?? []).map(customCheckDetail),
  ];
  const candidates: Candidate[] = [];
  result.entries.forEach((entry, index) => {
    try {
      const row = candidateRow(providerId, entry);
      if (typeof row === "string") {
        debug.push(detail("dropped_row", `${entry.name || `row ${index + 1}`}: ${row}`));
      } else {
        candidates.push({ row, login: entry.accounting.sourceId ?? "" });
      }
    } catch {
      debug.push(detail("dropped_row", `row ${index + 1}: unreadable`));
    }
  });
  // Each row is checked on its own, so it keeps its login.
  const rows: QuotaRow[] = [];
  const rowLogins: string[] = [];
  for (const { row, login } of dropRepeatedRows(candidates, debug)) {
    const checked = validateRows(providerId, [row]);
    debug.push(...checked.dropped);
    for (const clean of checked.rows) {
      rows.push(clean);
      rowLogins.push(login);
    }
  }
  const logins = rowLogins.some(Boolean) ? { rowLogins } : {};

  for (const error of result.errors) {
    const key = error.kind === "intentional-filter" ? "note" : "error";
    debug.push(detail(key, `${error.label}: ${error.message}`));
  }
  const firstError = result.errors.find((error) => error.kind !== "intentional-filter");
  if (firstError) {
    return { rows, ...logins, error: classifyError(firstError.message, nowMs), debug };
  }
  if (!result.attempted && rows.length === 0) {
    return { rows: [], error: { code: "not_configured" }, debug };
  }
  return { rows, ...logins, debug };
}
