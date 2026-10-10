import {
  type AlibabaTokenPlanClosedResult,
  type AlibabaTokenPlanWindow,
  isAlibabaTokenPlanSupportedPlatform,
  queryAlibabaTokenPlanQuota,
} from "../lib/alibaba-token-plan.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const GROUP = "Alibaba Personal Token Plan";
const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "local_cli",
  ownership: "maintained",
  authority: "provider_reported",
} as const satisfies QuotaToastEntry["accounting"];

function windowEntry(
  window: AlibabaTokenPlanWindow,
  suffix: string,
  label: string,
): QuotaToastEntry {
  return {
    accounting: { ...ACCOUNTING },
    name: `${GROUP} ${suffix}`,
    group: GROUP,
    label,
    percentRemaining: window.percentRemaining,
    ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
  };
}

function statusDetailsFromResult(
  result: AlibabaTokenPlanClosedResult,
): ReturnType<typeof statusDetailsFromRecord> {
  if (result.ok) {
    const windows = [result.fiveHour ? "5h" : "", result.weekly ? "weekly" : ""].filter(Boolean);
    return statusDetailsFromRecord({
      cli_available: "true",
      platform: process.platform,
      windows: windows.join(",") || "(none)",
    });
  }
  return statusDetailsFromRecord({
    cli_available: result.error.kind === "executable_not_found" ? "false" : "true",
    platform: process.platform,
    failure_kind: result.error.kind,
  });
}

function mapClosedResult(result: AlibabaTokenPlanClosedResult): QuotaProviderResult {
  if (result.ok) {
    const entries: QuotaToastEntry[] = [];
    if (result.fiveHour) entries.push(windowEntry(result.fiveHour, "5h", "5h:"));
    if (result.weekly) entries.push(windowEntry(result.weekly, "Weekly", "Weekly:"));
    return attemptedResult(entries);
  }
  if (result.error.kind === "unsupported_platform") {
    return notAttemptedResult();
  }
  return attemptedErrorResult(GROUP, result.error.message, {
    retryable: result.error.retryable === true,
  });
}

export const alibabaTokenPlanProvider: QuotaProvider = {
  id: "alibaba-token-plan",

  // Never probes PATH: availability comes from selection or the current runtime identity.
  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    if (!isAlibabaTokenPlanSupportedPlatform()) return false;

    const selected = await isCanonicalProviderAvailable({
      ctx,
      providerId: "alibaba-token-plan",
      fallbackOnError: false,
    });
    if (selected || ctx.config.currentProviderID === "alibaba-token-plan") return true;
    const currentModel = ctx.config.currentModel;
    return !!currentModel && modelProviderMatchesRuntimeId(currentModel, "alibaba-token-plan");
  },

  matchesCurrentModel(model: string, context): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID === "alibaba-token-plan";
    }
    return modelProviderMatchesRuntimeId(model, "alibaba-token-plan");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryAlibabaTokenPlanQuota({
      requestTimeoutMs: ctx.config.requestTimeoutMs,
      runtime: { cwd: ctx.workspaceRoot },
    });
    return withStatusDetails(mapClosedResult(result), statusDetailsFromResult(result));
  },
};
