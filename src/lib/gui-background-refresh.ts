import { createExportProviderContext } from "./quota-export.js";
import { collectConcreteEnabledProviderIds } from "./quota-render-data.js";
import { resolveQuotaRuntimeContext } from "./quota-runtime-context.js";
import { fetchQuotaProviderResult } from "./quota-state.js";
import type { QuotaSurfaceHost } from "./quota-surface-data.js";

const MIN_INTERVAL_MS = 300_000;
const ERROR_BACKOFF_MS = 900_000;
const MAX_PROVIDERS = 32;

type Outcome = { intervalMs: number; failed: boolean };

/** Server-side refresh only. Never invoked from snapshot(), hover, or a tool. */
export async function warmGuiQuotaCache(host: QuotaSurfaceHost): Promise<Outcome> {
  const runtime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    configureTelemetry: false,
  });
  const intervalMs = Math.max(MIN_INTERVAL_MS, runtime.config.minIntervalMs);
  if (!runtime.config.enabled || !runtime.config.guiBackgroundRefresh.enabled) {
    return { intervalMs, failed: false };
  }
  const ctx = createExportProviderContext(runtime);
  const eligible = await collectConcreteEnabledProviderIds({
    providers: runtime.providers,
    ctx,
    enabledProviders: runtime.config.enabledProviders,
  });
  let failed = eligible.length > MAX_PROVIDERS;
  for (const provider of runtime.providers
    .filter((item) => eligible.includes(item.id))
    .slice(0, MAX_PROVIDERS)) {
    try {
      const result = await fetchQuotaProviderResult({
        provider,
        ctx,
        ttlMs: intervalMs,
      });
      if (result.errors.length > 0) failed = true;
    } catch {
      // Provider errors can include auth tokens or account metadata; never log them.
      failed = true;
    }
  }
  return { intervalMs, failed };
}

/**
 * One outstanding loop per plugin setup, no overlapping runs. Re-read config
 * each cycle so disabling or changing enabled providers takes effect.
 * Cleanup prevents any new requests, while the cache layer rechecks identity
 * before committing an already-in-flight result.
 */
export function startGuiBackgroundRefresh(warm: () => Promise<Outcome>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped) return;
    let delay = ERROR_BACKOFF_MS;
    try {
      const result = await warm();
      delay = result.failed ? Math.max(ERROR_BACKOFF_MS, result.intervalMs) : result.intervalMs;
    } catch {
      // Do not include potentially sensitive exception messages in logs.
    } finally {
      schedule(delay);
    }
  };
  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
