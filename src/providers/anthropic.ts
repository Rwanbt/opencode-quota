/**
 * Anthropic Claude provider wrapper.
 *
 * Normalizes Claude CLI-exposed quota windows into generic toast entries.
 */

import {
  type AnthropicQuotaResult,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuota,
  queryAnthropicQuotaWithOAuth,
} from "../lib/anthropic.js";
import { resolveAnthropicOAuth } from "../lib/anthropic-auth.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaPercentEntry,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { AuthData } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type AcquisitionMethod = QuotaToastEntry["accounting"]["acquisitionMethod"];

function formatWindowDetail(
  window: { percentRemaining: number; resetTimeIso?: string } | undefined,
): string | undefined {
  return window
    ? `${window.percentRemaining}% reset_at=${window.resetTimeIso ?? "(none)"}`
    : undefined;
}

/** The 5h, Weekly, Usage Credits and Fable weekly rows for one Claude account. */
function quotaEntries(
  quota: AnthropicQuotaResult,
  group: string,
  acquisitionMethod: AcquisitionMethod,
  sourceId?: string,
): QuotaToastEntry[] {
  const rows: Omit<QuotaPercentEntry, "accounting">[] = [
    {
      name: `${group} 5h`,
      group,
      label: "5h:",
      percentRemaining: quota.five_hour.percentRemaining,
      resetTimeIso: quota.five_hour.resetTimeIso,
    },
    {
      name: `${group} Weekly`,
      group,
      label: "Weekly:",
      percentRemaining: quota.seven_day.percentRemaining,
      resetTimeIso: quota.seven_day.resetTimeIso,
    },
  ];
  if (quota.extra_usage) {
    rows.push({
      name: `${group} Usage Credits`,
      group: `${group} Usage Credits`,
      label: "Monthly:",
      percentRemaining: quota.extra_usage.percentRemaining,
    });
  }
  if (quota.fable_weekly) {
    rows.push({
      name: `${group} Fable Weekly`,
      group,
      label: "Fable:",
      semantic: { metric: { kind: "named", name: "Fable weekly" }, prominence: "primary" },
      percentRemaining: quota.fable_weekly.percentRemaining,
      resetTimeIso: quota.fable_weekly.resetTimeIso,
    });
  }

  return rows.map((row) => ({
    accounting: {
      resultType: "quota",
      acquisitionMethod,
      ownership: "maintained",
      authority: "provider_reported",
      ...(sourceId === undefined ? {} : { sourceId }),
    },
    ...row,
  }));
}

export const anthropicProvider: QuotaProvider = {
  id: "anthropic",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "anthropic",
      fallbackOnError: false,
    });
    if (!providerAvailable) return false;

    return await hasAnthropicCredentialsConfigured({
      binaryPath: ctx.config?.anthropicBinaryPath,
    });
  },

  matchesCurrentModel(model: string): boolean {
    return model.toLowerCase().startsWith("anthropic/");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const options = {
      binaryPath: ctx.config?.anthropicBinaryPath,
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    };
    let statusDetails;
    let acquisitionMethod: AcquisitionMethod = "local_cli";
    // A failed login stays in the list so it shows as its own error row.
    const databaseCredentials = (
      await readCredentialRows(["anthropic"], { methods: ["oauth"] })
    ).flatMap((row) => {
      if (row.integrationId !== "anthropic") return [];
      const auth = resolveAnthropicOAuth({ anthropic: credentialRowAuthEntry(row) } as AuthData);
      return auth.state === "configured" || auth.state === "failed" ? [{ row, auth }] : [];
    });
    try {
      const diagnostics = await getAnthropicDiagnostics(options);
      const quota = diagnostics.quotaSupported ? diagnostics.quota : undefined;
      if (diagnostics.quotaSupported && diagnostics.quotaSource !== "claude-auth-status-json") {
        acquisitionMethod = "remote_api";
      }
      statusDetails = statusDetailsFromRecord({
        cli_installed: diagnostics.installed ? "true" : "false",
        cli_version: diagnostics.version ?? "(none)",
        binary_path: diagnostics.binaryPath ?? "(none)",
        auth_status: diagnostics.authStatus,
        quota_supported: diagnostics.quotaSupported ? "true" : "false",
        quota_source: diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
        oauth_credential_source: diagnostics.oauthCredentialSource ?? "(none)",
        checked_commands: diagnostics.checkedCommands.join(" | ") || "(none)",
        message: diagnostics.message,
        five_hour_remaining: formatWindowDetail(quota?.five_hour),
        seven_day_remaining: formatWindowDetail(quota?.seven_day),
        fable_weekly_remaining: formatWindowDetail(quota?.fable_weekly),
      });
    } catch (error) {
      statusDetails = statusDetailsFromRecord({
        cli_installed: "false",
        message: `failed to probe Claude CLI: ${sanitizeDisplayText(error instanceof Error ? error.message : String(error))}`,
      });
    }

    if (databaseCredentials.length > 0) {
      const results = await Promise.all(
        databaseCredentials.map(async ({ row, auth }) => ({
          row,
          result:
            auth.state === "failed"
              ? {
                  success: false as const,
                  error: `Anthropic sign-in could not be read: ${auth.error}. Run \`opencode auth login anthropic\`.`,
                }
              : await queryAnthropicQuotaWithOAuth(auth.accessToken, options.requestTimeoutMs),
        })),
      );
      const names = formatCredentialDisplayNames(
        "Claude",
        results.map(({ row }) => ({ row, fallbackName: "Claude" })),
      );
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [];
      for (const [index, { row, result }] of results.entries()) {
        const group = names[index] ?? "Claude";
        if (!result?.success) {
          if (result) errors.push({ label: group, message: result.error });
          continue;
        }
        entries.push(...quotaEntries(result, group, "remote_api", row.id));
      }
      return withStatusDetails(attemptedResult(entries, errors), statusDetails);
    }

    const result = await queryAnthropicQuota(options);
    if (!result) return withStatusDetails(notAttemptedResult(), statusDetails);
    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Claude", result.error), statusDetails);
    }
    return withStatusDetails(
      attemptedResult(quotaEntries(result, "Claude", acquisitionMethod)),
      statusDetails,
    );
  },
};
