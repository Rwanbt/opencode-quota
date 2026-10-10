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
const OPENCODE_GO_WINDOW_LABELS: Record<OpenCodeGoWindowKey, string> = {
  rolling: "5h:",
  weekly: "Weekly:",
  monthly: "Monthly:",
};
const NOT_SUBSCRIBED_DETAIL = { key: "opencode_go_state", value: "not_subscribed" };

/** Keys the API answered "not subscribed" for; not asked again until the stored keys change. */
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
  return OPENCODE_GO_WINDOW_ORDER.filter((window) => selectedWindows.includes(window)).map(
    (window) => {
      const label = OPENCODE_GO_WINDOW_LABELS[window];
      return {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
          ...(sourceId ? { sourceId } : {}),
        },
        name: `${group} ${label.slice(0, -1)}`,
        group,
        label,
        percentRemaining: result[window].percentRemaining,
        resetTimeIso: result[window].resetTimeIso,
      };
    },
  );
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    // Any Console sign-in counts, even a failed one, so fetch() can show its error when there
    // is no API key.
    if ((await resolveOpenCodeConsoleAuth()).state !== "none") return true;
    const auth = await resolveApiKeyLogin(OPENCODE_GO_AUTH);
    if (auth.state === "configured") return true;
    notSubscribedCredentialFingerprints.clear();
    return false;
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const windows = OPENCODE_GO_WINDOW_ORDER;
    const selectedWindowsDetail = { key: "selected_windows", value: windows.join(",") };
    const consoleAuth = await resolveOpenCodeConsoleAuth();

    if (consoleAuth.state === "none") {
      const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
      return await fetchOpenCodeGoLegacy(ctx, diagnostics, [
        ...authStatusDetails(diagnostics),
        selectedWindowsDetail,
      ]);
    }

    if (consoleAuth.state === "expired") {
      // OpenCode refreshes the console token when it is read, so this is rare;
      // fall back to the legacy path, which also still accepts workspace API keys.
      return await fetchOpenCodeGoLegacy(ctx, await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH), [
        { key: "console_auth_state", value: "expired" },
        { key: "go_source", value: "legacy_key" },
      ]);
    }

    let consoleError: string;
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
            { key: "console_server", value: consoleBaseUrl(consoleAuth.credential) },
            { key: "go_source", value: "console" },
            selectedWindowsDetail,
          ],
        );
      }
      if (consoleResult.notSubscribed === true) {
        return withStatusDetails(attemptedResult([]), [
          { key: "console_auth_state", value: "configured" },
          NOT_SUBSCRIBED_DETAIL,
          selectedWindowsDetail,
        ]);
      }
      consoleError = consoleResult.error;
    } else {
      consoleError = scrubCredentialErrorText(consoleAuth.error);
    }

    // The Console request or sign-in failed: fall back to the API-key path and surface the
    // console error in diagnostics. Without an API key a failed request stays quiet (the
    // sign-in works, only this request failed); a failed sign-in becomes Go's one error row.
    const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
    return await fetchOpenCodeGoLegacy(
      ctx,
      diagnostics,
      [
        ...authStatusDetails(diagnostics),
        { key: "console_auth_state", value: consoleAuth.state },
        { key: "console_error", value: consoleError },
        { key: "go_source", value: "legacy_key" },
        selectedWindowsDetail,
      ],
      consoleAuth.state === "invalid"
        ? `OpenCode Console sign-in failed: ${consoleError}. ${CONSOLE_LOGIN_HINT}`
        : undefined,
    );
  },
};

/**
 * The API-key path. `consoleSignInFailure` is set when OpenCode could not return
 * the Console sign-in; without an API key it becomes Go's one error row.
 */
async function fetchOpenCodeGoLegacy(
  ctx: QuotaProviderContext,
  diagnostics: ApiKeyLoginDiagnostics,
  statusDetails: QuotaProviderStatusDetail[],
  consoleSignInFailure?: string,
): Promise<QuotaProviderResult> {
  const windows = OPENCODE_GO_WINDOW_ORDER;
  const notSubscribedResult = () =>
    withStatusDetails(attemptedResult([]), [...statusDetails, NOT_SUBSCRIBED_DETAIL]);
  const auth = await resolveApiKeyLogin(OPENCODE_GO_AUTH);

  if (auth.state === "none") {
    notSubscribedCredentialFingerprints.clear();
    return withStatusDetails(
      consoleSignInFailure
        ? attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, consoleSignInFailure)
        : notAttemptedResult(),
      statusDetails,
    );
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
      retainCurrentCredentialFingerprints(
        new Set(credentials.map(({ auth: rowAuth }) => fingerprintCredential(rowAuth.apiKey))),
      );
      // A not-subscribed key gives no row at all.
      const results = await Promise.all(
        credentials.map(async ({ row, displayName, auth: rowAuth }) => {
          const fingerprint = fingerprintCredential(rowAuth.apiKey);
          if (notSubscribedCredentialFingerprints.has(fingerprint)) return null;
          const result = await queryOpenCodeGoQuota(rowAuth.apiKey, {
            requestTimeoutMs: ctx.config.requestTimeoutMs,
          });
          if (!result.success && result.notSubscribed === true) {
            notSubscribedCredentialFingerprints.add(fingerprint);
            return null;
          }
          return { row, group: displayName, result };
        }),
      );
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [...invalidErrors];
      for (const item of results) {
        if (!item) continue;
        const { row, group, result } = item;
        if (result.success) entries.push(...buildOpenCodeGoEntries(result, windows, group, row.id));
        else errors.push({ label: group, message: result.error, retryable: result.retryable });
      }
      return withStatusDetails(attemptedResult(entries, errors), [
        ...statusDetails,
        ...(entries.length === 0 && errors.length === 0 && credentials.length > 0
          ? [NOT_SUBSCRIBED_DETAIL]
          : []),
      ]);
    }
  }

  if (auth.state === "invalid") {
    notSubscribedCredentialFingerprints.clear();
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, auth.error),
      statusDetails,
    );
  }

  const fingerprint = fingerprintCredential(auth.apiKey);
  retainCurrentCredentialFingerprints(new Set([fingerprint]));
  if (notSubscribedCredentialFingerprints.has(fingerprint)) return notSubscribedResult();

  const result = await queryOpenCodeGoQuota(auth.apiKey, {
    requestTimeoutMs: ctx.config.requestTimeoutMs,
  });
  if (!result.success && result.notSubscribed === true) {
    notSubscribedCredentialFingerprints.add(fingerprint);
    return notSubscribedResult();
  }
  if (!result.success) {
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, result.error, {
        retryable: result.retryable,
      }),
      [...statusDetails, { key: "live_fetch_error", value: result.error }],
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
    ...statusDetails,
    ...liveDetails,
  ]);
}
