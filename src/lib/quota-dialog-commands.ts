import type { RuntimeContextRootHints } from "./config-file-utils.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { getMaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
import {
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot,
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
import { buildQuotaStatusReportDocument, type SessionTokenError } from "./quota-status.js";
import { type ReportDocument, renderPlainTextReport } from "./report-document.js";
import type { PricingSnapshotSource } from "./types.js";
import { getPackageVersion } from "./version.js";

/** The commands this module builds reports for. */
export type QuotaDialogCommandId = "quota_status";

/** The /quota_status report: the document and its plain text, or nothing while turned off. */
export type QuotaDialogCommandOutput =
  | {
      state: "output";
      command: QuotaDialogCommandId;
      title: string;
      output: string;
      document: ReportDocument;
    }
  | { state: "noop"; command: QuotaDialogCommandId; reason: "disabled" };

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

export async function buildQuotaDialogCommandOutput(params: {
  command: QuotaDialogCommandId;
  client: QuotaRuntimeClient;
  roots: RuntimeContextRootHints;
  sessionID?: string;
  sessionMeta?: SessionModelMeta;
  resolveSessionMeta?: (sessionID: string) => Promise<SessionModelMeta>;
  generatedAtMs?: number;
  lastSessionTokenError?: SessionTokenError;
  log?: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
}): Promise<QuotaDialogCommandOutput> {
  const generatedAtMs = params.generatedAtMs ?? Date.now();
  const runtime = await resolveQuotaRuntimeContext({
    client: params.client,
    roots: params.roots,
    sessionID: params.sessionID,
    sessionMeta: params.sessionMeta,
    resolveSessionMeta: params.resolveSessionMeta,
    includeSessionMeta: true,
  });

  setPricingSnapshotAutoRefresh(runtime.config.pricingSnapshot.autoRefresh);
  setPricingSnapshotSelection(runtime.config.pricingSnapshot.source);

  if (!runtime.config.enabled) {
    return { state: "noop", command: params.command, reason: "disabled" };
  }

  const data = await buildStatusReportData({
    runtime,
    sessionID: params.sessionID,
    generatedAtMs,
    lastSessionTokenError: params.lastSessionTokenError,
    log: params.log,
    onDetectedProviderIds: params.onDetectedProviderIds,
  });
  if (!data.document || !data.output) {
    return { state: "noop", command: params.command, reason: "disabled" };
  }
  return {
    state: "output",
    command: params.command,
    title: "OpenCode Quota Status",
    output: data.output,
    document: data.document,
  };
}
