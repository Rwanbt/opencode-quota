/**
 * The Quota Status report (`/quota_status`, the `quota_status` tool, `opencode-quota status`):
 * where the settings come from, what each known provider returned, logins, local files and
 * prices. Every provider section is built the same way from the store's snapshot (state, rows,
 * error, debug details); providers put the facts they want shown in their debug details.
 *
 * Users paste this report into public issues, so it shows only structured values: states,
 * numbers, times, ids from this plugin's tables and the snapshot, an error's code, HTTP status
 * and our own words, and paths. Free text from a provider or a login (messages, response
 * bodies, names, URLs) is never shown, only that it was there. The home dir shows as "~", and
 * every debug value also passes `publicDetail`.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { classifyError, describeError, LOCAL_TOOLS } from "../core/errors.js";
import { publicDebugValue, publicDetail } from "../core/redact.js";
import type { Amount, DebugDetail, ProviderSnapshot, QuotaError, QuotaRow } from "../core/types.js";
import type { UsageReport } from "../core/usage.js";
import type { LoadedSettings, Settings, V5Conversion } from "../settings/index.js";
import { formatShare, formatTokens } from "../view/format.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { replaceHomeDirWithTildeInDocument } from "./home-dir-display.js";
import type { MaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
import {
  getPricingRefreshPolicy,
  getPricingSnapshotHealth,
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  listProviders,
  type PricingSnapshotSource,
  readPricingRefreshState,
} from "./modelsdev-pricing.js";
import type { CredentialSourceDiagnostics } from "./opencode-auth.js";
import { getOpenCodeDbPath } from "./opencode-db-path.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getOpenCodeDbStats } from "./opencode-storage.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import {
  isMaintainedQuotaProviderTuning,
  type QuotaProviderDefinition,
} from "./quota-providers.js";
import { getLocalQuotaProviderStatePath } from "./quota-providers-local.js";
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
/** Shown instead of a value that is free text. */
const NOT_SHOWN = "(free text, not shown)";

/** A model, login or integration id: one word of letters, digits and `._:/@+-`. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
/** A row id from the store: the provider id, then the row key. */
const ROW_ID = /^[a-z0-9-]+\.[A-Za-z0-9_.-]{1,150}$/u;
/** A debug key as providers write them: "auth_state", "custom_team-a_check", "alibaba tier". */
const DEBUG_KEY = /^(?=.{1,64}$)[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/u;
/** Debug keys whose value lists files: "binary_path", "api_key_checked_paths", "config_matches". */
const PATH_KEY = /(?:^|_)(?:path|paths|matches|commands)$/u;
/** Words of a debug key whose value is free text: "auth_error", "live_error_1", "message". */
const FREE_TEXT_KEY_WORDS = new Set(["error", "errors", "message", "note", "reason", "detail"]);
/** Last words of a debug key whose value names a person or an org: "console_org". */
const IDENTITY_KEY_ENDS = new Set([
  "org",
  "organization",
  "enterprise",
  "filter",
  "label",
  "email",
]);

/**
 * One word of a structured value: a lower-case id or state ("configured", "five_hour",
 * "opencode.json", "api.github.com"), a number, amount, percent or "used/limit", an ISO time,
 * env:NAME, a command-line flag, or a marker the filters wrote.
 */
const STRUCTURED_WORD = new RegExp(
  `^(?:${[
    "[a-z0-9][a-z0-9_.:+-]{0,47}",
    String.raw`\$?-?\d[\d,]*(?:\.\d+)?%?(?:/\$?\d[\d,]*(?:\.\d+)?)?`,
    String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})`,
    "env:[A-Z][A-Z0-9_]{0,63}",
    "--?[a-z][a-z0-9-]{0,31}",
    String.raw`\((?:none|unknown)\)`,
    String.raw`\[(?:redacted|id|email)\]`,
  ].join("|")})$`,
  "u",
);

/**
 * A file path as this plugin builds them: under the home dir, absolute, or on a drive, maybe
 * JSON-quoted. A space may only stand inside the path ("Application Support/opencode"), so a
 * path followed by words is not one.
 */
const PATH = /^"?(?:~|[A-Za-z]:|[/\\])[^\s|"'<>`]*(?: [^\s|"'<>`/\\]*[/\\][^\s|"'<>`]*)*"?$/u;

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
  return Math.trunc(n).toLocaleString("en-US");
}

function isoOrNone(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString() : "(none)";
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(" | ") : "(none)";
}

function kvSection(id: string, rows: ReportKvRow[]): ReportSection {
  return { id, title: `${id}:`, blocks: [{ kind: "kv", rows }] };
}

/** An id as it is, or a note that it is not one (free text). */
function idText(id: string, homeDir: string): string {
  return ID.test(id) ? publicDetail(id, Infinity, homeDir) : NOT_SHOWN;
}

function currentModelText(params: QuotaStatusReportParams, homeDir: string): string {
  if (params.currentModel) return idText(params.currentModel, homeDir);
  if (params.sessionModelLookup === "not_found") return "(error: session.get returned no modelID)";
  if (params.sessionModelLookup === "no_session") return "(no session available)";
  return "(unknown)";
}

/**
 * A custom provider definition's safe identity: never its URL, adapter or key. A local estimate
 * names its counter file; a tuned maintained provider shows its own in that provider's section.
 */
function customProviderText(definition: QuotaProviderDefinition): string {
  const tuned = isMaintainedQuotaProviderTuning(definition);
  const parts = [
    `provider_id=${definition.providerId}`,
    `mode=${definition.mode}`,
    ...(definition.mode === "remote-api"
      ? [`format=${definition.format}`, `env_name=${definition.apiKeyEnv ?? "(none)"}`]
      : [`limits=${definition.windows.map((w) => `${w.id}:${w.requestLimit}`).join(",")}`]),
    `coverage=${definition.modelIds ? definition.modelIds.join(",") : "all_models"}`,
    ...(definition.mode === "local-estimate" && !tuned
      ? [`state_path=${getLocalQuotaProviderStatePath(definition.id)}`]
      : []),
    ...(tuned ? [`tunes=${definition.id}`] : []),
  ];
  return parts.map((part) => sanitizeSingleLineDisplayText(part)).join(" ");
}

function settingsFileText(params: QuotaStatusReportParams): string {
  const { path, exists } = params.settings;
  if (exists) return `${path} (exists)`;
  if (params.conversion) return `${path} (missing; the v5 settings are converted in memory)`;
  return `${path} (missing; using the defaults)`;
}

/** Where the v5 settings went: written to settings.jsonc, or why not. */
function conversionRows(conversion: V5Conversion): ReportKvRow[] {
  const { sources, converted, dropped, invalid } = conversion;
  const counts = `${converted.length} converted, ${dropped.length} dropped, ${invalid.length} invalid`;
  const outcome = conversion.written
    ? "written to settings.jsonc"
    : (conversion.notWrittenReason ?? "converted in memory");
  const rows: ReportKvRow[] = [
    { key: "conversion", value: `from ${joinOrNone(sources)} (${counts}); ${outcome}` },
  ];
  const notes = [
    ...converted.filter((item) => item.note).map((item) => `${item.key}: ${item.note}`),
    ...dropped.map((item) => `${item.key} dropped: ${item.reason}`),
    ...invalid.map((item) => `${item.key} invalid: ${item.reason}`),
    ...conversion.notes,
  ];
  for (const note of notes) {
    rows.push({ key: "conversion_note", value: sanitizeSingleLineDisplayText(note) });
  }
  return rows;
}

/** The settings file, what is wrong in it, the v5 conversion, and what quota is set to do. */
function settingsSection(params: QuotaStatusReportParams, homeDir: string): ReportSection {
  const enabled = params.enabledProviders;
  const rows: ReportKvRow[] = [{ key: "settings_file", value: settingsFileText(params) }];
  for (const issue of params.settings.issues) {
    const text = `${issue.key}: ${issue.message}`;
    rows.push({ key: "settings_issue", value: sanitizeSingleLineDisplayText(text) });
  }
  if (params.conversion) rows.push(...conversionRows(params.conversion));
  rows.push({
    key: "project_settings",
    value: "none: the settings are global; v5 project-scope files are not read",
  });
  if (params.settings.notRead.length > 0) {
    rows.push({ key: "not_read", value: joinOrNone(params.settings.notRead) });
  }
  rows.push(
    { key: "enabledProviders", value: enabled === "auto" ? "(auto)" : joinOrNone(enabled) },
    { key: "onlyCurrentModel", value: String(params.onlyCurrentModel) },
    { key: "currentModel", value: currentModelText(params, homeDir) },
    { key: "workspace_root", value: params.workspaceRoot },
  );
  for (const definition of params.quotaProviders ?? []) {
    rows.push({ key: `provider_${definition.id}`, value: customProviderText(definition) });
  }
  return kvSection("settings", rows);
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
      return { key: provider.id, value: bits.join(" ") };
    }),
  );
}

function announcementsSection(
  announcements: NonNullable<QuotaStatusReportParams["maintainerAnnouncements"]>,
): ReportSection {
  const { config, summary } = announcements;
  return kvSection("maintainer_announcements", [
    { key: "enabled", value: String(config.enabled) },
    { key: "home", value: String(config.home) },
    { key: "home_frequency", value: config.homeFrequency },
    { key: "source", value: summary.source },
    { key: "network", value: String(summary.network) },
    { key: "active", value: String(summary.activeCount) },
    { key: "future", value: String(summary.futureCount) },
    { key: "expired", value: String(summary.expiredCount) },
  ]);
}

async function pathsSection(): Promise<ReportSection> {
  const dirs = getOpencodeRuntimeDirs();
  const dbPath = getOpenCodeDbPath();
  let db = `path=${dbPath} present=false`;
  if (await pathExists(dbPath)) {
    const stats = await getOpenCodeDbStats();
    db = `path=${dbPath} present=true sessions=${fmtInt(stats.sessionCount)} messages=${fmtInt(stats.messageCount)} assistant_messages=${fmtInt(stats.assistantMessageCount)}`;
  }
  return kvSection("paths", [
    {
      key: "opencode_dirs",
      value: `data=${dirs.dataDir} config=${dirs.configDir} cache=${dirs.cacheDir} state=${dirs.stateDir}`,
    },
    { key: "opencode.db", value: `${db} (session and token history)` },
  ]);
}

/** An error's code and HTTP status: "provider_error, http 503". */
function errorKind(error: QuotaError): string {
  return error.status === undefined ? error.code : `${error.code}, http ${error.status}`;
}

/**
 * The login source and its failures: each failed login's integration id, failure kind and
 * time, never its label (often an email address) or the error's own words.
 */
function credentialSourceSection(
  diagnostics: CredentialSourceDiagnostics,
  homeDir: string,
): ReportSection {
  const failures = diagnostics.failures.map(
    (failure) =>
      `${idText(failure.integrationId, homeDir)}: ${failure.category} at ${isoOrNone(failure.at)}`,
  );
  const listError = diagnostics.lastListError;
  const listErrorText = listError
    ? `${errorKind(classifyError(listError.detail))} at ${isoOrNone(listError.at)}`
    : "(none)";
  return kvSection("credential_source", [
    { key: "source", value: diagnostics.state === "bound" ? diagnostics.kind : "unbound" },
    { key: "list_error", value: listErrorText },
    { key: "failures", value: joinOrNone(failures) },
  ]);
}

function amountText(amount: Amount): string {
  const { unit } = amount;
  if (unit.kind === "currency") return `${amount.decimal} ${unit.code}`;
  if (unit.kind === "count") return `${amount.decimal} ${unit.unit}`;
  return `${unit.symbol}${amount.decimal}`;
}

/**
 * A row's facts in one line, for example "window=five_hour, 43% left, 57/100 request,
 * resets 2026-…". Its label and text are the provider's words: a text value is only noted.
 */
function rowFacts(row: QuotaRow): string {
  const parts: string[] = [];
  if (row.window) parts.push(`window=${row.window}`);
  if (row.percentRemaining !== undefined) parts.push(`${Math.round(row.percentRemaining)}% left`);
  if (row.used && row.limit) parts.push(`${row.used.decimal}/${amountText(row.limit)}`);
  if (row.amount) parts.push(amountText(row.amount));
  if (row.flag !== undefined) parts.push(row.flag ? "yes" : "no");
  if (row.text !== undefined) parts.push("text not shown");
  if (row.resetsAt) parts.push(`resets ${row.resetsAt}`);
  return parts.join(", ");
}

/**
 * The error in our own words, with its code and HTTP status: "Provider error 503
 * (provider_error, http 503)". A local tool is named only when it is one this plugin knows.
 */
function errorText(error: QuotaError, providerId: string, nowMs: number): string {
  const tool =
    error.tool !== undefined && LOCAL_TOOLS.includes(error.tool) ? error.tool : undefined;
  const known: QuotaError = { ...error, tool };
  const words = describeError(known, getQuotaProviderDisplayLabel(providerId), nowMs);
  return `${words} (${errorKind(error)})`;
}

/** "ok", or the error in our words; "partial" when rows came with the error. */
function providerState(provider: ProviderSnapshot, nowMs: number): string {
  if (provider.checkedAtMs === undefined) return provider.refreshing ? "checking" : "not checked";
  const error = provider.error;
  if (!error) return "ok";
  const words = errorText(error, provider.providerId, nowMs);
  return provider.rows.length > 0 ? `partial: ${words}` : `error: ${words}`;
}

/** Structured words, split on spaces, commas and "|"; a word may be `name=value`. */
function isStructuredWords(text: string): boolean {
  const words = text.split(/[\s,|]+/u).filter(Boolean);
  return (
    words.length > 0 &&
    words.every((word) =>
      STRUCTURED_WORD.test(/^[a-z][a-z0-9_]{0,47}=(.+)$/u.exec(word)?.[1] ?? word),
    )
  );
}

/**
 * A path, or a command line of paths and structured words, JSON-quoted where they hold spaces:
 * "~/.config/x.json", "env:CHUTES_API_KEY", `"~/My Tools/claude" auth status --json`.
 */
function isPathOrCommand(part: string): boolean {
  if (PATH.test(part)) return true;
  const words = part.match(/"(?:[^"\\]|\\.)*"|[^\s"]+/gu) ?? [];
  return words.length > 0 && words.every((word) => PATH.test(word) || isStructuredWords(word));
}

/** Paths and commands joined by " | ": "env:CHUTES_API_KEY | ~/.config/x.json". */
function isPathList(text: string): boolean {
  return text.split(" | ").every(isPathOrCommand);
}

/**
 * True when a debug value is a structured fact the report may show. A value whose key names
 * free text or a person never is; a key naming files may list paths, and so may the first
 * `path=` or `…_paths=` pair of a value and what follows it ("checked_paths=~/a.json | ~/b.json").
 */
function isStructuredDetail(item: DebugDetail): boolean {
  const words = item.key.toLowerCase().split(/[^a-z0-9]+/u);
  if (words.some((word) => FREE_TEXT_KEY_WORDS.has(word))) return false;
  if (IDENTITY_KEY_ENDS.has(words.at(-1) ?? "")) return false;
  if (PATH_KEY.test(item.key)) return isPathList(item.value);
  const paths = /^(.*?) ?\b(?:[a-z_]*_)?paths?=(.*)$/u.exec(item.value);
  if (paths) {
    const [, before = "", list = ""] = paths;
    return (before === "" || isStructuredWords(before)) && isPathList(list);
  }
  return isStructuredWords(item.value);
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
 * their id, an account number and their facts; a debug detail that is free text shows only its
 * key. Every debug value shown passes `publicDetail`, even when the store already did.
 */
function providerSection(
  availability: ProviderAvailability,
  provider: ProviderSnapshot | undefined,
  params: QuotaStatusReportParams,
  homeDir: string,
): ReportSection {
  const nowMs = params.generatedAtMs ?? Date.now();
  const state = sectionState(availability, provider, params.enabledProviders, nowMs);
  const rows: ReportKvRow[] = [{ key: "state", value: state }];
  if (!provider) return kvSection(availability.id, rows);
  if (provider.checkedAtMs !== undefined) {
    const lastRows =
      provider.okAtMs !== undefined && provider.okAtMs !== provider.checkedAtMs
        ? ` (rows from ${isoOrNone(provider.okAtMs)})`
        : "";
    rows.push({ key: "checked_at", value: `${isoOrNone(provider.checkedAtMs)}${lastRows}` });
  }
  rows.push({ key: "rows", value: String(provider.rows.length) });
  // An account is a login's label (often an email address): it shows as its number.
  const accounts = [...new Set(provider.rows.flatMap((row) => (row.account ? [row.account] : [])))];
  for (const row of provider.rows.slice(0, ROW_LIST_LIMIT)) {
    const id = ROW_ID.test(row.id) ? row.id : "(row id not shown)";
    const account = row.account ? ` (account ${accounts.indexOf(row.account) + 1})` : "";
    rows.push({ key: `${id}${account}`, value: rowFacts(row), indent: 1 });
  }
  if (provider.rows.length > ROW_LIST_LIMIT) {
    rows.push({ key: `… (${provider.rows.length - ROW_LIST_LIMIT} more)`, indent: 1 });
  }
  for (const item of provider.debug) {
    if (!DEBUG_KEY.test(item.key)) continue;
    const value = isStructuredDetail(item)
      ? publicDebugValue(item.key, item.value, Infinity, homeDir)
      : NOT_SHOWN;
    rows.push({ key: item.key, value });
  }
  return kvSection(availability.id, rows);
}

/**
 * The models of the last 30 days without a price: their tokens add no cost. A provider or
 * model id from OpenCode's history shows when it is one word.
 */
function unpricedRows(usage: UsageReport | null | undefined, homeDir: string): ReportKvRow[] {
  if (!usage) return [{ key: "unpriced_30d", value: "(the usage history could not be read)" }];
  const { totals } = usage;
  if (totals.tokens.processed === 0) return [{ key: "unpriced_30d", value: "(no usage)" }];
  const summary = `${formatShare(totals.unpricedShare)} of ${formatTokens(totals.tokens.processed)} tokens`;
  const unpriced = usage.models.filter((model) => !model.priced);
  const rows: ReportKvRow[] = [{ key: "unpriced_30d", value: summary }];
  for (const model of unpriced.slice(0, UNPRICED_LIST_LIMIT)) {
    const key = idText(`${model.providerID}/${model.modelID}`, homeDir);
    rows.push({ key, value: `${formatTokens(model.unpricedTokens)} tokens`, indent: 1 });
  }
  if (unpriced.length > UNPRICED_LIST_LIMIT) {
    rows.push({ key: `… (${unpriced.length - UNPRICED_LIST_LIMIT} more)`, indent: 1 });
  }
  return rows;
}

async function pricingSection(
  params: QuotaStatusReportParams,
  homeDir: string,
): Promise<ReportSection> {
  const meta = getPricingSnapshotMeta();
  const activeSource = getPricingSnapshotSource();
  const { maxAgeMs } = getPricingRefreshPolicy();
  const health = getPricingSnapshotHealth({ maxAgeMs });
  const refreshState = await readPricingRefreshState();
  const configured = params.pricingSnapshotSource;

  const rows: ReportKvRow[] = [
    {
      key: "pricing",
      value: `source=${meta.source} active_source=${activeSource} generated_at=${isoOrNone(meta.generatedAt)} units=${meta.units}`,
    },
    { key: "selection", value: `configured=${configured} active=${activeSource}` },
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
      value: `snapshot=${getRuntimePricingSnapshotPath()} refresh_state=${getRuntimePricingRefreshStatePath()}`,
    },
    {
      key: "staleness",
      value: `age_ms=${fmtInt(health.ageMs)} max_age_ms=${fmtInt(health.maxAgeMs)} stale=${health.stale}`,
    },
    {
      key: "refresh_policy",
      value: `auto_refresh_days=${fmtInt(Math.round(maxAgeMs / (24 * 60 * 60 * 1000)))}`,
    },
  );
  if (refreshState) {
    rows.push({
      key: "refresh",
      value: `last_attempt_at=${isoOrNone(refreshState.lastAttemptAt)} last_success_at=${isoOrNone(refreshState.lastSuccessAt)} last_failure_at=${isoOrNone(refreshState.lastFailureAt)} last_result=${refreshState.lastResult ?? "(none)"}`,
    });
    if (refreshState.lastError) {
      rows.push({ key: "refresh_error", value: errorKind(classifyError(refreshState.lastError)) });
    }
  } else {
    rows.push({ key: "refresh", value: "(no runtime refresh state yet)" });
  }
  rows.push(
    { key: "providers", value: listProviders().join(",") },
    ...unpricedRows(params.usage, homeDir),
  );
  return kvSection("pricing_snapshot", rows);
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
    await pathsSection(),
    credentialSourceSection(params.credentialSource, homeDir),
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
