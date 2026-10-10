import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import { scrubCredentialErrorText } from "../lib/opencode-auth.js";
import {
  consoleBaseUrl,
  type OpenCodeConsoleCredential,
  resolveOpenCodeConsoleAuth,
} from "../lib/opencode-console-auth.js";
import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const USD_UNIT = { kind: "currency", code: "USD" } as const;
const LOGIN_HINT = "Run `opencode auth login opencode`.";

/** True when the user listed `opencode` in `enabledProviders` instead of using auto mode. */
function isExplicitlyEnabled(ctx: QuotaProviderContext): boolean {
  return (
    Array.isArray(ctx.config.enabledProviders) && ctx.config.enabledProviders.includes("opencode")
  );
}

function signInFailedResult(state: "expired" | "invalid", detail: string): QuotaProviderResult {
  return withStatusDetails(
    attemptedErrorResult(
      OPENCODE_ZEN_GROUP,
      `OpenCode Console sign-in failed: ${detail}. ${LOGIN_HINT}`,
    ),
    [{ key: "console_auth_state", value: state }],
  );
}

/** Never includes the token. */
function consoleStatusDetails(credential: OpenCodeConsoleCredential): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    console_auth_state: "configured",
    console_server: consoleBaseUrl(credential),
    console_org: credential.orgName ?? credential.orgId ?? "(none)",
  });
}

function zenAccounting(
  resultType: AccountingMetadata["resultType"],
  authority: AccountingMetadata["authority"] = "provider_reported",
): AccountingMetadata {
  return { resultType, acquisitionMethod: "remote_api", ownership: "maintained", authority };
}

function zenUsdDecimal(value: number): string {
  return value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}

function usdQuantity(value: number) {
  return { decimal: zenUsdDecimal(value), unit: USD_UNIT };
}

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // An expired or failed sign-in stays available so fetch() can show its hint.
    // Without a Console sign-in, auto mode stays quiet; an explicit
    // enabledProviders entry keeps Zen so fetch() can show the sign-in hint.
    const consoleAuth = await resolveOpenCodeConsoleAuth();
    return consoleAuth.state !== "none" || isExplicitlyEnabled(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const consoleAuth = await resolveOpenCodeConsoleAuth();

    if (consoleAuth.state === "none") {
      const noneResult = isExplicitlyEnabled(ctx)
        ? attemptedErrorResult(
            OPENCODE_ZEN_GROUP,
            `No OpenCode Console sign-in found. ${LOGIN_HINT}`,
          )
        : notAttemptedResult();
      return withStatusDetails(noneResult, [{ key: "console_auth_state", value: "none" }]);
    }

    if (consoleAuth.state === "invalid") {
      return signInFailedResult("invalid", scrubCredentialErrorText(consoleAuth.error));
    }

    if (consoleAuth.state === "expired") {
      // OpenCode refreshes the Console token when it is read, so this is rare.
      return signInFailedResult("expired", "the sign-in expired");
    }

    const { credential } = consoleAuth;
    const statusDetails = consoleStatusDetails(credential);

    const result = await queryOpenCodeZenQuota(credential, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult(OPENCODE_ZEN_GROUP, result.error), [
        ...statusDetails,
        { key: "live_fetch_error", value: result.error },
      ]);
    }

    const { data } = result;
    const balanceUsd = data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit = configuredMonthlyLimit ?? data.monthlyLimit;
    const monthlyUsageUsd =
      data.monthlyUsage === null ? null : data.monthlyUsage / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;

    const hasMonthlyUsage =
      monthlyUsageUsd !== null && Number.isFinite(monthlyUsageUsd) && monthlyUsageUsd >= 0;
    const hasMonthlyBudget =
      effectiveMonthlyLimit !== null &&
      Number.isFinite(effectiveMonthlyLimit) &&
      effectiveMonthlyLimit > 0 &&
      hasMonthlyUsage;
    const entries: QuotaToastEntry[] = [];

    if (hasMonthlyBudget) {
      const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
      entries.push({
        accounting: zenAccounting("budget", "locally_derived"),
        name: "zen-monthly-budget",
        group: OPENCODE_ZEN_GROUP,
        percentRemaining: Math.min(100, (monthlyRemainingUsd / effectiveMonthlyLimit) * 100),
        ...(data.budgetResetIso ? { resetTimeIso: data.budgetResetIso } : {}),
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
        basis: {
          used: { quantity: usdQuantity(monthlyUsageUsd), authority: "provider_reported" },
          limit: {
            quantity: usdQuantity(effectiveMonthlyLimit),
            authority:
              configuredMonthlyLimit === undefined ? "provider_reported" : "user_configured",
          },
          remaining: { quantity: usdQuantity(monthlyRemainingUsd), authority: "locally_derived" },
        },
      });
    } else if (hasMonthlyUsage) {
      // No limit to measure against: still show this month's real spend.
      entries.push({
        accounting: zenAccounting("spend"),
        kind: "quantity",
        name: "zen-monthly-spend",
        group: OPENCODE_ZEN_GROUP,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
        quantity: usdQuantity(monthlyUsageUsd),
      });
    }

    entries.push({
      accounting: zenAccounting("balance"),
      kind: "quantity",
      name: "zen-current-balance",
      group: OPENCODE_ZEN_GROUP,
      semantic: {
        metric: { kind: "component", component: "current_balance" },
        prominence: hasMonthlyBudget ? "supplementary" : "primary",
      },
      quantity: usdQuantity(balanceUsd),
    });
    if (data.reload !== null) {
      entries.push({
        accounting: zenAccounting("status"),
        kind: "boolean",
        name: "zen-auto-reload",
        group: OPENCODE_ZEN_GROUP,
        semantic: {
          metric: { kind: "component", component: "auto_reload" },
          prominence: "supplementary",
        },
        value: data.reload,
      });
    }

    const errors = result.errors.map((message) => ({ label: OPENCODE_ZEN_GROUP, message }));
    const usdText = (value: number) => `USD ${zenUsdDecimal(value)}`;

    return withStatusDetails(attemptedResult(entries, errors), [
      ...statusDetails,
      ...statusDetailsFromRecord({
        balance_usd: usdText(balanceUsd),
        monthly_limit_usd: data.monthlyLimit === null ? "(none)" : usdText(data.monthlyLimit),
        monthly_usage_usd: monthlyUsageUsd === null ? "(unknown)" : usdText(monthlyUsageUsd),
        budget_source: data.budgetSource,
        auto_reload: data.reload === null ? "(unknown)" : String(data.reload),
        auto_reload_amount_raw: data.reloadAmount === null ? "(none)" : String(data.reloadAmount),
        auto_reload_trigger_raw:
          data.reloadTrigger === null ? "(none)" : String(data.reloadTrigger),
        live_fetch_error: result.errors.length > 0 ? result.errors.join(" | ") : undefined,
      }),
    ]);
  },
};
