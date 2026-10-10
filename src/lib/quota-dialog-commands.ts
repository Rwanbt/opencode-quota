import { type QuotaRpcCommandOutput, REPORT_COMMANDS, type ReportCommandId } from "../rpc.js";
import {
  formatYmd,
  parseQuotaBetweenArgs,
  startOfLocalDayMs,
  startOfNextLocalDayMs,
  type Ymd,
} from "./command-parsing.js";
import type { RuntimeContextRootHints } from "./config-file-utils.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { getMaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
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
import {
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

/** The commands this module builds reports for. */
export type QuotaDialogCommandId = "quota_status" | ReportCommandId;

type TokenReportCommandId = Exclude<ReportCommandId, "pricing_refresh">;

type TokenReportCommandSpec =
  | {
      template: `/${string}`;
      title: string;
      kind: "rolling" | "today" | "all" | "session" | "session_tree";
      windowMs?: number;
      topModels?: number;
      topSessions?: number;
    }
  | {
      template: "/tokens_between";
      titleForRange: (startYmd: Ymd, endYmd: Ymd) => string;
      kind: "between";
    };

const DAY_MS = 24 * 60 * 60 * 1000;

const TOKEN_REPORT_COMMANDS: Readonly<Record<TokenReportCommandId, TokenReportCommandSpec>> = {
  tokens_today: {
    template: "/tokens_today",
    title: "Tokens used (Today) (/tokens_today)",
    kind: "today",
  },
  tokens_daily: {
    template: "/tokens_daily",
    title: "Tokens used (Last 24 Hours) (/tokens_daily)",
    kind: "rolling",
    windowMs: DAY_MS,
  },
  tokens_weekly: {
    template: "/tokens_weekly",
    title: "Tokens used (Last 7 Days) (/tokens_weekly)",
    kind: "rolling",
    windowMs: 7 * DAY_MS,
  },
  tokens_monthly: {
    template: "/tokens_monthly",
    title: "Tokens used (Last 30 Days) (/tokens_monthly)",
    kind: "rolling",
    windowMs: 30 * DAY_MS,
  },
  tokens_all: {
    template: "/tokens_all",
    title: "Tokens used (All Time) (/tokens_all)",
    kind: "all",
    topModels: 12,
    topSessions: 12,
  },
  tokens_session: {
    template: "/tokens_session",
    title: "Tokens used (Current Session) (/tokens_session)",
    kind: "session",
  },
  tokens_session_all: {
    template: "/tokens_session_all",
    title: "Tokens used (Current Session Tree) (/tokens_session_all)",
    kind: "session_tree",
  },
  tokens_between: {
    template: "/tokens_between",
    titleForRange: (startYmd, endYmd) =>
      `Tokens used (${formatYmd(startYmd)} .. ${formatYmd(endYmd)}) (/tokens_between)`,
    kind: "between",
  },
};

/** A command's report: the document the TUI renders and the text everything else shows. */
type CommandReport = { document: ReportDocument; output: string };

function plainTextReport(document: ReportDocument): CommandReport {
  return { document, output: renderPlainTextReport(document) };
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

function outputResult(command: QuotaDialogCommandId, report: CommandReport): QuotaRpcCommandOutput {
  const title =
    command === "quota_status"
      ? "OpenCode Quota Status"
      : REPORT_COMMANDS.find((spec) => spec.id === command)!.title;
  return { state: "output", command, title, output: report.output, document: report.document };
}

async function buildTokenReportCommandReport(params: {
  command: TokenReportCommandId;
  arguments?: string;
  sessionID?: string;
  generatedAtMs: number;
  runtime: QuotaRuntimeContext;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<CommandReport> {
  const spec = TOKEN_REPORT_COMMANDS[params.command];
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
            `Invalid arguments for ${spec.template}\n\n${parsed.error}\n\nExpected: ${spec.template} YYYY-MM-DD YYYY-MM-DD\nExample: ${spec.template} 2026-01-01 2026-01-15`,
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
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
}): Promise<QuotaRpcCommandOutput> {
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

  if (!runtime.config.enabled) {
    return { state: "noop", command: params.command, reason: "disabled" };
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
