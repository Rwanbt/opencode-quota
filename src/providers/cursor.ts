import {
  CURSOR_CANONICAL_PLUGIN_PACKAGE,
  inspectCursorAuthPresence,
  inspectCursorOpenCodeIntegration,
} from "../lib/cursor-detection.js";
import {
  getCursorPlanDisplayName,
  getEffectiveCursorIncludedApiUsd,
  isCursorModelId,
  isCursorProviderId,
} from "../lib/cursor-pricing.js";
import { getCurrentCursorUsageSummary } from "../lib/cursor-usage.js";
import type {
  AccountingMetadata,
  AccountingQuantity,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const BUDGET_ACCOUNTING: AccountingMetadata = {
  resultType: "budget",
  acquisitionMethod: "local_runtime_accounting",
  ownership: "maintained",
  authority: "locally_derived",
};
const SPEND_ACCOUNTING: AccountingMetadata = {
  ...BUDGET_ACCOUNTING,
  resultType: "spend",
};
const USD_UNIT = { kind: "currency", code: "USD" } as const;

function usdQuantity(amount: number): AccountingQuantity {
  return { decimal: accountingDecimalFromNumber(amount), unit: USD_UNIT };
}

function formatUsage(bucket: { costUsd: number; messageCount: number }): string {
  return `${fmtUsdAmount(bucket.costUsd)} across ${bucket.messageCount.toLocaleString("en-US")} messages`;
}

export const cursorProvider: QuotaProvider = {
  id: "cursor",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const availableViaProviderConfig = await isCanonicalProviderAvailable({
      ctx,
      providerId: "cursor",
      fallbackOnError: false,
    });
    if (availableViaProviderConfig) return true;
    if (isCursorProviderId(ctx.config.currentProviderID)) return true;
    if (isCursorModelId(ctx.config.currentModel)) return true;

    const integration = await inspectCursorOpenCodeIntegration();
    return integration.pluginEnabled || integration.providerConfigured;
  },

  matchesCurrentModel(model: string): boolean {
    return isCursorModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const planLabel = getCursorPlanDisplayName(ctx.config.cursorPlan);
    const group = planLabel ? `Cursor (${planLabel})` : "Cursor";
    const includedApiUsd = getEffectiveCursorIncludedApiUsd({
      plan: ctx.config.cursorPlan,
      overrideUsd: ctx.config.cursorIncludedApiUsd,
    });
    const [usage, auth, integration] = await Promise.all([
      getCurrentCursorUsageSummary({
        billingCycleStartDay: ctx.config.cursorBillingCycleStartDay,
      }),
      inspectCursorAuthPresence(),
      inspectCursorOpenCodeIntegration(),
    ]);
    const statusDetails = statusDetailsFromRecord({
      plan: planLabel ?? "none",
      included_api_usd:
        typeof includedApiUsd === "number" ? fmtUsdAmount(includedApiUsd) : "(none)",
      billing_cycle_start_day:
        typeof ctx.config.cursorBillingCycleStartDay === "number"
          ? String(ctx.config.cursorBillingCycleStartDay)
          : "(calendar month)",
      auth_state: auth.state,
      auth_selected_path: auth.selectedPath ?? "(none)",
      auth_present_paths: auth.presentPaths.join(" | ") || "(none)",
      auth_candidate_paths: auth.candidatePaths.join(" | ") || "(none)",
      auth_error: auth.error,
      plugin_enabled: integration.pluginEnabled ? "true" : "false",
      canonical_plugin_package: CURSOR_CANONICAL_PLUGIN_PACKAGE,
      provider_configured: integration.providerConfigured ? "true" : "false",
      config_matches: integration.matchedPaths.join(" | ") || "(none)",
      config_checked_paths: integration.checkedPaths.join(" | ") || "(none)",
      cycle_source: usage.window.source,
      cycle_reset_at: usage.window.resetTimeIso,
      api_usage: formatUsage(usage.api),
      auto_composer_usage: formatUsage(usage.autoComposer),
      total_cursor_usage: formatUsage(usage.total),
      unknown_cursor_models: usage.unknownModels.length.toLocaleString("en-US"),
    });

    if (usage.total.messageCount === 0 && includedApiUsd === undefined) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    const hasPartialApiCoverage = usage.unknownModels.length > 0;
    const hasPositiveAllowance = includedApiUsd !== undefined && includedApiUsd > 0;
    const errors = hasPartialApiCoverage
      ? [
          {
            label: "Cursor",
            message: "Unknown Cursor model ids present in local history (see /quota_status)",
          },
        ]
      : [];
    const entries: QuotaToastEntry[] = [];
    const resetTimeIso = usage.window.resetTimeIso;
    const fixedWindow =
      usage.window.source === "configured_day" &&
      usage.window.sinceMs < usage.observedAtMs &&
      usage.observedAtMs < usage.window.untilMs
        ? ({
            kind: "fixed_window",
            startedAtIso: new Date(usage.window.sinceMs).toISOString(),
            observedAtIso: new Date(usage.observedAtMs).toISOString(),
            endsAtIso: new Date(usage.window.untilMs).toISOString(),
            fullReset: true,
          } as const)
        : undefined;

    if (hasPositiveAllowance && !hasPartialApiCoverage) {
      const remainingUsd = Math.max(0, includedApiUsd - usage.api.costUsd);
      entries.push({
        accounting: BUDGET_ACCOUNTING,
        name: planLabel ? `Cursor API (${planLabel})` : "Cursor API",
        group,
        percentRemaining: 100 - (usage.api.costUsd / includedApiUsd) * 100,
        resetTimeIso,
        ...(fixedWindow ? { fixedWindow } : {}),
        semantic: {
          metric: { kind: "named", name: "API" },
          prominence: "primary",
        },
        basis: {
          used: { quantity: usdQuantity(usage.api.costUsd), authority: "locally_derived" },
          limit: {
            quantity: usdQuantity(includedApiUsd),
            authority:
              ctx.config.cursorIncludedApiUsd === undefined ? "locally_derived" : "user_configured",
          },
          remaining: { quantity: usdQuantity(remainingUsd), authority: "locally_derived" },
        },
      });
    } else {
      const metricName = hasPartialApiCoverage ? "Known API" : "API";
      entries.push({
        kind: "quantity",
        accounting: SPEND_ACCOUNTING,
        name: `cursor-${hasPartialApiCoverage ? "known-api" : "api"}-spend`,
        group,
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: metricName },
          prominence: "primary",
        },
        quantity: usdQuantity(usage.api.costUsd),
      });
    }

    if (usage.autoComposer.messageCount > 0 || includedApiUsd !== undefined) {
      entries.push({
        kind: "quantity",
        accounting: SPEND_ACCOUNTING,
        name: "cursor-auto-composer-spend",
        group,
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "Auto+Composer" },
          prominence: "supplementary",
        },
        quantity: usdQuantity(usage.autoComposer.costUsd),
      });
    }

    return withStatusDetails(attemptedResult(entries, errors), statusDetails);
  },
};
