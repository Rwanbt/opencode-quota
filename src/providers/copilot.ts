/**
 * Copilot provider wrapper.
 *
 * Normalizes GitHub AI Credit and explicitly eligible legacy PRU accounting
 * into the shared provider/result boundary.
 */

import {
  COPILOT_AUTH_KEYS,
  type CopilotQuotaAuthDiagnostics,
  getCopilotQuotaAuthDiagnostics,
  hasCopilotQuotaRuntimeAvailable,
  queryCopilotQuota,
} from "../lib/copilot.js";
import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import {
  type CredentialRow,
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readAuthFileCached,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelIncludesAny, modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import type {
  AuthData,
  CopilotBudgetResult,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotPlanResult,
  CopilotQuotaResult,
} from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type CopilotSuccessResult =
  | CopilotQuotaResult
  | CopilotPlanResult
  | CopilotOrganizationUsageResult
  | CopilotEnterpriseUsageResult;

function remoteAccounting(
  resultType: AccountingMetadata["resultType"],
  authority: AccountingMetadata["authority"],
): AccountingMetadata {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority,
  };
}

function formatBillingPeriod(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function getCopilotGroup(mode: CopilotSuccessResult["mode"], plan?: string): string {
  if (mode === "organization_usage" || mode === "enterprise_usage") {
    return "Copilot (business)";
  }
  return plan ? `Copilot (${plan})` : "Copilot (personal)";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatAiCreditUsageValue(
  result: CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult | CopilotQuotaResult,
): string {
  const parts = [`Used ${formatNumber(result.used)}`];

  if (result.includedUsed !== undefined) {
    parts.push(`Included ${formatNumber(result.includedUsed)}`);
  }
  if (result.billedUsed !== undefined) {
    const billedAmount =
      result.billedAmountUsd === undefined ? "" : ` (${formatUsd(result.billedAmountUsd)})`;
    parts.push(`Billed ${formatNumber(result.billedUsed)}${billedAmount}`);
  } else if (result.billedAmountUsd !== undefined) {
    parts.push(`Billed ${formatUsd(result.billedAmountUsd)}`);
  }

  if (result.mode !== "user_quota") {
    parts.push(formatBillingPeriod(result.period));
    if (result.mode === "organization_usage") {
      parts.push(`org=${result.organization}`);
    } else {
      parts.push(`enterprise=${result.enterprise}`);
      if (result.organization) parts.push(`org=${result.organization}`);
    }
    if (result.username) parts.push(`user=${result.username}`);
  }

  return parts.join(" | ");
}

function makeBudgetEntry(
  budget: CopilotBudgetResult,
  group: string,
  resetTimeIso?: string,
): QuotaToastEntry {
  const base = {
    accounting: remoteAccounting("budget", budget.authority),
    name: "Copilot Additional Usage",
    group,
    label: "Budget:",
  };
  const spent = budget.spentUsd;
  if (budget.percentRemaining !== undefined && spent !== undefined && budget.amountUsd > 0) {
    return {
      ...base,
      right: `${formatUsd(spent)}/${formatUsd(budget.amountUsd)}`,
      percentRemaining: budget.percentRemaining,
      resetTimeIso,
    };
  }

  const value =
    spent === undefined
      ? `${formatUsd(budget.amountUsd)} limit | scope=${budget.scope}`
      : `${formatUsd(spent)} spent | ${formatUsd(budget.amountUsd)} budget | scope=${budget.scope}`;
  return { kind: "value", ...base, value, resetTimeIso };
}

function personalEntry(result: CopilotQuotaResult): QuotaToastEntry {
  const group = getCopilotGroup(result.mode, result.plan);
  const name =
    result.unit === "ai_credits"
      ? "Copilot AI Credits"
      : result.unit === "premium_interactions"
        ? "Copilot Premium Interactions"
        : "Copilot Premium Requests";

  if (result.unlimited) {
    return {
      kind: "value",
      accounting: remoteAccounting("quota", result.authority),
      name,
      group,
      label: "Quota:",
      value: "Unlimited",
      resetTimeIso: result.resetTimeIso,
    };
  }
  if (result.total !== undefined && result.total > 0 && result.percentRemaining !== undefined) {
    return {
      accounting: remoteAccounting("quota", result.authority),
      name,
      group,
      label: result.unit === "ai_credits" ? "Credits:" : "Quota:",
      right: `${formatNumber(result.used)}/${formatNumber(result.total)}`,
      percentRemaining: result.percentRemaining,
      resetTimeIso: result.resetTimeIso,
    };
  }
  return {
    kind: "value",
    accounting: remoteAccounting("usage", result.authority),
    name,
    group,
    label: result.unit === "ai_credits" ? "Credits:" : "Usage:",
    value:
      result.unit === "ai_credits"
        ? formatAiCreditUsageValue(result)
        : `Used ${formatNumber(result.used)}`,
    resetTimeIso: result.resetTimeIso,
  };
}

function resultEntries(result: CopilotSuccessResult): QuotaToastEntry[] {
  if (result.mode === "user_quota") return [personalEntry(result)];
  if (result.mode === "user_plan") {
    return [
      {
        kind: "value",
        accounting: remoteAccounting("quota", result.authority),
        name: "Copilot",
        group: getCopilotGroup(result.mode, result.plan),
        label: "Plan:",
        value: result.plan
          ? `${result.plan} | usage needs billing token`
          : "Usage needs billing token",
        resetTimeIso: result.resetTimeIso,
      },
    ];
  }

  const group = getCopilotGroup(result.mode);
  const entries: QuotaToastEntry[] = [
    {
      kind: "value",
      accounting: remoteAccounting("usage", result.authority),
      name: "Copilot AI Credits",
      group,
      label: "Credits:",
      value: formatAiCreditUsageValue(result),
      resetTimeIso: result.resetTimeIso,
    },
  ];
  if (result.budget) {
    entries.push(makeBudgetEntry(result.budget, group, result.resetTimeIso));
  }
  return entries;
}

function resultWarnings(result: CopilotSuccessResult): string[] {
  return result.mode === "user_plan" ? [] : (result.warnings ?? []);
}

function copilotStatusDetails(diagnostics: CopilotQuotaAuthDiagnostics) {
  const managedBilling =
    diagnostics.billingMode === "organization_usage" ||
    diagnostics.billingMode === "enterprise_usage";
  return statusDetailsFromRecord({
    pat_state: diagnostics.pat.state,
    pat_path: diagnostics.pat.selectedPath,
    pat_token_kind: diagnostics.pat.tokenKind,
    pat_tier: diagnostics.pat.config?.tier,
    billing_model: diagnostics.billingModel,
    pat_organization: diagnostics.pat.config?.organization,
    pat_enterprise: diagnostics.pat.config?.enterprise,
    deployment: diagnostics.deployment,
    api_host: diagnostics.apiHost ?? "(none)",
    enterprise_host_source: diagnostics.enterpriseHostSource,
    enterprise_host_error: diagnostics.enterpriseHostError,
    billing_mode: diagnostics.billingMode,
    billing_scope: diagnostics.billingScope,
    quota_api: diagnostics.quotaApi,
    budget_api: diagnostics.budgetApi,
    billing_api_access_likely: diagnostics.billingApiAccessLikely ? "true" : "false",
    remaining_totals_state: diagnostics.remainingTotalsState,
    billing_period: diagnostics.queryPeriod
      ? formatBillingPeriod(diagnostics.queryPeriod)
      : undefined,
    username_filter: diagnostics.usernameFilter,
    billing_usage_note: managedBilling
      ? `${diagnostics.billingMode === "organization_usage" ? "organization" : "enterprise"} AI Credit usage for the current UTC calendar month`
      : undefined,
    remaining_quota_note: managedBilling
      ? "the usage report exposes included-pool consumption and billed usage, but no included-pool denominator; percentages require a real budget"
      : undefined,
    token_compatibility_error: diagnostics.tokenCompatibilityError,
    pat_error: diagnostics.pat.error,
    pat_checked_paths: diagnostics.pat.checkedPaths.join(" | ") || "(none)",
    oauth_configured: `${diagnostics.oauth.configured ? "true" : "false"} key=${diagnostics.oauth.keyName ?? "(none)"} refresh=${diagnostics.oauth.hasRefreshToken ? "true" : "false"} access=${diagnostics.oauth.hasAccessToken ? "true" : "false"} enterprise_host=${diagnostics.oauth.hasEnterpriseUrl ? "true" : "false"}`,
    effective_source: diagnostics.effectiveSource,
    oauth_accounting_state: diagnostics.oauthAccountingState,
    override: diagnostics.override,
  });
}

/** One query per OpenCode Copilot login, each shown under its own credential name. */
async function fetchPerCredential(
  credentials: CredentialRow[],
  requestTimeoutMs?: number,
): Promise<QuotaProviderResult> {
  // A failed login stays in the list so it shows as its own error row.
  const results = await Promise.all(
    credentials.map(async (row) => ({
      row,
      result: await queryCopilotQuota({
        requestTimeoutMs,
        authData: { [row.integrationId]: credentialRowAuthEntry(row) } as AuthData,
      }),
    })),
  );
  const names = formatCredentialDisplayNames(
    "Copilot",
    results.map(({ row, result }) => ({
      row,
      fallbackName: result?.success
        ? getCopilotGroup(result.mode, "plan" in result ? result.plan : undefined)
        : "Copilot",
    })),
  );
  const entries: QuotaToastEntry[] = [];
  const errors: QuotaToastError[] = [];
  for (const [index, { row, result }] of results.entries()) {
    if (!result) continue;
    const group = names[index] ?? "Copilot";
    if (!result.success) {
      errors.push({ label: group, message: result.error });
      continue;
    }
    for (const entry of resultEntries(result)) {
      entries.push({ ...entry, group, accounting: { ...entry.accounting, sourceId: row.id } });
    }
    for (const message of resultWarnings(result)) errors.push({ label: group, message });
  }
  return attemptedResult(entries, errors);
}

export const copilotProvider: QuotaProvider = {
  id: "copilot",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "copilot",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    try {
      return await hasCopilotQuotaRuntimeAvailable();
    } catch {
      return false;
    }
  },

  matchesCurrentModel(model: string): boolean {
    if (modelProviderIncludesAny(model, ["copilot", "github"])) return true;
    return modelIncludesAny(model, ["copilot", "github-copilot"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    const diagnostics = getCopilotQuotaAuthDiagnostics(
      await readAuthFileCached({ maxAgeMs: 5_000, integrationIds: COPILOT_AUTH_KEYS }),
    );
    const statusDetails = copilotStatusDetails(diagnostics);
    if (diagnostics.effectiveSource === "oauth") {
      const credentials = await readCredentialRows(COPILOT_AUTH_KEYS, { methods: ["oauth"] });
      if (credentials.length > 0) {
        return withStatusDetails(
          await fetchPerCredential(credentials, requestTimeoutMs),
          statusDetails,
        );
      }
    }

    const result = await queryCopilotQuota({ requestTimeoutMs });
    if (!result) return withStatusDetails(notAttemptedResult(), statusDetails);
    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Copilot", result.error), statusDetails);
    }

    const errors = resultWarnings(result).map((message) => ({ label: "Copilot", message }));
    const presentation =
      result.mode === "enterprise_usage"
        ? { singleWindowDisplayName: `Copilot Enterprise (${result.enterprise})` }
        : result.mode === "organization_usage"
          ? { singleWindowDisplayName: `Copilot Org (${result.organization})` }
          : undefined;
    return withStatusDetails(
      attemptedResult(resultEntries(result), errors, presentation),
      statusDetails,
    );
  },
};
