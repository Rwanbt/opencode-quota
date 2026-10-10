/**
 * The Quota Status report (`/quota_status`, the `quota_status` tool, `opencode-quota status`):
 * where the settings come from, what each enabled provider returned, logins, local files and
 * prices. Every provider section is built the same way from the store's snapshot (state, rows,
 * error, debug details); providers put the facts they want shown in their debug details.
 * Users paste this report into public issues, so the home dir shows as "~" everywhere.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { describeError } from "../core/errors.js";
import { safeDebugValue, safeDetail } from "../core/redact.js";
import type { Amount, ProviderSnapshot, QuotaRow } from "../core/types.js";
import type { UsageReport } from "../core/usage.js";
import type { LoadedSettings, Settings, V5Conversion } from "../settings/index.js";
import { formatShare, formatTokens } from "../view/numbers.js";
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
  /** Every registered provider, enabled or not. */
  providerAvailability: ProviderAvailability[];
  /** The store's snapshot of each enabled and available provider: one section each. */
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

/**
 * The store cuts long details, sometimes inside a home path ("… | /Users/al"). "~" replaces
 * only a whole home dir, so a cut end that holds part of the user name becomes "~" too.
 */
function hideCutHomeDir(text: string, homeDir: string): string {
  const home = homeDir.replace(/[/\\]+$/u, "");
  const userNameStart = Math.max(home.lastIndexOf("/"), home.lastIndexOf("\\")) + 1;
  for (let length = home.length - 1; length > userNameStart; length -= 1) {
    const cutHome = home.slice(0, length);
    if (!text.endsWith(cutHome)) continue;
    const before = text.slice(0, text.length - length);
    if (before === "" || /[\s"'`=([:,|]$/u.test(before)) return `${before}~`;
  }
  return text;
}

function currentModelText(params: QuotaStatusReportParams): string {
  if (params.currentModel) return params.currentModel;
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
function settingsSection(params: QuotaStatusReportParams): ReportSection {
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
    { key: "currentModel", value: currentModelText(params) },
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

function credentialSourceSection(diagnostics: CredentialSourceDiagnostics): ReportSection {
  const failures = diagnostics.failures.map((failure) =>
    [failure.integrationId, failure.label, failure.category, failure.detail]
      .map((part) => sanitizeSingleLineDisplayText(part))
      .join(":"),
  );
  return kvSection("credential_source", [
    { key: "source", value: diagnostics.state === "bound" ? diagnostics.kind : "unbound" },
    { key: "list_error", value: diagnostics.lastListError?.detail ?? "(none)" },
    { key: "failures", value: joinOrNone(failures) },
  ]);
}

function amountText(amount: Amount): string {
  const { unit } = amount;
  if (unit.kind === "currency") return `${amount.decimal} ${unit.code}`;
  if (unit.kind === "count") return `${amount.decimal} ${unit.unit}`;
  return `${unit.symbol}${amount.decimal}`;
}

/** A row's numbers in one line, for example "43% left, 57/100 requests, resets 2026-…". */
function rowFacts(row: QuotaRow): string {
  const parts: string[] = [row.label];
  if (row.percentRemaining !== undefined) parts.push(`${Math.round(row.percentRemaining)}% left`);
  if (row.used && row.limit) parts.push(`${row.used.decimal}/${amountText(row.limit)}`);
  if (row.amount) parts.push(amountText(row.amount));
  if (row.text) parts.push(row.text);
  if (row.flag !== undefined) parts.push(row.flag ? "yes" : "no");
  if (row.resetsAt) parts.push(`resets ${row.resetsAt}`);
  return parts.join(", ");
}

/** "ok", or the error's short words and code; "partial" when rows came with the error. */
function providerState(provider: ProviderSnapshot, nowMs: number): string {
  if (provider.checkedAtMs === undefined) return provider.refreshing ? "checking" : "not checked";
  const error = provider.error;
  if (!error) return "ok";
  const words = `${describeError(error, provider.label, nowMs)} (${error.code})`;
  return provider.rows.length > 0 ? `partial: ${words}` : `error: ${words}`;
}

/** One provider's section, the same for every provider: state, rows, error, debug details. */
function providerSection(
  provider: ProviderSnapshot,
  nowMs: number,
  homeDir: string,
): ReportSection {
  const rows: ReportKvRow[] = [{ key: "state", value: providerState(provider, nowMs) }];
  if (provider.checkedAtMs !== undefined) {
    const lastRows =
      provider.okAtMs !== undefined && provider.okAtMs !== provider.checkedAtMs
        ? ` (rows from ${isoOrNone(provider.okAtMs)})`
        : "";
    rows.push({ key: "checked_at", value: `${isoOrNone(provider.checkedAtMs)}${lastRows}` });
  }
  // The provider's own messages are in its debug "error" details; a fetch that failed outright
  // (a timeout, a crash) has only the error's detail.
  const detail = provider.error?.detail;
  if (detail && !provider.debug.some((item) => item.key === "error")) {
    rows.push({
      key: "error_detail",
      value: hideCutHomeDir(safeDetail(detail, Infinity), homeDir),
    });
  }
  rows.push({ key: "rows", value: String(provider.rows.length) });
  for (const row of provider.rows.slice(0, ROW_LIST_LIMIT)) {
    const id = row.account ? `${row.id} (${row.account})` : row.id;
    const facts = rowFacts(row);
    rows.push({
      key: sanitizeSingleLineDisplayText(id),
      value: sanitizeSingleLineDisplayText(facts),
      indent: 1,
    });
  }
  if (provider.rows.length > ROW_LIST_LIMIT) {
    rows.push({ key: `… (${provider.rows.length - ROW_LIST_LIMIT} more)`, indent: 1 });
  }
  // The store already made these safe; again here, as any snapshot may be shown.
  for (const item of provider.debug) {
    const value = hideCutHomeDir(safeDebugValue(item.key, item.value, Infinity), homeDir);
    rows.push({ key: safeDetail(item.key, 64), value });
  }
  return kvSection(provider.providerId, rows);
}

/** The models of the last 30 days without a price: their tokens add no cost. */
function unpricedRows(usage: UsageReport | null | undefined): ReportKvRow[] {
  if (!usage) return [{ key: "unpriced_30d", value: "(the usage history could not be read)" }];
  const { totals } = usage;
  if (totals.tokens.processed === 0) return [{ key: "unpriced_30d", value: "(no usage)" }];
  const summary = `${formatShare(totals.unpricedShare)} of ${formatTokens(totals.tokens.processed)} tokens`;
  const unpriced = usage.models.filter((model) => !model.priced);
  const rows: ReportKvRow[] = [{ key: "unpriced_30d", value: summary }];
  for (const model of unpriced.slice(0, UNPRICED_LIST_LIMIT)) {
    const key = sanitizeSingleLineDisplayText(`${model.providerID}/${model.modelID}`);
    rows.push({ key, value: `${formatTokens(model.unpricedTokens)} tokens`, indent: 1 });
  }
  if (unpriced.length > UNPRICED_LIST_LIMIT) {
    rows.push({ key: `… (${unpriced.length - UNPRICED_LIST_LIMIT} more)`, indent: 1 });
  }
  return rows;
}

async function pricingSection(params: QuotaStatusReportParams): Promise<ReportSection> {
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
    if (refreshState.lastError) rows.push({ key: "refresh_error", value: refreshState.lastError });
  } else {
    rows.push({ key: "refresh", value: "(no runtime refresh state yet)" });
  }
  rows.push({ key: "providers", value: listProviders().join(",") }, ...unpricedRows(params.usage));
  return kvSection("pricing_snapshot", rows);
}

export async function buildQuotaStatusReport(params: QuotaStatusReportParams): Promise<string> {
  return renderPlainTextReport(await buildQuotaStatusReportDocument(params));
}

export async function buildQuotaStatusReportDocument(
  params: QuotaStatusReportParams,
): Promise<ReportDocument> {
  const homeDir = params.homeDir ?? homedir();
  const nowMs = params.generatedAtMs ?? Date.now();
  const version = (await getPackageVersion()) ?? "unknown";
  const sections: ReportSection[] = [
    settingsSection(params),
    providerListSection(params.providerAvailability),
    ...(params.maintainerAnnouncements
      ? [announcementsSection(params.maintainerAnnouncements)]
      : []),
    await pathsSection(),
    credentialSourceSection(params.credentialSource),
    ...params.providers.map((provider) => providerSection(provider, nowMs, homeDir)),
    await pricingSection(params),
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
