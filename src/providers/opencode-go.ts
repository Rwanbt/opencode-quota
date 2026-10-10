import { createHash } from "node:crypto";

import {
  API_KEY_LOGIN_VENDORS,
  type ApiKeyLoginDiagnostics,
  getApiKeyLoginDiagnostics,
  parseApiKeyLogin,
  resolveApiKeyLogin,
} from "../lib/api-key-resolver.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import { scrubCredentialErrorText, selectConnectionCredentialRows } from "../lib/opencode-auth.js";
import { consoleBaseUrl, resolveOpenCodeConsoleAuth } from "../lib/opencode-console-auth.js";
import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import { readKeyLoginRows } from "./key-login-rows.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const OPENCODE_GO_AUTH = API_KEY_LOGIN_VENDORS["opencode-go"];
const CONSOLE_LOGIN_HINT = "Run `opencode auth login opencode`.";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_WINDOW_LABELS: Record<OpenCodeGoWindowKey, { name: string; label: string }> = {
  rolling: { name: `${OPENCODE_GO_PROVIDER_LABEL} 5h`, label: "5h:" },
  weekly: { name: `${OPENCODE_GO_PROVIDER_LABEL} Weekly`, label: "Weekly:" },
  monthly: { name: `${OPENCODE_GO_PROVIDER_LABEL} Monthly`, label: "Monthly:" },
};

const notSubscribedCredentialFingerprints = new Set<string>();

export function __resetOpenCodeGoNotSubscribedForTests(): void {
  notSubscribedCredentialFingerprints.clear();
}

function fingerprintCredential(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function retainCurrentCredentialFingerprints(current: ReadonlySet<string>): void {
  for (const fingerprint of notSubscribedCredentialFingerprints) {
    if (!current.has(fingerprint)) notSubscribedCredentialFingerprints.delete(fingerprint);
  }
}

function authStatusDetails(diagnostics: ApiKeyLoginDiagnostics): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    auth_state: diagnostics.state,
    auth_source: diagnostics.source ?? "(none)",
    auth_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    auth_error: diagnostics.state === "invalid" ? diagnostics.error : undefined,
  });
}

function buildOpenCodeGoEntries(
  result: Extract<OpenCodeGoResult, { success: true }>,
  selectedWindows: OpenCodeGoWindowKey[],
  group = OPENCODE_GO_PROVIDER_LABEL,
  sourceId?: string,
): QuotaToastEntry[] {
  const selected = new Set(selectedWindows);
  const entries: QuotaToastEntry[] = [];

  for (const window of OPENCODE_GO_WINDOW_ORDER) {
    if (!selected.has(window)) continue;

    const usage = result[window];
    const labels = OPENCODE_GO_WINDOW_LABELS[window];
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
        ...(sourceId ? { sourceId } : {}),
      },
      name: `${group} ${labels.label.slice(0, -1)}`,
      group,
      label: labels.label,
      percentRemaining: usage.percentRemaining,
      resetTimeIso: usage.resetTimeIso,
    });
  }

  return entries;
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const consoleAuth = await resolveOpenCodeConsoleAuth();
    // A failed sign-in stays available so fetch() can show its error when there is no API key.
    if (
      consoleAuth.state === "configured" ||
      consoleAuth.state === "expired" ||
      consoleAuth.state === "invalid"
    ) {
      return true;
    }
    const auth = await resolveApiKeyLogin(OPENCODE_GO_AUTH);
    if (auth.state !== "configured") {
      notSubscribedCredentialFingerprints.clear();
      return false;
    }
    return true;
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
    const consoleAuth = await resolveOpenCodeConsoleAuth();

    if (consoleAuth.state === "configured") {
      const consoleResult = await queryOpenCodeGoConsoleStatus(consoleAuth.credential, {
        requestTimeoutMs: ctx.config.requestTimeoutMs,
      });
      if (consoleResult.success) {
        return withStatusDetails(
          attemptedResult(
            buildOpenCodeGoEntries(
              consoleResult,
              windows,
              OPENCODE_GO_PROVIDER_LABEL,
              "console:go",
            ),
          ),
          [
            { key: "console_auth_state", value: "configured" },
            {
              key: "console_server",
              value: consoleBaseUrl(consoleAuth.credential),
            },
            { key: "go_source", value: "console" },
            { key: "selected_windows", value: windows.join(",") },
          ],
        );
      }
      if (consoleResult.notSubscribed === true) {
        return withStatusDetails(attemptedResult([]), [
          { key: "console_auth_state", value: "configured" },
          { key: "opencode_go_state", value: "not_subscribed" },
          { key: "selected_windows", value: windows.join(",") },
        ]);
      }
      // Console request failed; fall back to the legacy API-key path below
      // and surface the console error in diagnostics. Without an API key Go
      // stays quiet: the sign-in works, only this request failed.
      const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
      const legacyStatusDetails = [
        ...authStatusDetails(diagnostics),
        { key: "console_auth_state", value: "configured" },
        { key: "console_error", value: consoleResult.error },
        { key: "go_source", value: "legacy_key" },
        { key: "selected_windows", value: windows.join(",") },
      ];
      return await fetchOpenCodeGoLegacy(ctx, diagnostics, legacyStatusDetails);
    }

    if (consoleAuth.state === "expired") {
      // OpenCode refreshes the console token when it is read, so this is rare;
      // fall back to the legacy path, which also still accepts workspace API keys.
      const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
      return await fetchOpenCodeGoLegacy(ctx, diagnostics, [
        { key: "console_auth_state", value: "expired" },
        { key: "go_source", value: "legacy_key" },
      ]);
    }

    if (consoleAuth.state === "invalid") {
      // OpenCode could not return the console sign-in (for example its refresh
      // failed); fall back to the legacy API-key path and surface the console
      // error in diagnostics.
      const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
      const consoleError = scrubCredentialErrorText(consoleAuth.error);
      return await fetchOpenCodeGoLegacy(
        ctx,
        diagnostics,
        [
          ...authStatusDetails(diagnostics),
          { key: "console_auth_state", value: "invalid" },
          { key: "console_error", value: consoleError },
          { key: "go_source", value: "legacy_key" },
          { key: "selected_windows", value: windows.join(",") },
        ],
        `OpenCode Console sign-in failed: ${consoleError}. ${CONSOLE_LOGIN_HINT}`,
      );
    }

    const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
    return await fetchOpenCodeGoLegacy(ctx, diagnostics, [
      ...authStatusDetails(diagnostics),
      { key: "selected_windows", value: windows.join(",") },
    ]);
  },
};

/**
 * The API-key path. `consoleSignInFailure` is set when OpenCode could not return
 * the Console sign-in; without an API key it becomes Go's one error row.
 */
async function fetchOpenCodeGoLegacy(
  ctx: QuotaProviderContext,
  diagnostics: ApiKeyLoginDiagnostics,
  statusDetails?: QuotaProviderResult["statusDetails"],
  consoleSignInFailure?: string,
): Promise<QuotaProviderResult> {
  const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
  const baseStatusDetails = statusDetails ?? [];
  const auth = await resolveApiKeyLogin(OPENCODE_GO_AUTH);

  if (auth.state === "none") {
    notSubscribedCredentialFingerprints.clear();
    if (consoleSignInFailure) {
      return withStatusDetails(
        attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, consoleSignInFailure),
        baseStatusDetails,
      );
    }
    return withStatusDetails(notAttemptedResult(), baseStatusDetails);
  }

  if (diagnostics.source === "opencode.db") {
    // `opencode` is a legacy alias of the `opencode-go` integration in the
    // credential database (see API_KEY_LOGIN_VENDORS). Alias rows must not
    // become additional connections: prefer native rows and collapse rows
    // holding the same credential (e.g. Zen + Go sharing a workspace key).
    // Console OAuth credentials cannot authorize this API and are skipped.
    const { credentials, invalidErrors } = await readKeyLoginRows({
      integrationIds: OPENCODE_GO_AUTH.authKeys,
      label: OPENCODE_GO_PROVIDER_LABEL,
      parseAuth: (auth) => parseApiKeyLogin(OPENCODE_GO_AUTH, auth),
      selectRows: (rows) =>
        selectConnectionCredentialRows(
          rows.filter((row) => row.value.type !== "oauth"),
          "opencode-go",
        ),
    });
    if (credentials.length > 0 || invalidErrors.length > 0) {
      const credentialFingerprints = new Set(
        credentials.map(({ auth: rowAuth }) => fingerprintCredential(rowAuth.apiKey)),
      );
      retainCurrentCredentialFingerprints(credentialFingerprints);
      const results = await Promise.all(
        credentials.map(async ({ row, displayName, auth: rowAuth }) => {
          const fingerprint = fingerprintCredential(rowAuth.apiKey);
          if (notSubscribedCredentialFingerprints.has(fingerprint)) {
            return { row, group: displayName, result: null };
          }
          const result = await queryOpenCodeGoQuota(rowAuth.apiKey, {
            requestTimeoutMs: ctx.config.requestTimeoutMs,
          });
          if (!result.success && result.notSubscribed === true) {
            notSubscribedCredentialFingerprints.add(fingerprint);
            return { row, group: displayName, result: null };
          }
          return { row, group: displayName, result };
        }),
      );
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [...invalidErrors];
      for (const { row, group, result } of results) {
        if (!result) continue;
        if (result.success) entries.push(...buildOpenCodeGoEntries(result, windows, group, row.id));
        else errors.push({ label: group, message: result.error, retryable: result.retryable });
      }
      return withStatusDetails(attemptedResult(entries, errors), [
        ...baseStatusDetails,
        ...(entries.length === 0 && errors.length === 0 && credentials.length > 0
          ? [{ key: "opencode_go_state", value: "not_subscribed" }]
          : []),
      ]);
    }
  }

  if (auth.state === "invalid") {
    notSubscribedCredentialFingerprints.clear();
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, auth.error),
      baseStatusDetails,
    );
  }

  const credentialFingerprint = fingerprintCredential(auth.apiKey);
  retainCurrentCredentialFingerprints(new Set([credentialFingerprint]));

  if (notSubscribedCredentialFingerprints.has(credentialFingerprint)) {
    return withStatusDetails(attemptedResult([]), [
      ...baseStatusDetails,
      { key: "opencode_go_state", value: "not_subscribed" },
    ]);
  }

  const result = await queryOpenCodeGoQuota(auth.apiKey, {
    requestTimeoutMs: ctx.config.requestTimeoutMs,
  });

  if (!result.success) {
    if (result.notSubscribed === true) {
      notSubscribedCredentialFingerprints.add(credentialFingerprint);
      return withStatusDetails(attemptedResult([]), [
        ...baseStatusDetails,
        { key: "opencode_go_state", value: "not_subscribed" },
      ]);
    }
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, result.error, {
        retryable: result.retryable,
      }),
      [...baseStatusDetails, { key: "live_fetch_error", value: result.error }],
    );
  }

  const liveDetails = OPENCODE_GO_WINDOW_ORDER.map((window) => {
    const usage = result[window];
    return {
      key: `${window}_usage`,
      value: `status=${usage.status} percent_used=${usage.usagePercent} percent_remaining=${usage.percentRemaining} reset_at=${usage.resetTimeIso}`,
    };
  });

  return withStatusDetails(attemptedResult(buildOpenCodeGoEntries(result, windows)), [
    ...baseStatusDetails,
    ...liveDetails,
  ]);
}
