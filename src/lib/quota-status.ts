/**
 * The Quota Status report (`/quota_status`, the `quota_status` tool, `opencode-quota status`):
 * where the settings come from, what each known provider returned, logins, local files and
 * prices. Every provider section is built the same way from the store's snapshot (state, rows,
 * error, debug details).
 *
 * Users paste this report into public issues, so it is built from a closed vocabulary. Every
 * value it prints is a member of a set this plugin defines (provider ids, row keys, windows,
 * error codes, states, setting keys, env variable names, folder and file names) or a number,
 * count or time this file formats. Everything else is counted or stands in as a placeholder:
 * "custom 1", "account 2", "(part 1)", "(custom path)", "3 other details not shown". A debug
 * detail shows only when its key is in its provider's allow list and its value passes that
 * key's rule.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { classifyError, describeError, LOCAL_TOOLS } from "../core/errors.js";
import type {
  Amount,
  ProviderSnapshot,
  QuotaError,
  QuotaErrorCode,
  QuotaRow,
} from "../core/types.js";
import type { UsageReport } from "../core/usage.js";
import { isQuotaWindow } from "../core/windows.js";
import { isV5SettingKey } from "../settings/convert.js";
import type { LoadedSettings, Settings, V5Conversion } from "../settings/index.js";
import { isSettingsGroup, SETTINGS_SCHEMA } from "../settings/schema.js";
import { formatShare, formatTokens } from "../view/format.js";
import { API_KEY_LOGIN_VENDORS, API_KEY_VENDORS } from "./api-key-resolver.js";
import { COPILOT_AUTH_KEYS } from "./copilot.js";
import { CURSOR_CANONICAL_PLUGIN_PACKAGE } from "./cursor-detection.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { AccountingCountUnit } from "./entries.js";
import { AGY_AUTH_KEYS } from "./google-agy.js";
import { GEMINI_CLI_AUTH_KEYS } from "./google-gemini-cli.js";
import { replaceHomeDirWithTildeInDocument } from "./home-dir-display.js";
import type { MaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
import {
  getPricingRefreshPolicy,
  getPricingSnapshotHealth,
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  isBundledPricingModelId,
  isBundledPricingProviderId,
  listProviders,
  type PricingSnapshotSource,
  readPricingRefreshState,
} from "./modelsdev-pricing.js";
import { OPENAI_AUTH_SOURCE_KEYS } from "./openai.js";
import type { CredentialSourceDiagnostics, CredentialSourceKind } from "./opencode-auth.js";
import { getOpenCodeDbPath } from "./opencode-db-path.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getOpenCodeDbStats } from "./opencode-storage.js";
import {
  type CanonicalQuotaProviderId,
  getQuotaProviderDisplayLabel,
  QUOTA_PROVIDER_CATALOG,
  QUOTA_PROVIDER_RUNTIME_IDS,
} from "./provider-metadata.js";
import {
  isMaintainedQuotaProviderTuning,
  type QuotaProviderDefinition,
} from "./quota-providers.js";
import {
  commandHeading,
  type ReportDocument,
  type ReportKvRow,
  type ReportSection,
  renderPlainTextReport,
} from "./report-document.js";
import { getPackageVersion } from "./version.js";

/** Rows listed per provider section; the rest are counted. */
const ROW_LIST_LIMIT = 8;
/** Models without a price listed in the pricing section; the rest are counted. */
const UNPRICED_LIST_LIMIT = 5;
/** Shown for a path outside the known folders, or with a part this plugin did not name. */
const CUSTOM_PATH = "(custom path)";

/** The quota providers' ids. */
const PROVIDER_IDS: ReadonlySet<string> = new Set(Object.keys(QUOTA_PROVIDER_CATALOG));
/** The provider ids OpenCode uses for them ("github-copilot", "codex", …), and theirs. */
const OPENCODE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...PROVIDER_IDS,
  ...Object.values(QUOTA_PROVIDER_RUNTIME_IDS).flat(),
]);

const ERROR_CODES: Readonly<Record<QuotaErrorCode, true>> = {
  not_configured: true,
  login_expired: true,
  no_plan: true,
  rate_limited: true,
  timeout: true,
  network: true,
  provider_error: true,
  bad_response: true,
  no_data: true,
  local_tool: true,
  internal: true,
};

const COUNT_UNITS: Readonly<Record<AccountingCountUnit, true>> = {
  request: true,
  token: true,
  credit: true,
  message: true,
  interaction: true,
  unit: true,
};

const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

const CREDENTIAL_SOURCE_KINDS: Readonly<Record<CredentialSourceKind, true>> = {
  "opencode-integration-api": true,
  sqlite: true,
};
const CREDENTIAL_FAILURE_CATEGORIES = new Set(["refresh_failed", "resolve_empty", "active_failed"]);

/** Every row key each provider writes (`*` is one part of the provider's own naming). */
export const REPORT_ROW_KEYS: Readonly<Record<CanonicalQuotaProviderId, readonly string[]>> = {
  anthropic: ["five_hour", "weekly", "weekly_fable", "extra_usage"],
  copilot: ["allowance", "additional_budget"],
  openai: ["five_hour", "weekly", "monthly", "code_review", "status"],
  openrouter: ["key"],
  kilo: ["pass_credits", "balance"],
  cursor: ["api", "auto_composer"],
  "alibaba-coding-plan": ["five_hour", "weekly", "monthly"],
  "alibaba-token-plan": ["five_hour", "weekly"],
  synthetic: ["five_hour", "weekly"],
  chutes: ["daily"],
  "google-gemini-cli": ["pro", "flash", "flash_lite", "model.*"],
  "google-agy": [
    "gemini.weekly",
    "gemini.five_hour",
    "claude_gpt.weekly",
    "claude_gpt.five_hour",
    "*.weekly",
    "*.five_hour",
  ],
  zai: ["five_hour", "weekly", "mcp"],
  zhipu: ["five_hour", "weekly", "mcp"],
  nanogpt: ["daily", "monthly", "balance.usd", "balance.nano"],
  "minimax-coding-plan": ["five_hour", "weekly"],
  "minimax-china-coding-plan": ["five_hour", "weekly"],
  "kimi-code-plan-global": ["weekly", "limit.*"],
  "kimi-code-plan-cn": ["weekly", "limit.*"],
  deepseek: ["total_balance.*", "granted_balance.*", "topped_up_balance.*", "available"],
  xai: ["credits"],
  xiaomi: ["monthly_tokens", "total_balance", "cash_balance", "gift_balance"],
  "opencode-go": ["five_hour", "weekly", "monthly"],
  opencode: ["monthly", "balance", "auto_reload"],
  "ollama-cloud": ["session", "weekly", "monthly"],
  "quota-providers": ["custom.*.*"],
};

/** Folder and file names this plugin and OpenCode use; a shown path is made only of these. */
const KNOWN_PATH_PARTS: ReadonlySet<string> = new Set([
  ".config",
  ".local",
  "share",
  "state",
  ".cache",
  "opencode",
  "opencode-quota",
  "quota-providers",
  ".claude",
  "local",
  "bin",
  ".cursor",
  "cursor",
]);
/** File names this plugin and OpenCode read or write. */
const KNOWN_FILE_NAMES: ReadonlySet<string> = new Set([
  "settings.jsonc",
  "opencode.db",
  "opencode.json",
  "opencode.jsonc",
  "auth.json",
  "cli-config.json",
  ".credentials.json",
  "copilot-quota-token.json",
  "mimo.json",
  "alibaba-coding-plan-local-quota.json",
  "modelsdev-pricing.runtime.min.json",
  "modelsdev-pricing.refresh-state.json",
  "snapshot-v6.json",
  "quota-export.json",
  "display-import.json",
  "google-access-tokens.json",
  "maintainer-announcements-home.json",
  "quota-toast.json",
  "quota-toast.jsonc",
  "claude",
]);
/** Paths outside the home dir this plugin looks at. */
const KNOWN_ABSOLUTE_PATHS: ReadonlySet<string> = new Set([
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
]);
/** Where an API key came from, besides an env variable or a path. */
const KEY_FILE_SOURCES: ReadonlySet<string> = new Set([
  "opencode.json",
  "opencode.jsonc",
  "opencode.db",
]);

/** The env variables this plugin reads a key or a cookie from. */
const KNOWN_ENV_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(API_KEY_VENDORS).flatMap((vendor) => vendor.envVars),
  ...Object.values(API_KEY_LOGIN_VENDORS).flatMap((vendor) => vendor.envVars),
  "OPENROUTER_API_KEY",
  "CURSOR_API_KEY",
  "MIMO_USAGE_COOKIE",
]);

type ProviderAvailability = {
  id: string;
  enabled: boolean;
  available: boolean;
  matchesCurrentModel?: boolean;
};

export type QuotaStatusReportParams = {
  /** The server settings as read now. */
  settings: Pick<LoadedSettings, "path" | "exists" | "issues" | "notRead">;
  /** The v5 settings conversion: written when this server started, or done in memory. */
  conversion?: V5Conversion;
  /** The project folder quota is computed for. */
  workspaceRoot: string;
  enabledProviders: string[] | "auto";
  onlyCurrentModel: boolean;
  quotaProviders?: readonly QuotaProviderDefinition[];
  pricingSnapshotSource: PricingSnapshotSource;
  currentModel?: string;
  /** Whether a session was available for model lookup */
  sessionModelLookup?: "ok" | "not_found" | "no_session";
  /** Every known provider, enabled or not: one section each, in this order. */
  providerAvailability: ProviderAvailability[];
  /**
   * The store's snapshot of each provider it checked: the enabled and available ones, and the
   * unavailable ones for their setup details.
   */
  providers: readonly ProviderSnapshot[];
  credentialSource: CredentialSourceDiagnostics;
  maintainerAnnouncements?: {
    config: Settings["announcements"];
    summary: MaintainerAnnouncementsSummary;
  };
  /** The last 30 days of usage, for the models without a price; null when it can't be read. */
  usage?: UsageReport | null;
  generatedAtMs?: number;
  /** The home dir the report shows as "~"; defaults to the computer's (tests set it). */
  homeDir?: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : "(none)";
}

/** An ISO time this file formats, or "(none)" for no or a bad time. */
function isoText(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "(none)";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "(none)" : date.toISOString();
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(" | ") : "(none)";
}

function kvSection(id: string, rows: ReportKvRow[]): ReportSection {
  return { id, title: `${id}:`, blocks: [{ kind: "kv", rows }] };
}

/** "1 other detail not shown", "3 other details not shown". */
function countText(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Hands out 1, 2, 3, … per distinct value, in the order values are first seen. */
function numbering(): (value: string) => number {
  const seen: string[] = [];
  return (value) => {
    if (!seen.includes(value)) seen.push(value);
    return seen.indexOf(value) + 1;
  };
}

/** The 1-based place of each custom definition id, as the settings section lists them. */
function customNumbers(params: QuotaStatusReportParams): Map<string, number> {
  return new Map(
    (params.quotaProviders ?? []).map((definition, index) => [definition.id, index + 1]),
  );
}

/** `env:NAME` for a variable this plugin reads; `env:(other)` for any other. */
function envText(name: string): string {
  return KNOWN_ENV_NAMES.has(name) ? `env:${name}` : "env:(other)";
}

/** The path's parts after the home dir ("~" or `homeDir`), or undefined outside it. */
function partsUnderHome(path: string, homeDir: string): string[] | undefined {
  for (const home of ["~", homeDir]) {
    if (!home) continue;
    if (path === home) return [];
    const separator = path.charAt(home.length);
    if (path.startsWith(home) && (separator === "/" || separator === "\\")) {
      return path.slice(home.length + 1).split(/[/\\]/u);
    }
  }
  return undefined;
}

/**
 * A path made only of known parts: under the home dir, every folder and file name one this
 * plugin or OpenCode uses ("~/.config/opencode/opencode-quota/settings.jsonc"), or a known
 * absolute path. Any other path, such as one from an env variable or the settings, shows as
 * "(custom path)", with its file name when that is a known one.
 */
function pathText(raw: string, homeDir: string): string {
  const path = sanitizeSingleLineDisplayText(raw);
  if (KNOWN_ABSOLUTE_PATHS.has(path)) return path;
  const parts = partsUnderHome(path, sanitizeSingleLineDisplayText(homeDir));
  const known = (part: string) => KNOWN_PATH_PARTS.has(part) || KNOWN_FILE_NAMES.has(part);
  if (parts?.every(known)) return ["~", ...parts].join("/");
  const fileName = path.split(/[/\\]/u).at(-1) ?? "";
  return KNOWN_FILE_NAMES.has(fileName) ? `${CUSTOM_PATH}/${fileName}` : CUSTOM_PATH;
}

/** A path with the "(experimental.quotaToast)" note v5 conversion adds to a source. */
function sourceFileText(source: string, homeDir: string): string {
  const note = " (experimental.quotaToast)";
  return source.endsWith(note)
    ? `${pathText(source.slice(0, -note.length), homeDir)}${note}`
    : pathText(source, homeDir);
}

/** A model id the shipped price list has, else undefined. */
function knownModelId(modelId: string): string | undefined {
  return isBundledPricingModelId(modelId) ? modelId : undefined;
}

function currentModelText(params: QuotaStatusReportParams): string {
  if (params.currentModel)
    return knownModelId(params.currentModel) ?? "(a model not in the price list)";
  if (params.sessionModelLookup === "not_found") return "(error: session.get returned no modelID)";
  if (params.sessionModelLookup === "no_session") return "(no session available)";
  return "(unknown)";
}

/** Known provider ids joined, and how many others there were. */
function providerIdsText(ids: readonly string[]): string {
  const known = ids.filter((id) => PROVIDER_IDS.has(id));
  const others = ids.length - known.length;
  const text = joinOrNone(known);
  return others > 0 ? `${text} (+${countText(others, "unknown id", "unknown ids")})` : text;
}

/**
 * A custom provider definition as its number, mode and model count: "custom 1 (remote-api,
 * 3 models)". Its id, provider id, URL, key, env variable and model ids are never shown. A
 * definition that tunes a maintained provider names that provider.
 */
function customProviderText(definition: QuotaProviderDefinition, number: number): string {
  const mode = definition.mode === "remote-api" ? "remote-api" : "local-estimate";
  const models = definition.modelIds
    ? countText(definition.modelIds.length, "model", "models")
    : "all models";
  const tunes =
    isMaintainedQuotaProviderTuning(definition) && PROVIDER_IDS.has(definition.id)
      ? `, tunes ${definition.id}`
      : "";
  return `custom ${number} (${mode}, ${models}${tunes})`;
}

function settingsFileText(params: QuotaStatusReportParams, homeDir: string): string {
  const { exists } = params.settings;
  const path = pathText(params.settings.path, homeDir);
  if (exists) return `${path} (exists)`;
  if (params.conversion) return `${path} (missing; the v5 settings are converted in memory)`;
  return `${path} (missing; using the defaults)`;
}

/** Our words for a settings issue, chosen by its message; never the value it names. */
const ISSUE_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^expected one JSON object/u, "not one JSON object; using the defaults"],
  [/^expected /u, "invalid value"],
  [/^unknown provider id/u, "unknown provider id"],
  [/^duplicate key/u, "duplicate key"],
  [/^cannot read it/u, "cannot read the file; using the defaults"],
  [/^file-only/u, "file-only setting"],
];

function issueCodeText(message: string): string {
  const line = /^syntax error on line (\d+)/u.exec(message)?.[1];
  if (line !== undefined) return `syntax error on line ${Number(line)}`;
  return ISSUE_CODES.find(([pattern]) => pattern.test(message))?.[1] ?? "invalid";
}

/** A settings key from the schema, a group, a file-level key, or the custom providers. */
function issueKeyText(key: string): string | undefined {
  if (Object.hasOwn(SETTINGS_SCHEMA, key) || isSettingsGroup(key)) return key;
  if (key === "$file" || key === "$patch" || key === "$conversion") return key;
  if (key.startsWith("providers.custom[") || key.startsWith("providers.custom.")) {
    return "providers.custom";
  }
  return undefined;
}

/** Each issue as our key and words; unknown keys are counted. */
function settingsIssueRows(issues: LoadedSettings["issues"]): ReportKvRow[] {
  const rows: ReportKvRow[] = [];
  let unknownKeys = 0;
  for (const issue of issues) {
    const key = issueKeyText(issue.key);
    if (key === undefined || issue.message.startsWith("unknown setting")) {
      unknownKeys += 1;
      continue;
    }
    rows.push({ key: "settings_issue", value: `${key}: ${issueCodeText(issue.message)}` });
  }
  if (unknownKeys > 0) {
    rows.push({
      key: "settings_issue",
      value: countText(unknownKeys, "unknown key", "unknown keys"),
    });
  }
  return rows;
}

/** v5 keys joined, and how many unknown keys there were: "showOnIdle, debug (+1 unknown key)". */
function v5KeysText(keys: readonly string[]): string {
  // "quotaProviders[0].url" is a problem inside the v5 key "quotaProviders".
  const bases = keys.map((key) => key.replace(/\[.*$/su, ""));
  const known = [...new Set(bases.filter(isV5SettingKey))];
  const others = bases.filter((key) => !isV5SettingKey(key)).length;
  const text = known.join(", ");
  if (others === 0) return text;
  const count = countText(others, "unknown key", "unknown keys");
  return text ? `${text} (+${count})` : count;
}

/** Where the v5 settings went: written to settings.jsonc, or not. Only v5 keys are named. */
function conversionRows(conversion: V5Conversion, homeDir: string): ReportKvRow[] {
  const { converted, dropped, invalid } = conversion;
  const sources = conversion.sources.map((source) => sourceFileText(source, homeDir));
  const counts = `${converted.length} converted, ${dropped.length} dropped, ${invalid.length} invalid`;
  const outcome = conversion.written
    ? "written to settings.jsonc"
    : conversion.notWrittenReason !== undefined
      ? "not written"
      : "converted in memory";
  const rows: ReportKvRow[] = [
    { key: "conversion", value: `from ${joinOrNone(sources)} (${counts}); ${outcome}` },
  ];
  const lists: Array<[string, readonly { key: string }[]]> = [
    ["conversion_converted", converted],
    ["conversion_dropped", dropped],
    ["conversion_invalid", invalid],
  ];
  for (const [key, items] of lists) {
    if (items.length > 0) rows.push({ key, value: v5KeysText(items.map((item) => item.key)) });
  }
  if (conversion.notes.length > 0) {
    rows.push({ key: "conversion_notes", value: `${conversion.notes.length} not shown` });
  }
  return rows;
}

/** The settings file, what is wrong in it, the v5 conversion, and what quota is set to do. */
function settingsSection(params: QuotaStatusReportParams, homeDir: string): ReportSection {
  const enabled = params.enabledProviders;
  const rows: ReportKvRow[] = [
    { key: "settings_file", value: settingsFileText(params, homeDir) },
    ...settingsIssueRows(params.settings.issues),
  ];
  if (params.conversion) rows.push(...conversionRows(params.conversion, homeDir));
  rows.push({
    key: "project_settings",
    value: "none: the settings are global; v5 project-scope files are not read",
  });
  if (params.settings.notRead.length > 0) {
    const paths = params.settings.notRead.map((path) => sourceFileText(path, homeDir));
    rows.push({ key: "not_read", value: joinOrNone(paths) });
  }
  rows.push(
    { key: "enabledProviders", value: enabled === "auto" ? "(auto)" : providerIdsText(enabled) },
    { key: "onlyCurrentModel", value: params.onlyCurrentModel === true ? "true" : "false" },
    { key: "currentModel", value: currentModelText(params) },
    { key: "workspace_root", value: pathText(params.workspaceRoot, homeDir) },
  );
  (params.quotaProviders ?? []).forEach((definition, index) => {
    rows.push({ key: "custom_provider", value: customProviderText(definition, index + 1) });
  });
  return kvSection("settings", rows);
}

function providerIdText(id: string): string {
  return PROVIDER_IDS.has(id) ? id : "(other provider)";
}

function providerListSection(availability: readonly ProviderAvailability[]): ReportSection {
  return kvSection(
    "providers",
    availability.map((provider) => {
      const bits = [
        provider.enabled ? "enabled" : "disabled",
        provider.available ? "available" : "unavailable",
      ];
      if (provider.matchesCurrentModel !== undefined) {
        bits.push(`matchesCurrentModel=${provider.matchesCurrentModel ? "yes" : "no"}`);
      }
      return { key: providerIdText(provider.id), value: bits.join(" ") };
    }),
  );
}

function announcementsSection(
  announcements: NonNullable<QuotaStatusReportParams["maintainerAnnouncements"]>,
): ReportSection {
  const { config, summary } = announcements;
  const frequency = config.homeFrequency === "always" ? "always" : "daily";
  return kvSection("maintainer_announcements", [
    { key: "enabled", value: config.enabled === true ? "true" : "false" },
    { key: "home", value: config.home === true ? "true" : "false" },
    { key: "home_frequency", value: frequency },
    { key: "source", value: summary.source === "bundled_only" ? "bundled_only" : "(other)" },
    { key: "network", value: summary.network ? "true" : "false" },
    { key: "active", value: fmtInt(summary.activeCount) },
    { key: "future", value: fmtInt(summary.futureCount) },
    { key: "expired", value: fmtInt(summary.expiredCount) },
  ]);
}

async function pathsSection(homeDir: string): Promise<ReportSection> {
  const dirs = getOpencodeRuntimeDirs();
  const dbPath = getOpenCodeDbPath();
  const shownDb = pathText(dbPath, homeDir);
  let db = `path=${shownDb} present=false`;
  if (await pathExists(dbPath)) {
    const stats = await getOpenCodeDbStats();
    db = `path=${shownDb} present=true sessions=${fmtInt(stats.sessionCount)} messages=${fmtInt(stats.messageCount)} assistant_messages=${fmtInt(stats.assistantMessageCount)}`;
  }
  const dir = (path: string) => pathText(path, homeDir);
  return kvSection("paths", [
    {
      key: "opencode_dirs",
      value: `data=${dir(dirs.dataDir)} config=${dir(dirs.configDir)} cache=${dir(dirs.cacheDir)} state=${dir(dirs.stateDir)}`,
    },
    { key: "opencode.db", value: `${db} (session and token history)` },
  ]);
}

function isErrorCode(code: unknown): code is QuotaErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_CODES, code);
}

/** An HTTP status this file shows: a whole number from 100 to 599. */
function httpStatus(status: unknown): number | undefined {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600
    ? status
    : undefined;
}

/** An error's code and HTTP status: "provider_error, http 503". */
function errorKind(error: QuotaError): string {
  if (!isErrorCode(error.code)) return "(unknown error code)";
  const status = httpStatus(error.status);
  return status === undefined ? error.code : `${error.code}, http ${status}`;
}

/**
 * The login source and its failures: each failed login's integration id (when OpenCode or this
 * plugin knows it), failure kind and time, never its label or the error's own words.
 */
function credentialSourceSection(diagnostics: CredentialSourceDiagnostics): ReportSection {
  const failures = diagnostics.failures.map((failure) => {
    const integration = OPENCODE_PROVIDER_IDS.has(failure.integrationId)
      ? failure.integrationId
      : "(other integration)";
    const category = CREDENTIAL_FAILURE_CATEGORIES.has(failure.category)
      ? failure.category
      : "(other failure)";
    return `${integration}: ${category} at ${isoText(failure.at)}`;
  });
  const listError = diagnostics.lastListError;
  const listErrorText = listError
    ? `${errorKind(classifyError(listError.detail))} at ${isoText(listError.at)}`
    : "(none)";
  const source =
    diagnostics.state === "bound"
      ? Object.hasOwn(CREDENTIAL_SOURCE_KINDS, diagnostics.kind)
        ? diagnostics.kind
        : "(other source)"
      : "unbound";
  return kvSection("credential_source", [
    { key: "source", value: source },
    { key: "list_error", value: listErrorText },
    { key: "failures", value: joinOrNone(failures) },
  ]);
}

/** A decimal as the number it is: "4.50" → "4.5". */
function numberText(decimal: string): string {
  const value = Number(decimal);
  return Number.isFinite(value) ? String(value) : "(not a number)";
}

/** "4.5 USD", "12 request"; a unit this plugin does not name shows as a placeholder. */
function amountText(amount: Amount): string {
  const { unit } = amount;
  let unitText = "(custom unit)";
  if (unit.kind === "currency") unitText = CURRENCIES.has(unit.code) ? unit.code : "(currency)";
  else if (unit.kind === "count") {
    unitText = Object.hasOwn(COUNT_UNITS, unit.unit) ? unit.unit : "(unit)";
  }
  return `${numberText(amount.decimal)} ${unitText}`;
}

/**
 * A row's facts in one line, for example "window=five_hour, 43% left, 57/100 request,
 * resets 2026-…". Its label and text are the provider's words: a text value is only noted.
 */
function rowFacts(row: QuotaRow): string {
  const parts: string[] = [];
  if (row.window !== undefined) {
    parts.push(isQuotaWindow(row.window) ? `window=${row.window}` : "window=(other)");
  }
  if (typeof row.percentRemaining === "number" && Number.isFinite(row.percentRemaining)) {
    parts.push(`${Math.round(row.percentRemaining)}% left`);
  }
  if (row.used && row.limit) parts.push(`${numberText(row.used.decimal)}/${amountText(row.limit)}`);
  if (row.amount) parts.push(amountText(row.amount));
  if (row.flag !== undefined) parts.push(row.flag ? "yes" : "no");
  if (row.text !== undefined) parts.push("text not shown");
  if (row.resetsAt !== undefined) parts.push(`resets ${isoText(Date.parse(row.resetsAt))}`);
  return parts.join(", ");
}

/**
 * A row id from the ledger: the provider id and its row key, each `*` part as "(part 1)" and a
 * custom definition's id as "(custom 1)", numbered like the settings section.
 */
function rowIdText(
  row: QuotaRow,
  parts: (value: string) => number,
  customs: ReadonlyMap<string, number>,
): string {
  const [providerId = "", ...keyParts] = row.id.split(".");
  if (!PROVIDER_IDS.has(providerId)) return "(other row)";
  const patterns = REPORT_ROW_KEYS[providerId as CanonicalQuotaProviderId].map((key) =>
    key.split("."),
  );
  const pattern = patterns.find(
    (candidate) =>
      candidate.length === keyParts.length &&
      candidate.every((part, index) => part === "*" || part === keyParts[index]),
  );
  if (!pattern) return `${providerId}.(other row)`;
  const shown = pattern.map((part, index) => {
    if (part !== "*") return part;
    const value = keyParts[index] ?? "";
    const custom = providerId === "quota-providers" && index === 1 ? customs.get(value) : undefined;
    return custom !== undefined ? `(custom ${custom})` : `(part ${parts(value)})`;
  });
  return [providerId, ...shown].join(".");
}

/**
 * The error in our own words, with its code and HTTP status: "Provider error 503
 * (provider_error, http 503)". A local tool is named only when it is one this plugin knows.
 */
function errorText(error: QuotaError, providerId: string, nowMs: number): string {
  if (!isErrorCode(error.code)) return "(unknown error code)";
  const tool =
    error.tool !== undefined && LOCAL_TOOLS.includes(error.tool) ? error.tool : undefined;
  const retryAtMs =
    typeof error.retryAtMs === "number" && Number.isFinite(error.retryAtMs)
      ? error.retryAtMs
      : undefined;
  const known: QuotaError = {
    code: error.code,
    status: httpStatus(error.status),
    retryAtMs,
    tool,
    missing: error.missing === true,
  };
  const label = PROVIDER_IDS.has(providerId)
    ? getQuotaProviderDisplayLabel(providerId)
    : "the provider";
  return `${describeError(known, label, nowMs)} (${errorKind(known)})`;
}

/** "ok", or the error in our words; "partial" when rows came with the error. */
function providerState(provider: ProviderSnapshot, nowMs: number): string {
  if (provider.checkedAtMs === undefined) return provider.refreshing ? "checking" : "not checked";
  const error = provider.error;
  if (!error) return "ok";
  const words = errorText(error, provider.providerId, nowMs);
  return provider.rows.length > 0 ? `partial: ${words}` : `error: ${words}`;
}

/**
 * A debug value's rule: the value as shown, or undefined when it is not one the rule allows.
 * Every rule prints only members of its own set, numbers and times it formats, known env
 * variable names and known paths.
 */
type DebugRule = (value: string, homeDir: string) => string | undefined;
type DebugRules = Readonly<Record<string, DebugRule>>;

/** Shown as they are for any allowed key. */
const NO_VALUES: ReadonlySet<string> = new Set(["(none)", "(unknown)", "unknown"]);

function oneOf(...values: readonly string[]): DebugRule {
  const allowed = new Set(values);
  return (value) => (allowed.has(value) ? value : undefined);
}

/** "a,b" when every item is one of `values`. */
function listOf(values: Iterable<string>): DebugRule {
  const allowed = new Set(values);
  return (value) => (value.split(",").every((item) => allowed.has(item)) ? value : undefined);
}

const bool: DebugRule = oneOf("true", "false");

/** An error or message key: that it is set, never its words. */
const present: DebugRule = () => "(text not shown)";

/** A whole number, written with or without commas. */
const count: DebugRule = (value) => {
  const plain = value.replaceAll(",", "");
  return /^\d{1,15}$/u.test(plain) ? String(Number(plain)) : undefined;
};

const time: DebugRule = (value) => {
  const shown = isoText(Date.parse(value));
  return shown === "(none)" ? undefined : shown;
};

/** "2.1.3": the first three numbers of a version, as numbers. */
const version: DebugRule = (value) => {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})/u.exec(value);
  return match ? match.slice(1, 4).map(Number).join(".") : undefined;
};

const status: DebugRule = (value) => {
  const shown = httpStatus(Number(value));
  return shown === undefined ? undefined : String(shown);
};

/** A file path, or `env:NAME`. */
function pathOrEnv(value: string, homeDir: string): string {
  return value.startsWith("env:") ? envText(value.slice(4)) : pathText(value, homeDir);
}

/** Paths joined by " | ". */
const pathList: DebugRule = (value, homeDir) =>
  value
    .split(" | ")
    .map((path) => pathOrEnv(path, homeDir))
    .join(" | ");

/** Where an API key came from: `env:NAME`, a config file name, or a path. */
const keySource: DebugRule = (value, homeDir) =>
  KEY_FILE_SOURCES.has(value) ? value : pathOrEnv(value, homeDir);

/** The Claude CLI's arguments this plugin passes. */
const CLAUDE_ARGS: ReadonlySet<string> = new Set(["--version", "auth", "status", "--json"]);

/** Claude CLI command lines joined by " | ": the program as a path, then known arguments. */
const claudeCommands: DebugRule = (value, homeDir) =>
  value
    .split(" | ")
    .map((command) => {
      const words = command.match(/"(?:[^"\\]|\\.)*"|[^\s"]+/gu) ?? [];
      const [program = "", ...args] = words.map((word) => {
        if (!word.startsWith('"')) return word;
        try {
          return String(JSON.parse(word));
        } catch {
          return "";
        }
      });
      const programText = program === "claude" ? "claude" : pathText(program, homeDir);
      return [programText, ...args.map((arg) => (CLAUDE_ARGS.has(arg) ? arg : "(arg)"))].join(" ");
    })
    .join(" | ");

/**
 * A value of `name=value` fields after an optional head word ("yes found=openai,codex"). Every
 * part must pass its rule; a field rule may read the rest of a value (a path list).
 */
function fields(rules: DebugRules, head?: DebugRule): DebugRule {
  const pattern = new RegExp(`(?:^| )(${Object.keys(rules).join("|")})=`, "gu");
  return (value, homeDir) => {
    const matches = [...value.matchAll(pattern)];
    const headText = value.slice(0, matches[0]?.index ?? value.length);
    const shown: string[] = [];
    if (headText) {
      const text = head?.(headText, homeDir);
      if (text === undefined) return undefined;
      shown.push(text);
    }
    for (const [index, match] of matches.entries()) {
      const name = match[1] ?? "";
      const start = match.index + match[0].length;
      const end = matches[index + 1]?.index ?? value.length;
      const text = ruleValue(rules[name], value.slice(start, end), homeDir);
      if (text === undefined) return undefined;
      shown.push(`${name}=${text}`);
    }
    return shown.length > 0 ? shown.join(" ") : undefined;
  };
}

function ruleValue(rule: DebugRule | undefined, value: string, homeDir: string) {
  if (!rule) return undefined;
  return NO_VALUES.has(value) ? value : rule(value, homeDir);
}

const API_KEY_DETAILS: DebugRules = {
  api_key_configured: oneOf("true", "false", "unreadable"),
  api_key_source: keySource,
  api_key_checked_paths: pathList,
  api_key_credential_database_paths: pathList,
};
const API_KEY_LOGIN_DETAILS: DebugRules = {
  ...API_KEY_DETAILS,
  auth_state: oneOf("none", "configured", "invalid"),
  auth_error: present,
  live_fetch_error: present,
};
/** Synthetic and Chutes write their key lookup as one value. */
const API_KEY_SUMMARY_DETAILS: DebugRules = {
  ...API_KEY_DETAILS,
  api_key_diagnostics: fields({ configured: bool, source: keySource, checked: pathList }),
};
const GOOGLE_DETAILS: DebugRules = {
  auth_state: oneOf("missing", "present", "invalid"),
  auth_source: oneOf(...AGY_AUTH_KEYS, ...GEMINI_CLI_AUTH_KEYS),
  account_count: count,
  valid_account_count: count,
  companion_package_state: oneOf("present", "missing", "invalid"),
  companion_package_path: pathList,
  auth_error: present,
};
const STATE_HEALTH = ["missing", "healthy", "malformed", "version_mismatch"] as const;
const CONSOLE_AUTH_STATES = ["none", "configured", "expired", "invalid"] as const;
const NODE_PLATFORMS = [
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
] as const;

/** The debug details each provider's section may show, by key; every other one is counted. */
const DEBUG_DETAILS: Readonly<Record<CanonicalQuotaProviderId, DebugRules>> = {
  anthropic: {
    cli_installed: bool,
    cli_version: version,
    binary_path: (value, homeDir) => (value === "claude (PATH)" ? value : pathText(value, homeDir)),
    auth_status: oneOf("authenticated", "unauthenticated", "unknown"),
    quota_supported: bool,
    quota_source: oneOf(
      "claude-auth-status-json",
      "claude-credentials-oauth-api",
      "opencode-auth-oauth-api",
    ),
    oauth_credential_source: oneOf("opencode-auth", "claude-credentials"),
    checked_commands: claudeCommands,
  },
  copilot: {
    pat_state: oneOf("absent", "invalid", "valid"),
    pat_path: pathList,
    pat_token_kind: oneOf("github_pat", "ghp", "ghu", "ghs", "other"),
    pat_tier: oneOf("free", "student", "pro", "pro+", "max", "business", "enterprise"),
    billing_model: oneOf("ai_credits", "legacy_premium_requests"),
    deployment: oneOf("github.com", "ghe.com", "invalid", "none"),
    api_host: oneOf("api.github.com"),
    enterprise_host_source: oneOf("pat", "oauth", "none"),
    billing_mode: oneOf("user_quota", "organization_usage", "enterprise_usage", "none"),
    billing_scope: oneOf("user", "organization", "enterprise", "none"),
    quota_api: oneOf(
      "github_ai_credit_api",
      "github_legacy_premium_request_api",
      "copilot_internal_user",
      "none",
    ),
    budget_api: oneOf("organization_budgets", "enterprise_budgets", "not_available"),
    billing_api_access_likely: bool,
    remaining_totals_state: oneOf(
      "available",
      "value_only_without_denominator",
      "not_available_from_org_usage",
      "not_available_from_enterprise_usage",
      "reported_by_copilot_internal_user",
      "unavailable",
    ),
    pat_checked_paths: pathList,
    oauth_configured: fields(
      { key: oneOf(...COPILOT_AUTH_KEYS), refresh: bool, access: bool, enterprise_host: bool },
      bool,
    ),
    effective_source: oneOf("pat", "oauth", "none"),
    oauth_accounting_state: oneOf(
      "available_via_copilot_internal_user",
      "invalid_enterprise_host",
      "not_configured",
    ),
    override: oneOf("pat_overrides_oauth", "none"),
  },
  openai: {
    auth_configured: bool,
    auth_source: oneOf(...OPENAI_AUTH_SOURCE_KEYS, ...OPENCODE_PROVIDER_IDS),
    auth_method: oneOf("chatgpt-token-sharing"),
    token_status: oneOf("api key", "failed", "expired", "valid"),
    token_expires_at: time,
  },
  openrouter: API_KEY_DETAILS,
  kilo: {
    ...API_KEY_DETAILS,
    accounting_mode: oneOf("kilo_pass", "gateway_balance"),
    reset_at: time,
  },
  cursor: {
    plan: oneOf("Pro", "Pro Plus", "Ultra", "none"),
    billing_cycle_start_day: (value) => (value === "(calendar month)" ? value : count(value, "")),
    auth_state: oneOf("missing", "present", "invalid"),
    auth_error: present,
    auth_selected_path: keySource,
    auth_present_paths: pathList,
    auth_candidate_paths: pathList,
    plugin_enabled: bool,
    canonical_plugin_package: oneOf(CURSOR_CANONICAL_PLUGIN_PACKAGE),
    provider_configured: bool,
    config_matches: pathList,
    config_checked_paths: pathList,
    cycle_source: oneOf("configured_day", "calendar_month"),
    cycle_reset_at: time,
    unknown_cursor_models: count,
  },
  "alibaba-coding-plan": {
    ...API_KEY_LOGIN_DETAILS,
    "alibaba auth configured": bool,
    alibaba_api_key_source: keySource,
    alibaba_api_key_checked_paths: pathList,
    alibaba_api_key_credential_database_paths: pathList,
    alibaba_coding_plan: oneOf("lite", "pro", "invalid"),
    local_state_path: pathList,
    local_state_exists: bool,
    local_state_health: oneOf(...STATE_HEALTH),
    local_state_version: count,
    local_state_last_update: time,
  },
  "alibaba-token-plan": {
    cli_available: bool,
    platform: oneOf(...NODE_PLATFORMS),
    windows: listOf(["5h", "weekly"]),
    failure_kind: oneOf(
      "unsupported_platform",
      "executable_not_found",
      "shell_launcher_rejected",
      "workspace_path_rejected",
      "spawn_failed",
      "timeout",
      "output_truncated",
      "nonzero_exit",
      "not_authenticated",
      "invalid_json",
      "invalid_schema",
      "no_data",
    ),
  },
  synthetic: API_KEY_SUMMARY_DETAILS,
  chutes: API_KEY_SUMMARY_DETAILS,
  "google-gemini-cli": GOOGLE_DETAILS,
  "google-agy": GOOGLE_DETAILS,
  zai: API_KEY_LOGIN_DETAILS,
  zhipu: API_KEY_LOGIN_DETAILS,
  nanogpt: {
    ...API_KEY_DETAILS,
    subscription_active: bool,
    enforce_daily_limit: bool,
    billing_period_end: time,
    grace_until: time,
  },
  "minimax-coding-plan": {
    ...API_KEY_LOGIN_DETAILS,
    api_endpoint: oneOf("international", "china"),
  },
  "minimax-china-coding-plan": {
    ...API_KEY_LOGIN_DETAILS,
    api_endpoint: oneOf("international", "china"),
  },
  "kimi-code-plan-global": { ...API_KEY_LOGIN_DETAILS, api_endpoint: oneOf("global", "cn") },
  "kimi-code-plan-cn": { ...API_KEY_LOGIN_DETAILS, api_endpoint: oneOf("global", "cn") },
  deepseek: API_KEY_DETAILS,
  xai: {},
  xiaomi: {
    config_state: oneOf("none", "configured", "invalid"),
    config_source: keySource,
    config_checked_paths: pathList,
  },
  "opencode-go": {
    ...API_KEY_LOGIN_DETAILS,
    auth_source: keySource,
    auth_checked_paths: pathList,
    credential_database_paths: pathList,
    console_auth_state: oneOf(...CONSOLE_AUTH_STATES),
    console_error: present,
    go_source: oneOf("console", "legacy_key"),
    opencode_go_state: oneOf("not_subscribed"),
    selected_windows: listOf(["rolling", "weekly", "monthly"]),
  },
  opencode: {
    console_auth_state: oneOf(...CONSOLE_AUTH_STATES),
    budget_source: oneOf("org_budget", "credit_limit"),
    auto_reload: bool,
    live_fetch_error: present,
  },
  "ollama-cloud": API_KEY_DETAILS,
  "quota-providers": {},
};

/** Every section may show whether OpenCode lists the provider ("yes found=openai"). */
const SETUP_DETAILS: DebugRules = {
  opencode_provider: fields(
    { found: listOf(OPENCODE_PROVIDER_IDS), looked_for: listOf(OPENCODE_PROVIDER_IDS) },
    oneOf("yes", "no", "unreadable"),
  ),
};

/** A custom definition's check: outcome, login source, files read, local counter state. */
const CUSTOM_CHECK: DebugRule = fields({
  outcome: oneOf(
    "missing_credential",
    "success",
    "http_error",
    "redirect_error",
    "timeout",
    "body_too_large",
    "invalid_content_type",
    "invalid_json",
    "invalid_response",
    "network_error",
    "local_state_error",
  ),
  http_status: status,
  credential_source: oneOf(
    "explicit_env",
    "global_opencode_json",
    "global_opencode_jsonc",
    "opencode_db",
  ),
  checked_paths: pathList,
  state_health: oneOf(...STATE_HEALTH),
  state_version: count,
  state_last_update: time,
});

/** "custom 2 check" for the debug key of the second custom definition's check. */
function customCheckKey(key: string, customs: ReadonlyMap<string, number>): string | undefined {
  const id = /^custom_(.+)_check$/su.exec(key)?.[1];
  const number = id === undefined ? undefined : customs.get(id);
  return number === undefined ? undefined : `custom ${number} check`;
}

/** The debug details the provider's allow list has, and a count of the others. */
function debugRows(
  provider: ProviderSnapshot,
  customs: ReadonlyMap<string, number>,
  homeDir: string,
): ReportKvRow[] {
  const rules: DebugRules = {
    ...SETUP_DETAILS,
    ...(PROVIDER_IDS.has(provider.providerId)
      ? DEBUG_DETAILS[provider.providerId as CanonicalQuotaProviderId]
      : {}),
  };
  const rows: ReportKvRow[] = [];
  let hidden = 0;
  for (const item of provider.debug) {
    const customKey = customCheckKey(item.key, customs);
    const rule = customKey
      ? CUSTOM_CHECK
      : Object.hasOwn(rules, item.key)
        ? rules[item.key]
        : undefined;
    const value = ruleValue(rule, item.value, homeDir);
    if (value === undefined) hidden += 1;
    else rows.push({ key: customKey ?? item.key, value });
  }
  if (hidden > 0) {
    rows.push({ key: countText(hidden, "other detail not shown", "other details not shown") });
  }
  return rows;
}

/**
 * "disabled" (turned off in the settings, never fetched) and "unavailable" (only local setup
 * details) win over the state of a check. With "auto" no provider is turned off; with a list,
 * `availability.enabled` says whether the provider is in it.
 */
function sectionState(
  availability: ProviderAvailability,
  provider: ProviderSnapshot | undefined,
  enabledProviders: QuotaStatusReportParams["enabledProviders"],
  nowMs: number,
): string {
  if (enabledProviders !== "auto" && !availability.enabled) return "disabled";
  if (!availability.available) return "unavailable";
  return provider ? providerState(provider, nowMs) : "not checked";
}

/**
 * One provider's section, the same for every provider: state, rows, debug details. Rows show
 * their ledger id, an account number and their facts; debug details show when their provider
 * allows them, and the rest are counted.
 */
function providerSection(
  availability: ProviderAvailability,
  provider: ProviderSnapshot | undefined,
  params: QuotaStatusReportParams,
  homeDir: string,
): ReportSection {
  const nowMs = params.generatedAtMs ?? Date.now();
  const state = sectionState(availability, provider, params.enabledProviders, nowMs);
  const title = providerIdText(availability.id);
  const rows: ReportKvRow[] = [{ key: "state", value: state }];
  if (!provider) return kvSection(title, rows);
  if (provider.checkedAtMs !== undefined) {
    const lastRows =
      provider.okAtMs !== undefined && provider.okAtMs !== provider.checkedAtMs
        ? ` (rows from ${isoText(provider.okAtMs)})`
        : "";
    rows.push({ key: "checked_at", value: `${isoText(provider.checkedAtMs)}${lastRows}` });
  }
  rows.push({ key: "rows", value: String(provider.rows.length) });
  // An account is a login's label (often an email address): it shows as its number.
  const account = numbering();
  const part = numbering();
  const customs = customNumbers(params);
  for (const row of provider.rows.slice(0, ROW_LIST_LIMIT)) {
    const accountText = row.account ? ` (account ${account(row.account)})` : "";
    const id = rowIdText(row, part, customs);
    rows.push({ key: `${id}${accountText}`, value: rowFacts(row), indent: 1 });
  }
  if (provider.rows.length > ROW_LIST_LIMIT) {
    rows.push({ key: `… (${provider.rows.length - ROW_LIST_LIMIT} more)`, indent: 1 });
  }
  rows.push(...debugRows(provider, customs, homeDir));
  return kvSection(title, rows);
}

/** "openai/gpt-5" when OpenCode or the shipped price list knows both ids, else undefined. */
function knownModelText(providerId: string, modelId: string): string | undefined {
  const knownProvider =
    OPENCODE_PROVIDER_IDS.has(providerId) || isBundledPricingProviderId(providerId);
  return knownProvider && knownModelId(modelId) ? `${providerId}/${modelId}` : undefined;
}

/**
 * The models of the last 30 days without a price: their tokens add no cost. A model shows when
 * the shipped price list has its id; the others are counted.
 */
function unpricedRows(usage: UsageReport | null | undefined): ReportKvRow[] {
  if (!usage) return [{ key: "unpriced_30d", value: "(the usage history could not be read)" }];
  const { totals } = usage;
  if (totals.tokens.processed === 0) return [{ key: "unpriced_30d", value: "(no usage)" }];
  const summary = `${formatShare(totals.unpricedShare)} of ${formatTokens(totals.tokens.processed)} tokens`;
  const unpriced = usage.models.filter((model) => !model.priced);
  const rows: ReportKvRow[] = [{ key: "unpriced_30d", value: summary }];
  const listed = unpriced
    .map((model) => ({ model, name: knownModelText(model.providerID, model.modelID) }))
    .filter((item) => item.name !== undefined)
    .slice(0, UNPRICED_LIST_LIMIT);
  for (const { model, name } of listed) {
    rows.push({
      key: name ?? "",
      value: `${formatTokens(model.unpricedTokens)} tokens`,
      indent: 1,
    });
  }
  const others = unpriced.length - listed.length;
  if (others > 0) {
    const text = countText(others, "more unpriced model", "more unpriced models");
    rows.push({ key: `… (${text})`, indent: 1 });
  }
  return rows;
}

const PRICING_UNITS = "USD per 1M tokens";
const PRICING_SOURCE_NAMES: Readonly<Record<string, string>> = {
  bundled: "bundled",
  runtime: "downloaded",
};
const REFRESH_RESULTS = new Set([
  "success",
  "not_modified",
  "skipped_fresh",
  "skipped_throttled",
  "failed",
]);
const PRICING_SELECTIONS = new Set(["auto", "bundled", "runtime"]);

/** The active price list as fixed words: where it came from, its date and its units. */
export function publicPricingMeta(): { source: string; generatedAt: string; units: string } {
  const meta = getPricingSnapshotMeta();
  return {
    source: PRICING_SOURCE_NAMES[getPricingSnapshotSource()] ?? "unknown",
    generatedAt: isoText(meta.generatedAt),
    units: meta.units === PRICING_UNITS ? PRICING_UNITS : "(other units)",
  };
}

async function pricingSection(
  params: QuotaStatusReportParams,
  homeDir: string,
): Promise<ReportSection> {
  const meta = publicPricingMeta();
  const activeSource = getPricingSnapshotSource();
  const { maxAgeMs } = getPricingRefreshPolicy();
  const health = getPricingSnapshotHealth({ maxAgeMs });
  const refreshState = await readPricingRefreshState();
  const configured = PRICING_SELECTIONS.has(params.pricingSnapshotSource)
    ? params.pricingSnapshotSource
    : "(other)";

  const rows: ReportKvRow[] = [
    {
      key: "pricing",
      value: `source=${meta.source} generated_at=${meta.generatedAt} units=${meta.units}`,
    },
    { key: "selection", value: `configured=${configured} active=${meta.source}` },
  ];
  if (configured === "bundled") {
    rows.push({
      key: "selection_note",
      value:
        "bundled config pins the packaged snapshot and ignores runtime refresh for active pricing",
    });
  } else if (configured === "runtime" && activeSource !== "runtime") {
    rows.push({
      key: "selection_note",
      value:
        "runtime config requested the local runtime snapshot, but bundled fallback is active because no valid runtime snapshot is available",
    });
  }
  rows.push(
    {
      key: "runtime_paths",
      value: `snapshot=${pathText(getRuntimePricingSnapshotPath(), homeDir)} refresh_state=${pathText(getRuntimePricingRefreshStatePath(), homeDir)}`,
    },
    {
      key: "staleness",
      value: `age_ms=${fmtInt(health.ageMs)} max_age_ms=${fmtInt(health.maxAgeMs)} stale=${health.stale === true}`,
    },
    {
      key: "refresh_policy",
      value: `auto_refresh_days=${fmtInt(Math.round(maxAgeMs / (24 * 60 * 60 * 1000)))}`,
    },
  );
  if (refreshState) {
    const lastResult = refreshState.lastResult;
    const result = lastResult && REFRESH_RESULTS.has(lastResult) ? lastResult : "(none)";
    rows.push({
      key: "refresh",
      value: `last_attempt_at=${isoText(refreshState.lastAttemptAt)} last_success_at=${isoText(refreshState.lastSuccessAt)} last_failure_at=${isoText(refreshState.lastFailureAt)} last_result=${result}`,
    });
    if (refreshState.lastError) {
      rows.push({ key: "refresh_error", value: errorKind(classifyError(refreshState.lastError)) });
    }
  } else {
    rows.push({ key: "refresh", value: "(no runtime refresh state yet)" });
  }
  rows.push(
    { key: "providers", value: fmtInt(listProviders().length) },
    ...unpricedRows(params.usage),
  );
  return kvSection("pricing_snapshot", rows);
}

/** A path as the report shows it, for the status payload. */
export function statusPathText(path: string, homeDir: string = homedir()): string {
  return pathText(path, homeDir);
}

/** The provider ids this plugin knows, for the status payload. */
export function knownProviderIds(ids: string[] | "auto"): string[] | "auto" {
  return ids === "auto" ? ids : ids.filter((id) => PROVIDER_IDS.has(id));
}

export async function buildQuotaStatusReport(params: QuotaStatusReportParams): Promise<string> {
  return renderPlainTextReport(await buildQuotaStatusReportDocument(params));
}

export async function buildQuotaStatusReportDocument(
  params: QuotaStatusReportParams,
): Promise<ReportDocument> {
  const homeDir = params.homeDir ?? homedir();
  const version = (await getPackageVersion()) ?? "unknown";
  const snapshots = new Map(params.providers.map((provider) => [provider.providerId, provider]));
  const sections: ReportSection[] = [
    settingsSection(params, homeDir),
    providerListSection(params.providerAvailability),
    ...(params.maintainerAnnouncements
      ? [announcementsSection(params.maintainerAnnouncements)]
      : []),
    await pathsSection(homeDir),
    credentialSourceSection(params.credentialSource),
    ...params.providerAvailability.map((availability) =>
      providerSection(availability, snapshots.get(availability.id), params, homeDir),
    ),
    await pricingSection(params, homeDir),
  ];

  return replaceHomeDirWithTildeInDocument(
    {
      heading: commandHeading({
        title: `Quota Status (opencode-quota v${version}) (/quota_status)`,
        detail: `opencode-quota v${version}`,
        generatedAtMs: params.generatedAtMs,
      }),
      sections,
    },
    homeDir,
  );
}
