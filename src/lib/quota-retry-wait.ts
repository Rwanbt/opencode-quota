/**
 * `waitForQuotaReset` (on by default): when a model request hits a provider limit and the quota data
 * shows a used-up window for that model's provider, OpenCode retries once that window resets
 * instead of following its normal retry timing.
 */
import type { ServerSettings } from "../core/provider-source.js";
import type { QuotaStore } from "../core/store.js";
import type { QuotaRow } from "../core/types.js";

/** Extra wait after the reset time, so the provider has reset the window when the retry runs. */
export const QUOTA_RESET_RETRY_BUFFER_MS = 60_000;
/** Longest single wait. If the window is still used up, the next retry waits again. */
export const QUOTA_RESET_RETRY_MAX_DELAY_MS = 5 * 60 * 60 * 1000;

/** The parts of OpenCode's retry event this feature reads. */
export type QuotaRetryEvent = {
  readonly model: { readonly id: string; readonly providerID: string };
  readonly error: { readonly type: string; readonly status?: number };
};

/** Where the retry decision reads quota and settings from. */
export type QuotaRetryHost = {
  store: Pick<QuotaStore, "refresh">;
  loadSettings: () => Promise<Pick<ServerSettings, "waitForQuotaReset" | "providerIdsForModel">>;
};

/** OpenCode's error types for a provider rate limit or used-up quota, or any HTTP 429. */
export function isQuotaLimitError(error: QuotaRetryEvent["error"]): boolean {
  return (
    error.type === "provider.rate-limit" || error.type === "provider.quota" || error.status === 429
  );
}

/**
 * Milliseconds until the earliest reset among used-up (0% left) windows, plus the buffer, at
 * most the cap. Undefined when no used-up window has a reset time still ahead.
 */
export function getQuotaResetRetryDelayMs(
  rows: readonly QuotaRow[],
  nowMs: number,
): number | undefined {
  let earliestResetMs: number | undefined;
  for (const row of rows) {
    if (row.percentRemaining === undefined || !(row.percentRemaining <= 0) || !row.resetsAt) {
      continue;
    }
    const resetMs = Date.parse(row.resetsAt);
    if (!(resetMs > nowMs)) continue;
    if (earliestResetMs === undefined || resetMs < earliestResetMs) earliestResetMs = resetMs;
  }
  if (earliestResetMs === undefined) return undefined;
  return Math.min(
    earliestResetMs - nowMs + QUOTA_RESET_RETRY_BUFFER_MS,
    QUOTA_RESET_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The retry delay for a limit error on `event.model`, or undefined to keep OpenCode's decision.
 * The store asks the model's providers again at once (a retry refresh has no minimum interval):
 * the limit error itself shows the quota changed, so only rows read for this retry count.
 */
export async function resolveQuotaResetRetryDelayMs(
  host: QuotaRetryHost,
  event: QuotaRetryEvent,
): Promise<number | undefined> {
  if (!isQuotaLimitError(event.error)) return undefined;
  const settings = await host.loadSettings();
  if (!settings.waitForQuotaReset) return undefined;
  const providerIds = settings.providerIdsForModel(event.model);
  if (providerIds.length === 0) return undefined;
  const startedAtMs = Date.now();
  const snapshot = await host.store.refresh({ reason: "retry", providerIds });
  const freshRows = snapshot.providers
    .filter(
      (provider) =>
        providerIds.includes(provider.providerId) && (provider.okAtMs ?? 0) >= startedAtMs,
    )
    .flatMap((provider) => provider.rows);
  return getQuotaResetRetryDelayMs(freshRows, Date.now());
}
