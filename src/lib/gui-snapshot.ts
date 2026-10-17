import type { QuotaExport } from "./quota-export-types.js";

/** A cache-only, presentation-safe percentage window. No account names or raw provider data. */
export type GuiQuotaWindow = {
  window?: string;
  percentRemaining: number;
  resetAt?: number;
  observedAt?: number;
  resultType: "quota" | "rate_limit" | "usage" | "spend" | "budget" | "balance" | "status";
  authority: "provider_reported" | "locally_derived";
};

export type GuiQuotaSnapshot = {
  version: 1;
  generatedAt: number;
  cacheAgeSeconds: number;
  providers: Record<
    string,
    {
      status: "ok" | "partial" | "error" | "unavailable";
      fetchedAt?: number;
      windows: GuiQuotaWindow[];
    }
  >;
};

/**
 * Allowlisted GUI projection of the existing JSON cache export. Never expose
 * names, configured source IDs, monetary/free-text values, errors or rawDetails.
 * This function performs no I/O and cannot refresh providers.
 */
export function toGuiQuotaSnapshot(source: QuotaExport): GuiQuotaSnapshot {
  const providers: GuiQuotaSnapshot["providers"] = {};
  for (const [id, provider] of Object.entries(source.providers)) {
    const windows: GuiQuotaWindow[] = [];
    if (provider.status === "ok" || provider.status === "partial") {
      for (const entry of provider.entries) {
        if (entry.renderType !== "percent" || !Number.isFinite(entry.percentRemaining)) continue;
        windows.push({
          ...(entry.window ? { window: entry.window } : {}),
          percentRemaining: Math.max(0, Math.min(100, entry.percentRemaining)),
          ...(entry.resetAt !== undefined && Number.isFinite(entry.resetAt) && entry.resetAt > 0
            ? { resetAt: entry.resetAt }
            : {}),
          ...(entry.observedAt !== undefined &&
          Number.isFinite(entry.observedAt) &&
          entry.observedAt > 0
            ? { observedAt: entry.observedAt }
            : {}),
          resultType: entry.resultType,
          authority: entry.authority,
        });
      }
    }
    // defineProperty also makes a configured id like "__proto__" a plain data key.
    Object.defineProperty(providers, id, {
      value: {
        status: provider.status,
        ...(provider.status !== "unavailable" ? { fetchedAt: provider.fetchedAt } : {}),
        windows,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    version: 1,
    generatedAt: source.exportedAt,
    cacheAgeSeconds: Math.max(0, source.cacheAgeSeconds),
    providers,
  };
}
