/**
 * Provider results as v6 rows. Every built-in provider returns the row contract
 * (`ProviderFetchResult`, see `providers/contract.ts`); each row gets its id
 * (`${providerId}.${key}`) and its account's account text. The custom providers still return a
 * legacy result: each entry is keyed `custom.<definition id>.<key>` and its source label is the
 * account. Value mapping follows ADR 0001: rate_limit is a quota and spend is usage.
 */

import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type {
  AccountingResultType,
  QuotaProviderDiagnostic,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import { isRecord } from "../lib/json-guards.js";
import { customRowKey, QUOTA_PROVIDERS_AGGREGATE_ID } from "../lib/quota-providers.js";
import type { AccountResult, ProviderFetchResult } from "../providers/contract.js";
import { classifyError } from "./errors.js";
import { publicDebugValue } from "./redact.js";
import type { ProviderFetch } from "./store.js";
import type { Amount, AmountUnit, DebugDetail, QuotaRow, QuotaWindow, RowType } from "./types.js";
import { validateRows } from "./validate.js";
import { classifyWindow } from "./windows.js";

const DEBUG_VALUE_MAX_LENGTH = 300;

/** The row key of a custom entry, its default label and its window. */
type RowKey = { key: string; label: string; window?: QuotaWindow };

/** The legacy row label without its trailing colon, for example "5h:" → "5h". */
function legacyLabel(entry: QuotaToastEntry): string {
  return (entry.label ?? "").replace(/:+$/u, "").trim();
}

/**
 * Custom sources: `custom.<definition id>.<window id or mapping name>`; the source label is the
 * account. The adapters bring the key (`rowKey`: a local window's id, a json-v1 mapping's
 * name), so renaming a window keeps it and two windows with one label stay apart; quota-v1
 * entries are keyed by their name the same way.
 */
function customKey(entry: QuotaToastEntry): RowKey | undefined {
  const definitionId = entry.accounting.sourceId ?? "";
  const group = entry.group ?? "";
  const rest =
    group && entry.name.startsWith(`${group} `) ? entry.name.slice(group.length + 1) : "";
  const part = entry.rowKey ?? (rest ? customRowKey(rest) : "");
  if (!definitionId || !part) return undefined;
  const label = legacyLabel(entry) || rest;
  const window = classifyWindow(rest) ?? classifyWindow(legacyLabel(entry));
  return { key: `custom.${definitionId}.${part}`, label, ...(window ? { window } : {}) };
}

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
  const text = group.replace(/\s*\(active\)/gu, "").trim();
  if (providerId === QUOTA_PROVIDERS_AGGREGATE_ID) return text || undefined;
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

/** "1,200.50" → "1200.5"; undefined when it is not a plain number. */
function canonicalDecimal(text: string): string | undefined {
  const plain = text.replace(/,/gu, "");
  if (!/^\d+(?:\.\d+)?$/u.test(plain)) return undefined;
  const [integer = "0", fraction = ""] = plain.split(".");
  const whole = integer.replace(/^0+(?=\d)/u, "");
  const decimals = fraction.replace(/0+$/u, "");
  return decimals ? `${whole}.${decimals}` : whole;
}

/**
 * The unit of a local estimate's compact "used/limit" summary: dollars for a budget, requests
 * otherwise. Remote entries give no amounts, as a mapping may write "remaining/limit".
 */
function pairUnit(entry: QuotaToastEntry): AmountUnit | undefined {
  if (entry.accounting.acquisitionMethod !== "local_estimation") return undefined;
  return entry.accounting.resultType === "budget"
    ? { kind: "currency", code: "USD" }
    : { kind: "count", unit: "request" };
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

function valueFields(entry: QuotaToastEntry): Record<string, unknown> {
  if (entry.kind === "value") return { text: entry.value };
  return {
    percentRemaining: entry.percentRemaining,
    ...usedAndLimitFromRight(entry.right, pairUnit(entry)),
    ...(entry.fixedWindow ? { windowStartedAt: entry.fixedWindow.startedAtIso } : {}),
  };
}

/** The candidate row for one custom entry (checked later by `validateRows`), or why it has none. */
function candidateRow(
  providerId: string,
  entry: QuotaToastEntry,
): Record<string, unknown> | string {
  if (providerId !== QUOTA_PROVIDERS_AGGREGATE_ID) return "unknown provider";
  const rowKey = customKey(entry);
  if (!rowKey) return "no row key";
  const account = accountFromGroup(providerId, entry.group);
  return {
    id: `${providerId}.${rowKey.key}`,
    providerId,
    ...(account ? { account } : {}),
    label: rowKey.label || entry.name,
    type: rowType(entry.accounting.resultType),
    method: entry.accounting.acquisitionMethod,
    authority: entry.accounting.authority,
    ...(rowKey.window ? { window: rowKey.window } : {}),
    prominence: "primary",
    ...valueFields(entry),
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
 * A key is a name the adapter or this file chose, so it is only cleaned and shortened.
 */
function detail(key: string, value: string): DebugDetail {
  return {
    key: sanitizeSingleLineDisplaySnippet(key, 64),
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
 * Checks the candidate rows and reads the errors: the rows, the error to show and the debug
 * details. `rowLogins` holds source ids here; the provider source keys them before the store
 * gets them.
 */
function finishFetch(params: {
  providerId: string;
  attempted: boolean;
  candidates: readonly Candidate[];
  errors: readonly QuotaToastError[];
  debug: DebugDetail[];
  nowMs: number;
}): ProviderFetch {
  const { debug } = params;
  // Each row is checked on its own, so it keeps its login.
  const rows: QuotaRow[] = [];
  const rowLogins: string[] = [];
  for (const { row, login } of dropRepeatedRows(params.candidates, debug)) {
    const checked = validateRows(params.providerId, [row]);
    debug.push(...checked.dropped);
    for (const clean of checked.rows) {
      rows.push(clean);
      rowLogins.push(login);
    }
  }
  const logins = rowLogins.some(Boolean) ? { rowLogins } : {};

  for (const error of params.errors)
    debug.push(detail("error", `${error.label}: ${error.message}`));
  const [firstError] = params.errors;
  if (firstError) {
    return { rows, ...logins, error: classifyError(firstError.message, params.nowMs), debug };
  }
  if (!params.attempted && rows.length === 0) {
    return { rows: [], error: { code: "not_configured" }, debug };
  }
  return { rows, ...logins, debug };
}

/** The custom providers' legacy result as v6 rows, the error to show, and the debug details. */
export function rowsFromLegacyResult(
  providerId: string,
  result: QuotaProviderResult,
  nowMs: number = Date.now(),
): ProviderFetch {
  const debug = (result.diagnostics ?? []).map(customCheckDetail);
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
  return finishFetch({
    providerId,
    attempted: result.attempted,
    candidates,
    errors: result.errors,
    debug,
    nowMs,
  });
}

/** Each account's errors, labelled with the account's name. */
function accountErrors(accounts: readonly AccountResult[]): QuotaToastError[] {
  return accounts.flatMap((account) =>
    account.errors.map((error) => ({ label: account.name, message: error.message })),
  );
}

/** A contract result as v6 rows: each row gets its id, provider and its account's account. */
function rowsFromContractResult(
  providerId: string,
  result: ProviderFetchResult,
  nowMs: number,
): ProviderFetch {
  const candidates: Candidate[] = result.accounts.flatMap((account) => {
    const accountText = accountFromGroup(providerId, account.name);
    return account.rows.map(({ key, ...fields }) => ({
      row: {
        ...fields,
        id: `${providerId}.${key}`,
        providerId,
        ...(accountText ? { account: accountText } : {}),
      },
      login: account.login ?? "",
    }));
  });
  return finishFetch({
    providerId,
    attempted: result.attempted,
    candidates,
    errors: accountErrors(result.accounts),
    debug: result.debug.map((item) => detail(item.key, item.value)),
    nowMs,
  });
}

/** True for a result on the row contract, false for a legacy result. */
export function isContractResult(value: unknown): value is ProviderFetchResult {
  return isRecord(value) && Array.isArray(value.accounts);
}

/** A provider result in either shape as v6 rows, the error to show and the debug details. */
export function rowsFromProviderResult(
  providerId: string,
  result: QuotaProviderResult | ProviderFetchResult,
  nowMs: number = Date.now(),
): ProviderFetch {
  return isContractResult(result)
    ? rowsFromContractResult(providerId, result, nowMs)
    : rowsFromLegacyResult(providerId, result, nowMs);
}
