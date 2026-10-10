import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import type { FixedWindowProjectionEvidence, QuotaToastEntry } from "./entries.js";
import { asRecord, isRecord } from "./json-guards.js";
import { lookupCost } from "./modelsdev-pricing.js";
import type { OpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import { iterCompletedAssistantMessages } from "./opencode-storage.js";
import type {
  LocalEstimateQuotaProviderDefinition,
  LocalEstimateWindow,
} from "./quota-providers.js";
import { resolvePricingKey } from "./quota-stats.js";
import { type TokenBuckets, tokenBucketsFromMessage } from "./token-buckets.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";

export const QUOTA_PROVIDER_LOCAL_STATE_VERSION = 1 as const;
const LOCAL_STATE_DIR = "opencode-quota/quota-providers";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TOKEN_BUCKET_KEYS = ["input", "output", "reasoning", "cache_read", "cache_write"];

export interface LocalQuotaProviderMessage {
  id: string;
  atMs: number;
  providerId: string;
  modelId: string;
  tokens: TokenBuckets;
}

export interface LocalQuotaProviderStateV1 {
  version: typeof QUOTA_PROVIDER_LOCAL_STATE_VERSION;
  definitionId: string;
  providerId: string;
  updatedAt: number;
  messages: LocalQuotaProviderMessage[];
}

export type LocalQuotaProviderStateHealth =
  | "missing"
  | "healthy"
  | "malformed"
  | "version_mismatch";

export interface LocalQuotaProviderStateDiagnostics {
  path: string;
  exists: boolean;
  health: LocalQuotaProviderStateHealth;
  version: number | null;
  lastUpdatedAt: number | null;
}

export interface LocalEstimateResult {
  entries: QuotaToastEntry[];
  state: LocalQuotaProviderStateV1;
  unpricedMessageCount: number;
}

interface LocalStateDependencies {
  nowMs?: number;
  runtimeDirs?: OpencodeRuntimeDirs;
  readMessages?: (params: {
    completedSinceMs: number;
    completedUntilMs: number;
  }) => Promise<OpenCodeMessage[]>;
  readText?: (path: string) => Promise<string>;
  writeState?: (path: string, state: LocalQuotaProviderStateV1) => Promise<void>;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isStoredTokenBuckets(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, TOKEN_BUCKET_KEYS) &&
    TOKEN_BUCKET_KEYS.every((key) => {
      const count = value[key];
      return typeof count === "number" && Number.isFinite(count) && count >= 0;
    })
  );
}

function isStoredMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "atMs", "providerId", "modelId", "tokens"]) &&
    isNonEmptyString(value.id) &&
    typeof value.atMs === "number" &&
    Number.isFinite(value.atMs) &&
    value.atMs > 0 &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId) &&
    isStoredTokenBuckets(value.tokens)
  );
}

function stateHealth(
  record: Record<string, unknown> | null,
  definition: LocalEstimateQuotaProviderDefinition,
): LocalQuotaProviderStateHealth {
  if (!record) return "malformed";
  if (record.version !== QUOTA_PROVIDER_LOCAL_STATE_VERSION) return "version_mismatch";
  const isHealthy =
    hasOnlyKeys(record, ["version", "definitionId", "providerId", "updatedAt", "messages"]) &&
    record.definitionId === definition.id &&
    record.providerId === definition.providerId &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt >= 0 &&
    Array.isArray(record.messages) &&
    record.messages.every(isStoredMessage);
  return isHealthy ? "healthy" : "malformed";
}

export function getLocalQuotaProviderStatePath(
  definitionId: string,
  runtimeDirs: OpencodeRuntimeDirs = getOpencodeRuntimeDirs(),
): string {
  return join(runtimeDirs.stateDir, LOCAL_STATE_DIR, `${definitionId}.json`);
}

function windowStart(window: LocalEstimateWindow, nowMs: number): number {
  if (window.type === "rolling") return nowMs - window.durationMinutes! * MINUTE_MS;
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function toStateMessage(
  definition: LocalEstimateQuotaProviderDefinition,
  message: OpenCodeMessage,
): LocalQuotaProviderMessage | null {
  const completed = message.time?.completed;
  // Only finished requests count, timed by when they completed.
  const atMs =
    typeof completed === "number" && Number.isFinite(completed) ? Math.trunc(completed) : 0;
  if (
    message.role !== "assistant" ||
    message.providerID !== definition.providerId ||
    typeof message.modelID !== "string" ||
    !message.modelID ||
    (definition.modelIds !== undefined && !definition.modelIds.includes(message.modelID)) ||
    !message.id ||
    atMs <= 0
  ) {
    return null;
  }
  return {
    id: message.id,
    atMs,
    providerId: definition.providerId,
    modelId: message.modelID,
    tokens: tokenBucketsFromMessage(message),
  };
}

/**
 * Rebuilds the state file from OpenCode's own message storage, which stays the
 * source of truth; the file only records what the last sync counted.
 */
export async function syncLocalQuotaProviderState(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: LocalStateDependencies = {},
): Promise<LocalQuotaProviderStateV1> {
  const nowMs = dependencies.nowMs ?? Date.now();
  const path = getLocalQuotaProviderStatePath(definition.id, dependencies.runtimeDirs);
  const readMessages = dependencies.readMessages ?? iterCompletedAssistantMessages;
  const writeState =
    dependencies.writeState ??
    ((target, state) => writeJsonAtomic(target, state, { trailingNewline: true }));

  // Keep only what the longest declared window can still count.
  const completedSinceMs = Math.min(
    ...definition.windows.map((window) => windowStart(window, nowMs)),
  );
  const byId = new Map<string, LocalQuotaProviderMessage>();
  for (const raw of await readMessages({ completedSinceMs, completedUntilMs: nowMs })) {
    const message = toStateMessage(definition, raw);
    if (message && message.atMs >= completedSinceMs && message.atMs <= nowMs) {
      byId.set(message.id, message);
    }
  }

  const next: LocalQuotaProviderStateV1 = {
    version: QUOTA_PROVIDER_LOCAL_STATE_VERSION,
    definitionId: definition.id,
    providerId: definition.providerId,
    updatedAt: nowMs,
    messages: [...byId.values()].sort(
      (left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id),
    ),
  };
  await writeState(path, next);
  return next;
}

/** Automatic models.dev matching wins; `pricingModelMap` is only a fallback. */
function resolveMessageCost(
  definition: LocalEstimateQuotaProviderDefinition,
  message: LocalQuotaProviderMessage,
): number | null {
  const automatic = resolvePricingKey({
    providerID: message.providerId,
    modelID: message.modelId,
  });
  if (automatic.ok) {
    const rates = lookupCost(automatic.key.provider, automatic.key.model);
    return rates ? calculateUsdFromTokenBuckets(rates, message.tokens) : null;
  }

  const manual = definition.pricingModelMap?.[message.modelId];
  if (!manual) return null;
  const slash = manual.indexOf("/");
  const rates = lookupCost(manual.slice(0, slash), manual.slice(slash + 1));
  return rates ? calculateUsdFromTokenBuckets(rates, message.tokens) : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function clampedPercentRemaining(used: number, limit: number): number {
  return Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
}

export function computeLocalQuotaProviderEstimate(params: {
  definition: LocalEstimateQuotaProviderDefinition;
  state: LocalQuotaProviderStateV1;
  nowMs?: number;
}): LocalEstimateResult {
  const { definition, state } = params;
  const nowMs = params.nowMs ?? Date.now();
  const entries: QuotaToastEntry[] = [];
  let totalUnpriced = 0;

  const accounting = (resultType: "rate_limit" | "budget"): QuotaToastEntry["accounting"] => ({
    resultType,
    acquisitionMethod: "local_estimation",
    ownership: "user_configured",
    authority: "locally_derived",
    sourceId: definition.id,
    observedAtIso: new Date(state.updatedAt).toISOString(),
  });

  for (const window of definition.windows) {
    const sinceMs = windowStart(window, nowMs);
    const messages = state.messages.filter(
      (message) => message.atMs >= sinceMs && message.atMs <= nowMs,
    );

    let resetTimeIso: string | undefined;
    let fixedWindow: FixedWindowProjectionEvidence | undefined;
    if (window.type === "utc-day") {
      const endsAtMs = sinceMs + DAY_MS;
      resetTimeIso = new Date(endsAtMs).toISOString();
      // The count covers the whole UTC day only when the state was saved inside that day.
      if (sinceMs < state.updatedAt && state.updatedAt < endsAtMs) {
        fixedWindow = {
          kind: "fixed_window",
          startedAtIso: new Date(sinceMs).toISOString(),
          observedAtIso: new Date(state.updatedAt).toISOString(),
          endsAtIso: resetTimeIso,
          fullReset: true,
        };
      }
    } else if (messages[0]) {
      resetTimeIso = new Date(messages[0].atMs + window.durationMinutes! * MINUTE_MS).toISOString();
    }

    entries.push({
      accounting: accounting("rate_limit"),
      kind: "percent",
      name: `${definition.label} ${window.label}`,
      group: definition.label,
      label: `${window.label}:`,
      rowKey: window.id,
      right: `${messages.length}/${window.requestLimit}`,
      percentRemaining: clampedPercentRemaining(messages.length, window.requestLimit),
      ...(resetTimeIso ? { resetTimeIso } : {}),
      ...(fixedWindow ? { fixedWindow } : {}),
    });

    if (window.usdBudget === undefined) continue;

    let costUsd = 0;
    let unpriced = 0;
    for (const message of messages) {
      const cost = resolveMessageCost(definition, message);
      if (cost === null) unpriced += 1;
      else costUsd += cost;
    }
    totalUnpriced += unpriced;

    const budgetCommon = {
      accounting: accounting("budget"),
      name: `${definition.label} ${window.label} budget`,
      group: definition.label,
      label: `${window.label} budget:`,
      // Window ids are kebab-case, so "_budget" can't collide with another window's id.
      rowKey: `${window.id}_budget`,
      ...(resetTimeIso ? { resetTimeIso } : {}),
    };
    // A partial sum would understate spend, so any unpriced request hides the budget percent.
    if (unpriced > 0) {
      entries.push({
        ...budgetCommon,
        kind: "value",
        value: `Unavailable (${unpriced} unpriced request${unpriced === 1 ? "" : "s"})`,
      });
    } else {
      entries.push({
        ...budgetCommon,
        kind: "percent",
        right: `${formatUsd(costUsd)}/${formatUsd(window.usdBudget)}`,
        percentRemaining: clampedPercentRemaining(costUsd, window.usdBudget),
        ...(fixedWindow ? { fixedWindow } : {}),
      });
    }
  }

  return { entries, state, unpricedMessageCount: totalUnpriced };
}

export async function collectLocalQuotaProviderEstimate(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: LocalStateDependencies = {},
): Promise<LocalEstimateResult> {
  const state = await syncLocalQuotaProviderState(definition, dependencies);
  return computeLocalQuotaProviderEstimate({ definition, state, nowMs: dependencies.nowMs });
}

export async function inspectLocalQuotaProviderState(
  definition: LocalEstimateQuotaProviderDefinition,
  dependencies: Pick<LocalStateDependencies, "runtimeDirs" | "readText"> = {},
): Promise<LocalQuotaProviderStateDiagnostics> {
  const path = getLocalQuotaProviderStatePath(definition.id, dependencies.runtimeDirs);
  const readText = dependencies.readText ?? ((target) => readFile(target, "utf8"));
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(path));
  } catch (error) {
    const missing = isRecord(error) && String(error.code) === "ENOENT";
    return {
      path,
      exists: !missing,
      health: missing ? "missing" : "malformed",
      version: null,
      lastUpdatedAt: null,
    };
  }

  const record = asRecord(raw);
  const health = stateHealth(record, definition);
  // A healthy file reports its own save time; anything else falls back to the file time.
  const lastUpdatedAt =
    health === "healthy"
      ? Math.trunc(Number(record?.updatedAt))
      : await stat(path).then(
          (stats) => stats.mtimeMs,
          () => null,
        );
  return {
    path,
    exists: true,
    health,
    version: typeof record?.version === "number" ? record.version : null,
    lastUpdatedAt,
  };
}
