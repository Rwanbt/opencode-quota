/**
 * The reports of the quota slash commands, the `quota_status` tool and `opencode-quota status`:
 * `/quota` from the quota snapshot, `/quota_status`, `/quota_announcements`,
 * `/pricing_refresh` and the token reports. Each reads the server settings the host holds now.
 */
import {
  loadProviderSource,
  type ProviderSourceHost,
  providerContext,
} from "../core/provider-source.js";
import { matchesQuotaProviderCurrentSelection } from "../core/selection.js";
import { createQuotaStore } from "../core/store.js";
import type { DebugDetail, ProviderSnapshot, QuotaSnapshot, SessionModel } from "../core/types.js";
import { type UsageReport, usageReport } from "../core/usage.js";
import { getProviders } from "../providers/registry.js";
import type { V5Conversion } from "../settings/index.js";
import { DEFAULT_WORDS } from "../view/format.js";
import { type RowSettings, type SurfaceRows, visibleGroups } from "../view/select.js";
import { plainLines } from "../view/text.js";
import { API_KEY_VENDORS, getApiKeyDiagnostics } from "./api-key-resolver.js";
import {
  formatYmd,
  parseQuotaBetweenArgs,
  startOfLocalDayMs,
  startOfNextLocalDayMs,
} from "./command-parsing.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "./entries.js";
import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  getMaintainerAnnouncementsSummary,
} from "./maintainer-announcements.js";
import {
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot,
  type PricingRefreshResult,
  type PricingSnapshotSource,
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
} from "./modelsdev-pricing.js";
import { getCredentialSourceDiagnostics } from "./opencode-auth.js";
import { getQuotaProviderDisplayLabel, getQuotaProviderRuntimeIds } from "./provider-metadata.js";
import {
  QUOTA_DIALOG_COMMANDS_BY_ID,
  type QuotaDialogCommandId,
  type QuotaDialogCommandOutputResult,
  TOKEN_REPORT_COMMANDS,
  type TokenReportCommandId,
  type TokenReportCommandSpec,
} from "./quota-dialog-command-specs.js";
import {
  aggregateUsage,
  resolveSessionTree,
  SessionNotFoundError,
  type SessionTreeNode,
} from "./quota-stats.js";
import { buildQuotaStatsReportDocument } from "./quota-stats-format.js";
import { buildQuotaStatusReportDocument } from "./quota-status.js";
import {
  commandHeading,
  messageDocument,
  type ReportDocument,
  type ReportKvRow,
  renderMarkdownReport,
  renderPlainTextReport,
} from "./report-document.js";
import { getPackageVersion } from "./version.js";

// Token report model names are capped at the length of this reference model.
const TUI_TOKEN_REPORT_MODEL_NAME_WIDTH_REFERENCE = "gemini-3-pro-preview";
const TUI_TOKEN_REPORT_MODEL_MAX_WIDTH = TUI_TOKEN_REPORT_MODEL_NAME_WIDTH_REFERENCE.length;

const TOKEN_REPORT_COMMANDS_BY_ID: ReadonlyMap<TokenReportCommandId, TokenReportCommandSpec> =
  (() => {
    const map = new Map<TokenReportCommandId, TokenReportCommandSpec>();
    for (const spec of TOKEN_REPORT_COMMANDS) {
      map.set(spec.id, spec);
    }
    return map;
  })();

function isTokenReportCommand(cmd: string): cmd is TokenReportCommandId {
  return TOKEN_REPORT_COMMANDS_BY_ID.has(cmd as TokenReportCommandId);
}

/** A command's report: the document the TUI renders and the text everything else shows. */
type CommandReport = { document: ReportDocument; output: string };

function plainTextReport(document: ReportDocument): CommandReport {
  return { document, output: renderPlainTextReport(document) };
}

/** `/quota` and `opencode-quota show` list every row of every provider. */
const EVERY_ROW: SurfaceRows = { enabled: true, hidden: [], providerOrder: [], rowOrder: {} };
const EVERY_ROW_SETTINGS: RowSettings = {
  labels: {},
  window: {},
  surfaces: { sidebar: EVERY_ROW, collapsed: EVERY_ROW, statusLine: EVERY_ROW, toast: EVERY_ROW },
};

/**
 * The quota lines `/quota` and `opencode-quota show` print, in the snapshot's words: a line per
 * row, a line per provider problem, then the session's tokens when the snapshot has them.
 */
export function quotaReportLines(snapshot: QuotaSnapshot, nowMs: number): string[] {
  const words = snapshot.words ?? DEFAULT_WORDS;
  const groups = visibleGroups(snapshot, EVERY_ROW_SETTINGS, "toast", words);
  const sessionTokens = snapshot.sessionTokens ? { sessionTokens: snapshot.sessionTokens } : {};
  return plainLines({ groups, words, nowMs, ...sessionTokens }).map(sanitizeDisplayText);
}

function quotaCommandReport(snapshot: QuotaSnapshot, nowMs: number): CommandReport {
  const lines = quotaReportLines(snapshot, nowMs);
  if (lines.length === 0) {
    const reason =
      snapshot.providers.length === 0
        ? "No quota provider is enabled and available. Make sure you are logged in to a supported provider (Copilot, OpenAI, etc.)."
        : "No quota provider serves the session's current model.";
    return plainTextReport(
      messageDocument(`Quota unavailable\n\n${reason}\n\nRun /quota_status for diagnostics.`),
    );
  }
  return plainTextReport({
    heading: { line: "Quota" },
    sections: [{ id: "quota", blocks: [{ kind: "lines", lines }] }],
  });
}

/** Starts a models.dev price refresh when due and waits for it at most `maxWaitMs`. */
export async function kickPricingRefresh(params: {
  reason: "init" | "tokens" | "status";
  maxWaitMs?: number;
  snapshotSelection: PricingSnapshotSource;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  try {
    const refreshPromise = maybeRefreshPricingSnapshot({
      reason: params.reason,
      snapshotSelection: params.snapshotSelection,
    });
    const guardedRefreshPromise = refreshPromise.catch(() => undefined);
    if (!params.maxWaitMs || params.maxWaitMs <= 0) {
      void guardedRefreshPromise;
      return;
    }

    await Promise.race([
      guardedRefreshPromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, params.maxWaitMs);
      }),
    ]);
  } catch (error) {
    await params.log?.("Pricing refresh failed", {
      reason: params.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function buildQuotaReport(params: {
  title: string;
  titleDetail?: string;
  sinceMs?: number;
  untilMs?: number;
  sessionID: string;
  topModels?: number;
  topSessions?: number;
  filterSessionID?: string;
  filterSessionIDs?: string[];
  sessionOnly?: boolean;
  reportKind?: "standard" | "session" | "session_tree";
  sessionTree?: {
    rootSessionID: string;
    nodes: SessionTreeNode[];
  };
  generatedAtMs: number;
}): Promise<CommandReport> {
  const result = await aggregateUsage({
    sinceMs: params.sinceMs,
    untilMs: params.untilMs,
    sessionID: params.filterSessionID,
    sessionIDs: params.filterSessionIDs,
  });
  const document = buildQuotaStatsReportDocument({
    title: params.title,
    titleDetail: params.titleDetail,
    result,
    topModels: params.topModels,
    topSessions: params.topSessions,
    focusSessionID: params.sessionID,
    sessionOnly: params.sessionOnly,
    reportKind: params.reportKind,
    sessionTree: params.sessionTree,
    generatedAtMs: params.generatedAtMs,
    tableOptions: {
      compactHeaders: true,
      modelNameMaxWidth: TUI_TOKEN_REPORT_MODEL_MAX_WIDTH,
    },
  });
  return { document, output: renderMarkdownReport(document) };
}

/** Where the settings come from and what they say about providers and prices. */
export interface QuotaStatusReportConfigPayload {
  settingsPath: string;
  settingsFileExists: boolean;
  enabledProviders: string[] | "auto";
  onlyCurrentModel: boolean;
  pricingSnapshotSource: PricingSnapshotSource;
}

export interface QuotaStatusReportPricingPayload {
  selection: PricingSnapshotSource;
  activeSource: string;
  snapshot: {
    source: string;
    generatedAt: string | null;
    units: string;
  };
  snapshotPath: string;
  refreshStatePath: string;
}

export interface QuotaStatusReportPayload {
  version: string;
  generatedAt: string;
  config: QuotaStatusReportConfigPayload;
  providers: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    matchesCurrentModel?: boolean;
  }>;
  pricing: QuotaStatusReportPricingPayload;
  /** One per enabled and available provider: ok when its check had no error. */
  liveProbes: Array<{ id: string; ok: boolean }>;
}

export interface QuotaStatusReportData {
  document: ReportDocument;
  output: string;
  payload: QuotaStatusReportPayload;
  hasComparableProviderData: boolean;
}

/**
 * A fresh check of every enabled and available provider (or only `providerId`), through a
 * store of its own that keeps nothing: the same providers, rows, errors and debug details the
 * plugin's store would hold.
 */
export async function checkProviders(
  host: ProviderSourceHost,
  providerId?: string,
): Promise<QuotaSnapshot> {
  const store = createQuotaStore({ source: () => loadProviderSource(host), file: null });
  try {
    const providerIds = providerId ? [providerId] : undefined;
    const snapshot = await store.refresh({ reason: "manual", providerIds });
    const providers = snapshot.providers.filter(
      (provider: ProviderSnapshot) => !providerId || provider.providerId === providerId,
    );
    return { ...snapshot, providers };
  } finally {
    await store.dispose();
  }
}

type ProviderCheck = { provider: QuotaProvider; enabled: boolean; available: boolean };

async function isAvailable(provider: QuotaProvider, ctx: QuotaProviderContext): Promise<boolean> {
  try {
    return await provider.isAvailable(ctx);
  } catch {
    return false;
  }
}

/**
 * What an unavailable provider's setup looks like, from local checks only: whether OpenCode
 * lists the provider and, for an API-key provider, where its key was looked for. No quota
 * request is made.
 */
async function localSetupDetails(
  providerId: string,
  ctx: QuotaProviderContext,
): Promise<DebugDetail[]> {
  const details: DebugDetail[] = [];
  const runtimeIds = getQuotaProviderRuntimeIds(providerId);
  if (runtimeIds.length > 0) {
    let listed: string;
    try {
      const openCodeIds = await ctx.resolveRuntimeProviderIds();
      const found = runtimeIds.filter((id) => openCodeIds.has(id));
      listed =
        found.length > 0 ? `yes (${found.join(", ")})` : `no (looked for ${runtimeIds.join(", ")})`;
    } catch {
      listed = "(OpenCode's provider list could not be read)";
    }
    details.push({ key: "opencode_provider", value: listed });
  }
  if (Object.hasOwn(API_KEY_VENDORS, providerId)) {
    try {
      const vendor = API_KEY_VENDORS[providerId as keyof typeof API_KEY_VENDORS];
      const key = await getApiKeyDiagnostics(vendor);
      const parts = [`configured=${key.configured ? "true" : "false"}`];
      if (key.source) parts.push(`source=${key.source}`);
      if (key.checkedPaths.length > 0) parts.push(`checked=${key.checkedPaths.join(" | ")}`);
      details.push({ key: "api_key_diagnostics", value: parts.join(" ") });
    } catch {
      details.push({ key: "api_key_diagnostics", value: "(could not be read)" });
    }
  }
  return details;
}

/**
 * A fresh check of every known provider (or only `providerId`) for /quota_status. The plugin's
 * source decides which providers are enabled and available; those are checked through a store
 * of its own that keeps nothing, as the plugin's store would check them. An unavailable
 * provider shows its local setup details instead, and one turned off in the settings is never
 * fetched.
 */
async function checkKnownProviders(
  host: ProviderSourceHost,
  providerId: string | undefined,
): Promise<{ checks: ProviderCheck[]; snapshots: ProviderSnapshot[] }> {
  const source = await loadProviderSource(host);
  const sourceIds = new Set(source.providers.map((provider) => provider.id));
  const ctx = providerContext(host);
  const { enabledProviders } = ctx.config;
  const turnedOn = (id: string) => enabledProviders === "auto" || enabledProviders.includes(id);
  const known = getProviders().filter((provider) => !providerId || provider.id === providerId);
  const checks = await Promise.all(
    known.map(async (provider): Promise<ProviderCheck> => {
      if (sourceIds.has(provider.id)) return { provider, enabled: true, available: true };
      // In auto mode a provider is enabled when it is available, as v5 reports it.
      if (enabledProviders === "auto") return { provider, enabled: false, available: false };
      if (turnedOn(provider.id)) return { provider, enabled: true, available: false };
      return { provider, enabled: false, available: await isAvailable(provider, ctx) };
    }),
  );

  const setupSnapshots = checks
    .filter((check) => !check.available && turnedOn(check.provider.id))
    .map(
      async ({ provider }): Promise<ProviderSnapshot> => ({
        providerId: provider.id,
        label: getQuotaProviderDisplayLabel(provider.id),
        rows: [],
        refreshing: false,
        debug: await localSetupDetails(provider.id, ctx),
      }),
    );
  const store = createQuotaStore({ source: async () => source, file: null });
  try {
    const knownIds = new Set(known.map((provider) => provider.id));
    const snapshot = await store.refresh({ reason: "manual", providerIds: [...knownIds] });
    const checked = snapshot.providers.filter((provider) => knownIds.has(provider.providerId));
    return { checks, snapshots: [...checked, ...(await Promise.all(setupSnapshots))] };
  } finally {
    await store.dispose();
  }
}

/** The last 30 days of usage, for the models without a price; null when it can't be read. */
async function readRecentUsage(nowMs: number): Promise<UsageReport | null> {
  try {
    return await usageReport({ range: "30d" }, nowMs);
  } catch {
    return null;
  }
}

export async function buildStatusReportData(params: {
  host: ProviderSourceHost;
  sessionID?: string;
  /** The session's model; undefined without a session. */
  sessionModel?: SessionModel;
  /** The v5 settings conversion this server wrote when it started. */
  conversion?: V5Conversion;
  generatedAtMs: number;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
  /** When set, restrict provider availability and live checks to this provider id. */
  providerFilterId?: string;
}): Promise<QuotaStatusReportData> {
  const { host } = params;
  const loaded = host.settings();
  const { settings } = loaded;
  await kickPricingRefresh({
    reason: "status",
    maxWaitMs: 750,
    snapshotSelection: settings.pricing.source,
  });

  const currentModel = params.sessionModel?.id;
  const currentProviderID = params.sessionModel?.providerID;
  const sessionModelLookup: "ok" | "not_found" | "no_session" = !params.sessionID
    ? "no_session"
    : currentModel
      ? "ok"
      : "not_found";

  const { enabledProviders, quotaProviders } = providerContext(host, loaded).config;
  const [{ checks, snapshots }, usage] = await Promise.all([
    checkKnownProviders(host, params.providerFilterId),
    readRecentUsage(params.generatedAtMs),
  ]);
  const availability = checks.map(({ provider, enabled, available }) => ({
    id: provider.id,
    enabled,
    available,
    matchesCurrentModel:
      currentModel || isCursorProviderId(currentProviderID)
        ? matchesQuotaProviderCurrentSelection({
            provider,
            currentModel,
            currentProviderID,
            enabledProviders,
            quotaProviders,
          })
        : undefined,
  }));

  if (enabledProviders === "auto") {
    await params.onDetectedProviderIds?.(
      availability.filter((item) => item.available).map((item) => item.id),
    );
  }
  const checkedIds = new Set(
    availability.filter((item) => item.enabled && item.available).map((item) => item.id),
  );
  const checked = snapshots.filter((provider) => checkedIds.has(provider.providerId));

  const announcementProviderIds = availability
    .filter((item) => item.enabled && item.available)
    .map((item) => item.id);
  const maintainerAnnouncementsSummary = getMaintainerAnnouncementsSummary({
    enabledProviders: announcementProviderIds,
  });

  const document = await buildQuotaStatusReportDocument({
    settings: loaded,
    conversion: loaded.conversion ?? params.conversion,
    workspaceRoot: host.workspaceRoot,
    enabledProviders: settings.providers.enabled,
    onlyCurrentModel: settings.words.onlyCurrentModel,
    quotaProviders: settings.providers.custom,
    pricingSnapshotSource: settings.pricing.source,
    currentModel,
    sessionModelLookup,
    providerAvailability: availability,
    providers: snapshots,
    credentialSource: getCredentialSourceDiagnostics(),
    maintainerAnnouncements: {
      config: settings.announcements,
      summary: maintainerAnnouncementsSummary,
    },
    usage,
    generatedAtMs: params.generatedAtMs,
  });

  const version = (await getPackageVersion()) ?? "unknown";
  const pricingMeta = getPricingSnapshotMeta();
  const payload: QuotaStatusReportPayload = {
    version,
    generatedAt: new Date(params.generatedAtMs).toISOString(),
    config: {
      settingsPath: loaded.path,
      settingsFileExists: loaded.exists,
      enabledProviders: settings.providers.enabled,
      onlyCurrentModel: settings.words.onlyCurrentModel,
      pricingSnapshotSource: settings.pricing.source,
    },
    providers: availability,
    pricing: {
      selection: settings.pricing.source,
      activeSource: getPricingSnapshotSource(),
      snapshot: {
        source: pricingMeta.source,
        generatedAt:
          pricingMeta.generatedAt > 0 ? new Date(pricingMeta.generatedAt).toISOString() : null,
        units: pricingMeta.units,
      },
      snapshotPath: getRuntimePricingSnapshotPath(),
      refreshStatePath: getRuntimePricingRefreshStatePath(),
    },
    liveProbes: checked.map((provider) => ({
      id: provider.providerId,
      ok: provider.error === undefined,
    })),
  };

  return {
    document,
    output: renderPlainTextReport(document),
    payload,
    hasComparableProviderData: checked.some((provider) => provider.rows.length > 0),
  };
}

function formatIsoTimestamp(timestampMs: number | undefined): string {
  return typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
    ? new Date(timestampMs).toISOString()
    : "(none)";
}

function buildPricingRefreshCommandReport(params: {
  result: PricingRefreshResult;
  configuredSelection: string;
  generatedAtMs: number;
}): CommandReport {
  const meta = getPricingSnapshotMeta();
  const activeSource = getPricingSnapshotSource();
  const resultLabel =
    params.result.reason ??
    params.result.state.lastResult ??
    (params.result.updated ? "success" : "unknown");

  const refreshRows: ReportKvRow[] = [
    { key: "attempted", value: params.result.attempted ? "true" : "false" },
    { key: "result", value: resultLabel },
    { key: "runtime_snapshot_persisted", value: params.result.updated ? "true" : "false" },
  ];

  if (params.result.error) {
    refreshRows.push({ key: "error", value: params.result.error });
  }

  const snapshotRows: ReportKvRow[] = [
    { key: "selection", value: `configured=${params.configuredSelection} active=${activeSource}` },
    {
      key: "active_snapshot",
      value: `source=${meta.source} generated_at=${formatIsoTimestamp(meta.generatedAt)} units=${meta.units}`,
    },
    {
      key: "runtime_paths",
      value: `snapshot=${getRuntimePricingSnapshotPath()} refresh_state=${getRuntimePricingRefreshStatePath()}`,
    },
  ];
  if (params.configuredSelection === "bundled" && params.result.updated) {
    snapshotRows.push({
      key: "selection_note",
      value:
        "runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing",
    });
  }

  return plainTextReport({
    heading: commandHeading({
      title: "Pricing Refresh (/pricing_refresh)",
      generatedAtMs: params.generatedAtMs,
    }),
    sections: [
      { id: "refresh", title: "refresh:", blocks: [{ kind: "kv", rows: refreshRows }] },
      {
        id: "pricing_snapshot",
        title: "pricing_snapshot:",
        blocks: [{ kind: "kv", rows: snapshotRows }],
      },
    ],
  });
}

function buildTokenReportUnavailableReport(params: {
  command: `/${string}`;
  generatedAtMs: number;
  error: SessionNotFoundError;
}): CommandReport {
  return plainTextReport({
    heading: commandHeading({
      title: `Token report unavailable (${params.command})`,
      detail: "Token report unavailable",
      generatedAtMs: params.generatedAtMs,
    }),
    sections: [
      {
        id: "session_lookup_error",
        title: "session_lookup_error:",
        blocks: [
          {
            kind: "kv",
            rows: [
              { key: "session_id", value: params.error.sessionID },
              { key: "error", value: params.error.message },
              { key: "checked_path", value: params.error.checkedPath },
            ],
          },
        ],
      },
    ],
  });
}

async function buildQuotaAnnouncementsCommandReport(
  host: ProviderSourceHost,
): Promise<CommandReport> {
  let activeAnnouncements: ReturnType<
    typeof getMaintainerAnnouncementsSummary
  >["activeAnnouncements"] = [];

  if (host.settings().settings.announcements.enabled) {
    const providerIds = (await loadProviderSource(host)).providers.map((provider) => provider.id);
    const summary = getMaintainerAnnouncementsSummary({
      announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
      enabledProviders: providerIds,
    });
    activeAnnouncements = summary.activeAnnouncements;
  }

  const lines: string[] = [];

  if (activeAnnouncements.length === 0) {
    lines.push("No current announcements.");
  }

  for (const evaluation of activeAnnouncements) {
    lines.push(`- ${evaluation.announcement.message}`);
    if (evaluation.announcement.url) {
      lines.push(`  ${evaluation.announcement.url}`);
    }
  }

  return plainTextReport({
    heading: { line: "Maintainer announcements" },
    sections: [{ id: "announcements", blocks: [{ kind: "lines", lines }] }],
  });
}

function outputResult(
  command: QuotaDialogCommandId,
  report: CommandReport,
): QuotaDialogCommandOutputResult {
  const spec = QUOTA_DIALOG_COMMANDS_BY_ID.get(command)!;
  return {
    state: "output",
    command,
    title: spec.title,
    output: report.output,
    document: report.document,
    dialogSize: spec.dialogSize,
  };
}

async function buildTokenReportCommandReport(params: {
  command: TokenReportCommandId;
  arguments?: string;
  sessionID?: string;
  generatedAtMs: number;
  pricingSource: PricingSnapshotSource;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<CommandReport> {
  const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(params.command)!;
  const sessionID = params.sessionID;
  const untilMs = params.generatedAtMs;
  await kickPricingRefresh({
    reason: "tokens",
    maxWaitMs: 750,
    snapshotSelection: params.pricingSource,
    log: params.log,
  });

  if (!sessionID && (spec.kind === "session" || spec.kind === "session_tree")) {
    return buildTokenReportUnavailableReport({
      command: spec.template,
      generatedAtMs: params.generatedAtMs,
      error: new SessionNotFoundError("(none)", "(none)"),
    });
  }

  try {
    if (spec.kind === "between") {
      const parsed = parseQuotaBetweenArgs(params.arguments);
      if (!parsed.ok) {
        return plainTextReport(
          messageDocument(
            `Invalid arguments for /${spec.id}\n\n${parsed.error}\n\nExpected: /${spec.id} YYYY-MM-DD YYYY-MM-DD\nExample: /${spec.id} 2026-01-01 2026-01-15`,
          ),
        );
      }

      const sinceMs = startOfLocalDayMs(parsed.startYmd);
      const rangeUntilMs = startOfNextLocalDayMs(parsed.endYmd);
      return await buildQuotaReport({
        title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
        titleDetail: `${formatYmd(parsed.startYmd)} .. ${formatYmd(parsed.endYmd)}`,
        sinceMs,
        untilMs: rangeUntilMs,
        sessionID: sessionID ?? "",
        generatedAtMs: params.generatedAtMs,
      });
    }

    let sinceMs: number | undefined;
    let filterSessionID: string | undefined;
    let filterSessionIDs: string[] | undefined;
    let sessionOnly: boolean | undefined;
    let topModels: number | undefined;
    let topSessions: number | undefined;
    let reportKind: "standard" | "session" | "session_tree" | undefined;
    let sessionTree: { rootSessionID: string; nodes: SessionTreeNode[] } | undefined;

    switch (spec.kind) {
      case "rolling":
        sinceMs = untilMs - spec.windowMs!;
        break;
      case "today": {
        const now = new Date(untilMs);
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        sinceMs = startOfDay.getTime();
        break;
      }
      case "session":
        filterSessionID = sessionID;
        sessionOnly = true;
        reportKind = "session";
        break;
      case "session_tree": {
        const nodes = await resolveSessionTree(sessionID!);
        filterSessionIDs = nodes.map((node) => node.sessionID);
        reportKind = "session_tree";
        sessionTree = { rootSessionID: sessionID!, nodes };
        break;
      }
      case "all":
        topModels = spec.topModels;
        topSessions = spec.topSessions;
        break;
    }

    return await buildQuotaReport({
      title: spec.title,
      sinceMs,
      untilMs: spec.kind === "rolling" || spec.kind === "today" ? untilMs : undefined,
      sessionID: sessionID ?? "",
      filterSessionID,
      filterSessionIDs,
      sessionOnly,
      reportKind,
      sessionTree,
      topModels,
      topSessions,
      generatedAtMs: params.generatedAtMs,
    });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return buildTokenReportUnavailableReport({
        command: spec.template,
        generatedAtMs: params.generatedAtMs,
        error: err,
      });
    }
    throw err;
  }
}

export async function buildQuotaDialogCommandOutput(params: {
  command: QuotaDialogCommandId;
  arguments?: string;
  host: ProviderSourceHost;
  sessionID?: string;
  /** The session's model, for /quota_status. */
  resolveSessionModel?: (sessionID: string) => Promise<SessionModel>;
  /** The snapshot /quota shows, with the server's words and the session's part. */
  quotaSnapshot: (sessionID: string | undefined) => Promise<QuotaSnapshot>;
  /** The v5 settings conversion this server wrote when it started. */
  conversion?: V5Conversion;
  generatedAtMs?: number;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
}): Promise<QuotaDialogCommandOutputResult> {
  const generatedAtMs = params.generatedAtMs ?? Date.now();
  const { pricing } = params.host.settings().settings;
  setPricingSnapshotAutoRefresh(pricing.autoRefreshDays);
  setPricingSnapshotSelection(pricing.source);

  if (params.command === "quota") {
    const snapshot = await params.quotaSnapshot(params.sessionID);
    return outputResult(params.command, quotaCommandReport(snapshot, generatedAtMs));
  }

  if (params.command === "quota_status") {
    const sessionModel =
      params.sessionID && params.resolveSessionModel
        ? await params.resolveSessionModel(params.sessionID)
        : undefined;
    const data = await buildStatusReportData({
      host: params.host,
      sessionID: params.sessionID,
      sessionModel,
      conversion: params.conversion,
      generatedAtMs,
      onDetectedProviderIds: params.onDetectedProviderIds,
    });
    return outputResult(params.command, { document: data.document, output: data.output });
  }

  if (params.command === "quota_announcements") {
    if ((params.arguments ?? "").trim()) {
      return outputResult(
        params.command,
        plainTextReport(
          messageDocument(
            "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
          ),
        ),
      );
    }

    return outputResult(params.command, await buildQuotaAnnouncementsCommandReport(params.host));
  }

  if (params.command === "pricing_refresh") {
    if ((params.arguments ?? "").trim()) {
      return outputResult(
        params.command,
        plainTextReport(
          messageDocument(
            "Invalid arguments for /pricing_refresh\n\nThis command does not accept arguments.\n\nUsage:\n/pricing_refresh",
          ),
        ),
      );
    }

    const result = await maybeRefreshPricingSnapshot({
      reason: "manual",
      force: true,
      snapshotSelection: pricing.source,
      allowRefreshWhenSelectionBundled: true,
    });
    return outputResult(
      params.command,
      buildPricingRefreshCommandReport({
        result,
        configuredSelection: pricing.source,
        generatedAtMs,
      }),
    );
  }

  if (isTokenReportCommand(params.command)) {
    return outputResult(
      params.command,
      await buildTokenReportCommandReport({
        command: params.command,
        arguments: params.arguments,
        sessionID: params.sessionID,
        generatedAtMs,
        pricingSource: pricing.source,
        log: params.log,
      }),
    );
  }

  return { state: "noop", command: params.command, reason: "disabled" };
}
