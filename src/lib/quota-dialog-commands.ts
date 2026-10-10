/**
 * The /quota_status report of the slash command, the `quota_status` tool and
 * `opencode-quota status`, and the quota lines of `opencode-quota show`. Each reads the server
 * settings the host holds now.
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
import type { Settings, V5Conversion } from "../settings/index.js";
import { DEFAULT_WORDS } from "../view/format.js";
import { type RowSettings, type SurfaceRows, visibleGroups } from "../view/select.js";
import { plainLines } from "../view/text.js";
import { API_KEY_VENDORS, getApiKeyDiagnostics } from "./api-key-resolver.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "./entries.js";
import { getMaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
import {
  getPricingSnapshotMeta,
  getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot,
  type PricingSnapshotSource,
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
} from "./modelsdev-pricing.js";
import { getCredentialSourceDiagnostics } from "./opencode-auth.js";
import { getQuotaProviderDisplayLabel, getQuotaProviderRuntimeIds } from "./provider-metadata.js";
import { buildQuotaStatusReportDocument } from "./quota-status.js";
import { type ReportDocument, renderPlainTextReport } from "./report-document.js";
import { getPackageVersion } from "./version.js";

/** The commands this module builds reports for. */
export type QuotaDialogCommandId = "quota_status";

/** The /quota_status report: the document the TUI renders and the text everything else shows. */
export type QuotaDialogCommandOutput = {
  state: "output";
  command: QuotaDialogCommandId;
  title: string;
  output: string;
  document: ReportDocument;
};

/** `opencode-quota show` lists every row of every provider. */
const EVERY_ROW: SurfaceRows = { enabled: true, hidden: [], providerOrder: [], rowOrder: {} };
const EVERY_ROW_SETTINGS: RowSettings = {
  labels: {},
  window: {},
  surfaces: { sidebar: EVERY_ROW, collapsed: EVERY_ROW, statusLine: EVERY_ROW, toast: EVERY_ROW },
};

/**
 * The quota lines `opencode-quota show` prints, in the snapshot's words: a line per row (with
 * "runs out in …" when `words.runsOut` is on), a line per provider problem, then the session's
 * tokens when the snapshot has them.
 */
export function quotaReportLines(snapshot: QuotaSnapshot, nowMs: number): string[] {
  const words = snapshot.words ?? DEFAULT_WORDS;
  const groups = visibleGroups(snapshot, EVERY_ROW_SETTINGS, "toast", words);
  const sessionTokens = snapshot.sessionTokens ? { sessionTokens: snapshot.sessionTokens } : {};
  return plainLines({ groups, words, nowMs, runsOut: words.runsOut, ...sessionTokens }).map(
    sanitizeDisplayText,
  );
}

/**
 * Uses the pricing settings from now on: the price list (`source`) and how many days old it
 * may get before a refresh. Applied before any provider check, as local estimates use prices.
 */
export function applyPricingSettings(pricing: Settings["pricing"]): void {
  setPricingSnapshotAutoRefresh(pricing.autoRefreshDays);
  setPricingSnapshotSelection(pricing.source);
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

/** The /quota_status report, as a document and as plain text. */
export async function buildQuotaDialogCommandOutput(params: {
  command: QuotaDialogCommandId;
  host: ProviderSourceHost;
  sessionID?: string;
  /** The session's model, for /quota_status. */
  resolveSessionModel?: (sessionID: string) => Promise<SessionModel>;
  /** The v5 settings conversion this server wrote when it started. */
  conversion?: V5Conversion;
  generatedAtMs?: number;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
}): Promise<QuotaDialogCommandOutput> {
  const generatedAtMs = params.generatedAtMs ?? Date.now();
  applyPricingSettings(params.host.settings().settings.pricing);
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
  return {
    state: "output",
    command: params.command,
    title: "OpenCode Quota Status",
    output: data.output,
    document: data.document,
  };
}
