import {
  formatYmd,
  parseQuotaBetweenArgs,
  startOfLocalDayMs,
  startOfNextLocalDayMs,
} from "./command-parsing.js";
import type { RuntimeContextRootHints } from "./config-file-utils.js";
import { isCursorProviderId } from "./cursor-pricing.js";
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
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
} from "./modelsdev-pricing.js";
import { buildQuotaCommandDocument } from "./quota-command-format.js";
import {
  QUOTA_DIALOG_COMMANDS_BY_ID,
  type QuotaDialogCommandId,
  type QuotaDialogCommandOutputResult,
  TOKEN_REPORT_COMMANDS,
  type TokenReportCommandId,
  type TokenReportCommandSpec,
} from "./quota-dialog-command-specs.js";
import { ALL_WINDOWS_FORMAT_STYLE } from "./quota-format-style.js";
import {
  type CollectQuotaRenderDataResult,
  collectConcreteEnabledProviderIds,
  collectQuotaRenderData,
  collectQuotaStatusLiveProbes,
  matchesQuotaProviderCurrentSelection,
  type QuotaStatusLiveProbe,
  type SessionModelMeta,
} from "./quota-render-data.js";
import {
  createQuotaProviderRuntimeContext,
  createQuotaRuntimeRequestContext,
  type QuotaRuntimeClient,
  type QuotaRuntimeContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import {
  aggregateUsage,
  resolveSessionTree,
  SessionNotFoundError,
  type SessionTreeNode,
} from "./quota-stats.js";
import { buildQuotaStatsReportDocument } from "./quota-stats-format.js";
import { buildQuotaStatusReportDocument, type SessionTokenError } from "./quota-status.js";
import {
  commandHeading,
  messageDocument,
  type ReportDocument,
  type ReportKvRow,
  renderMarkdownReport,
  renderPlainTextReport,
} from "./report-document.js";
import type { PricingSnapshotSource } from "./types.js";
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

function describeQuotaCommandCurrentSelection(params: {
  currentModel?: string;
  currentProviderID?: string;
}): string {
  if (isCursorProviderId(params.currentProviderID)) {
    return `current provider: ${params.currentProviderID}`;
  }
  if (params.currentModel) {
    return `current model: ${params.currentModel}`;
  }
  return "current session";
}

function buildQuotaCommandUnavailableMessage(result: CollectQuotaRenderDataResult): string {
  const selection = result.selection;
  if (!selection) {
    return "Quota unavailable\n\nNo enabled quota providers are configured.\n\nRun /quota_status for diagnostics.";
  }

  if (selection.filteringByCurrentSelection && selection.filtered.length === 0) {
    const detail = describeQuotaCommandCurrentSelection({
      currentModel: selection.currentModel,
      currentProviderID: selection.currentProviderID,
    });
    return `Quota unavailable\n\nNo enabled quota providers matched the ${detail}.\n\nRun /quota_status for diagnostics.`;
  }

  const availableIds = result.availability
    .filter((item) => item.ok)
    .map((item) => item.provider.id);

  if (availableIds.length === 0) {
    const scopedDetail = selection.filteringByCurrentSelection
      ? ` for the ${describeQuotaCommandCurrentSelection({
          currentModel: selection.currentModel,
          currentProviderID: selection.currentProviderID,
        })}`
      : "";
    return (
      `Quota unavailable\n\nNo provider data available${scopedDetail}. ` +
      "Make sure you are logged in to a supported provider (Copilot, OpenAI, etc.).\n\n" +
      "Run /quota_status for diagnostics."
    );
  }

  return (
    `Quota unavailable\n\nNo provider data available for detected providers (${availableIds.join(", ")}). ` +
    "This may be a temporary API error.\n\n" +
    "Run /quota_status for diagnostics."
  );
}

async function fetchQuotaCommandData(params: {
  runtime: QuotaRuntimeContext;
  setLastSessionTokenError?: (error: SessionTokenError | undefined) => void;
}): Promise<CollectQuotaRenderDataResult> {
  const { runtime } = params;
  const request = createQuotaRuntimeRequestContext(runtime);
  const quotaResult = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config: runtime.config,
    configMeta: runtime.configMeta,
    request,
    workspaceRoot: runtime.roots.workspaceRoot,
    surfaceExplicitProviderIssues: false,
    formatStyle: ALL_WINDOWS_FORMAT_STYLE,
    providers: runtime.providers,
  });

  if (runtime.config.showSessionTokens && request.sessionID) {
    params.setLastSessionTokenError?.(quotaResult.sessionTokenError);
  }

  return quotaResult;
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

export interface QuotaStatusReportConfigPayload {
  configSource: string;
  configPaths: string[];
  globalConfigPaths?: string[];
  workspaceConfigPaths?: string[];
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
  liveProbes: Array<{ id: string; ok: boolean }>;
}

export interface QuotaStatusReportData {
  document: ReportDocument | null;
  output: string | null;
  payload: QuotaStatusReportPayload | null;
  hasComparableProviderData: boolean;
}

export function summarizeQuotaStatusLiveProbes(
  probes: QuotaStatusLiveProbe[],
): QuotaStatusReportPayload["liveProbes"] {
  return probes.map((probe) => ({
    id: probe.providerId,
    ok: probe.result.attempted && probe.result.errors.length === 0,
  }));
}

export async function buildStatusReportData(params: {
  runtime: QuotaRuntimeContext;
  sessionID?: string;
  generatedAtMs: number;
  lastSessionTokenError?: SessionTokenError;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
  /** When set, restrict provider availability and live probes to this provider id. */
  providerFilterId?: string;
}): Promise<QuotaStatusReportData> {
  const runtimeConfig = params.runtime.config;
  if (!runtimeConfig.enabled) {
    return { document: null, output: null, payload: null, hasComparableProviderData: false };
  }
  await kickPricingRefresh({
    reason: "status",
    maxWaitMs: 750,
    snapshotSelection: runtimeConfig.pricingSnapshot.source,
    log: params.log,
  });

  const currentSession = params.runtime.session.sessionMeta ?? {};
  const currentModel = currentSession.modelID;
  const currentProviderID = currentSession.providerID;
  const sessionModelLookup: "ok" | "not_found" | "no_session" = !params.sessionID
    ? "no_session"
    : currentModel
      ? "ok"
      : "not_found";

  const isAutoMode = runtimeConfig.enabledProviders === "auto";

  const providers = params.providerFilterId
    ? params.runtime.providers.filter((provider) => provider.id === params.providerFilterId)
    : params.runtime.providers;
  const providerContext = createQuotaProviderRuntimeContext({
    ...params.runtime,
    workspaceRoot: params.runtime.roots.workspaceRoot,
  });
  const availability = await Promise.all(
    providers.map(async (p) => {
      let ok = false;
      try {
        ok = await p.isAvailable(providerContext);
      } catch {
        ok = false;
      }
      return {
        id: p.id,
        enabled: isAutoMode ? ok : runtimeConfig.enabledProviders.includes(p.id),
        available: ok,
        matchesCurrentModel:
          currentModel || isCursorProviderId(currentProviderID)
            ? matchesQuotaProviderCurrentSelection({
                provider: p,
                currentModel,
                currentProviderID,
                enabledProviders: runtimeConfig.enabledProviders,
                quotaProviders: runtimeConfig.quotaProviders,
              })
            : undefined,
      };
    }),
  );

  if (isAutoMode) {
    await params.onDetectedProviderIds?.(
      availability.filter((item) => item.available).map((item) => item.id),
    );
  }

  // Status diagnostics belong to provider results, including missing or disabled
  // providers. Provider fetch implementations must keep unconfigured cases local.
  const liveProbeProviders = providers;

  let providerLiveProbes: QuotaStatusLiveProbe[] = [];
  if (liveProbeProviders.length > 0) {
    try {
      providerLiveProbes = await collectQuotaStatusLiveProbes({
        client: params.runtime.client,
        resolveRuntimeProviderIds: params.runtime.resolveRuntimeProviderIds,
        config: runtimeConfig,
        configMeta: params.runtime.configMeta,
        request: createQuotaRuntimeRequestContext(params.runtime),
        workspaceRoot: params.runtime.roots.workspaceRoot,
        providers: liveProbeProviders,
      });
    } catch (error) {
      await params.log?.("Failed to collect /quota_status live probes", {
        providers: liveProbeProviders.map((provider) => provider.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const announcementProviderIds = availability
    .filter((item) => item.enabled && item.available)
    .map((item) => item.id);
  const maintainerAnnouncementsSummary = getMaintainerAnnouncementsSummary({
    enabledProviders: announcementProviderIds,
  });

  const document = await buildQuotaStatusReportDocument({
    runtimeRoots: params.runtime.roots,
    configSource: params.runtime.configMeta.source,
    configPaths: params.runtime.configMeta.paths,
    globalConfigPaths: params.runtime.configMeta.globalConfigPaths,
    workspaceConfigPaths: params.runtime.configMeta.workspaceConfigPaths,
    settingSources: params.runtime.configMeta.settingSources,
    configIssues: params.runtime.configMeta.configIssues,
    enabledProviders: runtimeConfig.enabledProviders,
    anthropicBinaryPath: runtimeConfig.anthropicBinaryPath,
    cursorPlan: runtimeConfig.cursorPlan,
    cursorIncludedApiUsd: runtimeConfig.cursorIncludedApiUsd,
    cursorBillingCycleStartDay: runtimeConfig.cursorBillingCycleStartDay,
    opencodeGoWindows: runtimeConfig.opencodeGoWindows,
    pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
    onlyCurrentModel: runtimeConfig.onlyCurrentModel,
    currentModel,
    sessionModelLookup,
    providerAvailability: availability,
    providerLiveProbes,
    quotaProviders: runtimeConfig.quotaProviders,
    sessionTokenError: params.lastSessionTokenError,
    maintainerAnnouncements: {
      config: runtimeConfig.maintainerAnnouncements,
      summary: maintainerAnnouncementsSummary,
    },
    generatedAtMs: params.generatedAtMs,
  });

  const version = (await getPackageVersion()) ?? "unknown";
  const pricingMeta = getPricingSnapshotMeta();
  const activePricingSource = getPricingSnapshotSource();
  const payload: QuotaStatusReportPayload = {
    version,
    generatedAt: new Date(params.generatedAtMs).toISOString(),
    config: {
      configSource: params.runtime.configMeta.source,
      configPaths: params.runtime.configMeta.paths,
      globalConfigPaths: params.runtime.configMeta.globalConfigPaths,
      workspaceConfigPaths: params.runtime.configMeta.workspaceConfigPaths,
      enabledProviders: runtimeConfig.enabledProviders,
      onlyCurrentModel: runtimeConfig.onlyCurrentModel,
      pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
    },
    providers: availability,
    pricing: {
      selection: runtimeConfig.pricingSnapshot.source,
      activeSource: activePricingSource,
      snapshot: {
        source: pricingMeta.source,
        generatedAt:
          pricingMeta.generatedAt > 0 ? new Date(pricingMeta.generatedAt).toISOString() : null,
        units: pricingMeta.units,
      },
      snapshotPath: getRuntimePricingSnapshotPath(),
      refreshStatePath: getRuntimePricingRefreshStatePath(),
    },
    liveProbes: summarizeQuotaStatusLiveProbes(providerLiveProbes),
  };

  return {
    document,
    output: renderPlainTextReport(document),
    payload,
    hasComparableProviderData: providerLiveProbes.some((probe) => probe.result.entries.length > 0),
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
  runtime: QuotaRuntimeContext,
): Promise<CommandReport> {
  let activeAnnouncements: ReturnType<
    typeof getMaintainerAnnouncementsSummary
  >["activeAnnouncements"] = [];

  if (runtime.config.enabled && runtime.config.maintainerAnnouncements.enabled) {
    const providerIds = await collectConcreteEnabledProviderIds({
      providers: runtime.providers,
      ctx: createQuotaProviderRuntimeContext({
        ...runtime,
        workspaceRoot: runtime.roots.workspaceRoot,
      }),
      enabledProviders: runtime.config.enabledProviders,
    });
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
  runtime: QuotaRuntimeContext;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<CommandReport> {
  const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(params.command)!;
  const sessionID = params.sessionID;
  const untilMs = params.generatedAtMs;
  await kickPricingRefresh({
    reason: "tokens",
    maxWaitMs: 750,
    snapshotSelection: params.runtime.config.pricingSnapshot.source,
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
  client: QuotaRuntimeClient;
  roots: RuntimeContextRootHints;
  sessionID?: string;
  sessionMeta?: SessionModelMeta;
  resolveSessionMeta?: (sessionID: string) => Promise<SessionModelMeta>;
  generatedAtMs?: number;
  lastSessionTokenError?: SessionTokenError;
  setLastSessionTokenError?: (error: SessionTokenError | undefined) => void;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
}): Promise<QuotaDialogCommandOutputResult> {
  const generatedAtMs = params.generatedAtMs ?? Date.now();
  const runtime = await resolveQuotaRuntimeContext({
    client: params.client,
    roots: params.roots,
    sessionID: params.sessionID,
    sessionMeta: params.sessionMeta,
    resolveSessionMeta: params.resolveSessionMeta,
    includeSessionMeta: (config) => config.onlyCurrentModel || params.command === "quota_status",
  });

  setPricingSnapshotAutoRefresh(runtime.config.pricingSnapshot.autoRefresh);
  setPricingSnapshotSelection(runtime.config.pricingSnapshot.source);

  if (!runtime.config.enabled && params.command !== "quota_announcements") {
    return { state: "noop", command: params.command, reason: "disabled" };
  }

  if (params.command === "quota") {
    const reportData = await fetchQuotaCommandData({
      runtime,
      setLastSessionTokenError: params.setLastSessionTokenError,
    });
    if (
      !reportData.data ||
      (reportData.selection?.filteringByCurrentSelection &&
        reportData.selection.filtered.length === 0)
    ) {
      return outputResult(
        params.command,
        plainTextReport(messageDocument(buildQuotaCommandUnavailableMessage(reportData))),
      );
    }

    return outputResult(
      params.command,
      plainTextReport(
        buildQuotaCommandDocument({
          ...reportData.data,
          generatedAtMs,
          percentDisplayMode: runtime.config.percentDisplayMode,
          percentLabelStyle: runtime.config.percentLabelStyle,
          accountingDetail: runtime.config.accountingDetail,
          resetTimeSpaced: runtime.config.resetTimeSpaced,
        }),
      ),
    );
  }

  if (params.command === "quota_status") {
    const data = await buildStatusReportData({
      runtime,
      sessionID: params.sessionID,
      generatedAtMs,
      lastSessionTokenError: params.lastSessionTokenError,
      log: params.log,
      onDetectedProviderIds: params.onDetectedProviderIds,
    });
    return data.document && data.output
      ? outputResult(params.command, { document: data.document, output: data.output })
      : { state: "noop", command: params.command, reason: "disabled" };
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

    return outputResult(params.command, await buildQuotaAnnouncementsCommandReport(runtime));
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
      snapshotSelection: runtime.config.pricingSnapshot.source,
      allowRefreshWhenSelectionBundled: true,
    });
    return outputResult(
      params.command,
      buildPricingRefreshCommandReport({
        result,
        configuredSelection: runtime.config.pricingSnapshot.source,
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
        runtime,
        log: params.log,
      }),
    );
  }

  return { state: "noop", command: params.command, reason: "disabled" };
}
