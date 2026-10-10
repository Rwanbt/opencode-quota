import { describe, expect, it, vi } from "vitest";
import {
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuota,
  queryAnthropicQuotaWithOAuth,
} from "../src/lib/anthropic.js";
import type { QuotaProviderContext } from "../src/lib/entries.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuota: vi.fn(),
  queryAnthropicQuotaWithOAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

const diagnosticsMock = vi.mocked(getAnthropicDiagnostics);
const quotaMock = vi.mocked(queryAnthropicQuota);
const oauthQuotaMock = vi.mocked(queryAnthropicQuotaWithOAuth);
const credentialsConfiguredMock = vi.mocked(hasAnthropicCredentialsConfigured);
const NO_CONFIG_CTX = {} as QuotaProviderContext;

function mockDiagnostics(diagnostics: Record<string, unknown>): void {
  diagnosticsMock.mockResolvedValueOnce({
    installed: true,
    version: "1.2.3",
    authStatus: "authenticated",
    checkedCommands: ["claude --version"],
    ...diagnostics,
  } as never);
}

describe("anthropic provider", () => {
  it("fans out to a valid inactive database credential when the active credential is expired", async () => {
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "expired-active",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth", access: "expired", expires: 0 },
      },
      {
        id: "valid-inactive",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "valid" },
      },
    ] as never);
    mockDiagnostics({
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      checkedCommands: [],
      quota: {
        success: true,
        five_hour: { percentRemaining: 1 },
        seven_day: { percentRemaining: 1 },
      },
    });
    oauthQuotaMock.mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
      seven_day: { percentRemaining: 70 },
      extra_usage: { percentRemaining: 60 },
      fable_weekly: { percentRemaining: 50 },
    });

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);

    expect(oauthQuotaMock).toHaveBeenCalledWith("valid", undefined);
    expect(quotaMock).not.toHaveBeenCalled();
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work] Usage Credits", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
    ]);
  });

  it("shows a login OpenCode could not read as its own error row", async () => {
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "failed-active",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 500",
      },
      {
        id: "valid-inactive",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "valid" },
      },
    ] as never);
    mockDiagnostics({
      installed: false,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: [],
    });
    oauthQuotaMock.mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
      seven_day: { percentRemaining: 70 },
    });

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);

    expect(oauthQuotaMock).toHaveBeenCalledOnce();
    expect(quotaMock).not.toHaveBeenCalled();
    expect(out.errors).toEqual([
      {
        label: "[Claude] (active)",
        message:
          "Anthropic sign-in could not be read: refresh_failed: HTTP 500. Run `opencode auth login anthropic`.",
      },
    ]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[Claude Work]", "valid-inactive"],
      ["[Claude Work]", "valid-inactive"],
    ]);
  });

  it.each([
    [
      "the credential store that answered the usage probe",
      {
        oauthCredentialSource: "opencode-auth",
        binaryPath: "/opt/homebrew/bin/claude",
        quotaSupported: true,
        quotaSource: "opencode-auth-oauth-api",
      },
      [
        { key: "oauth_credential_source", value: "opencode-auth" },
        { key: "binary_path", value: "/opt/homebrew/bin/claude" },
        { key: "quota_source", value: "opencode-auth-oauth-api" },
      ],
    ],
    [
      "no credential store when the OAuth probe was never reached",
      { binaryPath: null, quotaSupported: false, quotaSource: "none" },
      [
        { key: "oauth_credential_source", value: "(none)" },
        { key: "binary_path", value: "(none)" },
      ],
    ],
  ])("reports %s", async (_label, diagnostics, expectedDetails) => {
    mockDiagnostics(diagnostics);
    quotaMock.mockResolvedValueOnce(null);

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);

    for (const detail of expectedDetails) expect(out.statusDetails).toContainEqual(detail);
  });

  it("adds the Fable weekly row and diagnostic when the OAuth response reports it", async () => {
    const quota = {
      success: true as const,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      fable_weekly: { percentRemaining: 98, resetTimeIso: "2026-07-27T07:00:00.268Z" },
    };
    mockDiagnostics({
      version: "2.1.258",
      quotaSupported: true,
      quotaSource: "opencode-auth-oauth-api",
      oauthCredentialSource: "opencode-auth",
      quota,
    });
    quotaMock.mockResolvedValueOnce(quota);

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);

    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails).toContainEqual({
      key: "fable_weekly_remaining",
      value: "98% reset_at=2026-07-27T07:00:00.268Z",
    });
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: 58,
        resetTimeIso: "2026-07-21T14:10:00.268Z",
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: 72,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
      {
        name: "Claude Fable Weekly",
        group: "Claude",
        label: "Fable:",
        semantic: { metric: { kind: "named", name: "Fable weekly" }, prominence: "primary" },
        percentRemaining: 98,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting)).toEqual(
      Array.from({ length: 3 }, () => ({
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      })),
    );
  });

  it("returns attempted:false and a sanitized probe failure when quota is unavailable", async () => {
    diagnosticsMock.mockRejectedValueOnce(new Error("probe \u001b[31mboom"));
    quotaMock.mockResolvedValueOnce(null);

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);

    expectNotAttempted(out);
    expect(out.statusDetails).toEqual([
      { key: "cli_installed", value: "false" },
      { key: "message", value: "failed to probe Claude CLI: probe boom" },
    ]);
  });

  it.each([
    [
      "local CLI quota windows as local CLI rows",
      "claude-auth-status-json",
      undefined,
      "local_cli",
      [],
    ],
    [
      "enabled Usage Credits as a third remote API row",
      "opencode-auth-oauth-api",
      { percentRemaining: 62 },
      "remote_api",
      [
        {
          name: "Claude Usage Credits",
          group: "Claude Usage Credits",
          label: "Monthly:",
          percentRemaining: 62,
        },
      ],
    ],
  ])("maps %s", async (_label, quotaSource, extraUsage, acquisitionMethod, extraEntries) => {
    mockDiagnostics({ quotaSupported: true, quotaSource });
    quotaMock.mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 43, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: 88, resetTimeIso: "2026-04-01T00:00:00.000Z" },
      ...(extraUsage ? { extra_usage: extraUsage } : {}),
    });

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "anthropic")).toEqual([
      {
        name: "Claude 5h",
        group: "Claude",
        label: "5h:",
        percentRemaining: 43,
        resetTimeIso: "2026-03-25T18:00:00.000Z",
      },
      {
        name: "Claude Weekly",
        group: "Claude",
        label: "Weekly:",
        percentRemaining: 88,
        resetTimeIso: "2026-04-01T00:00:00.000Z",
      },
      ...extraEntries,
    ]);
    expect(
      out.entries.every((entry) => entry.accounting.acquisitionMethod === acquisitionMethod),
    ).toBe(true);
    expect(out.presentation).toBeUndefined();
  });

  it("maps errors into toast errors", async () => {
    quotaMock.mockResolvedValueOnce({
      success: false,
      error:
        "Invalid or expired Anthropic token; re-authenticate Claude Code or update CLAUDE_CODE_OAUTH_TOKEN",
    });

    const out = await anthropicProvider.fetch(NO_CONFIG_CTX);
    expectAttemptedWithErrorLabel(out, "Claude");
  });

  it.each([
    ["anthropic/claude-sonnet-4-6", true],
    ["anthropic/claude-opus-4-6", true],
    ["ANTHROPIC/claude-haiku-4-5", true],
    ["openai/gpt-5", false],
    ["copilot/claude-sonnet-4-5", false],
  ])("matches model id %s: %s", (model, expected) => {
    expect(anthropicProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    [["anthropic"], true, true],
    [["copilot", "anthropic"], true, true],
    [["claude"], true, false],
    [["openai"], true, false],
    [["anthropic"], false, false],
  ])("with provider ids %j and Claude auth ready=%s is available=%s", async (providerIds, credentialsConfigured, expected) => {
    credentialsConfiguredMock.mockResolvedValue(credentialsConfigured);

    await expect(
      anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds })),
    ).resolves.toBe(expected);
  });

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });

  it("passes the configured Claude binary path through Anthropic probes", async () => {
    credentialsConfiguredMock.mockResolvedValue(true);
    quotaMock.mockResolvedValueOnce(null);
    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic"],
      configOverrides: { anthropicBinaryPath: "/opt/claude/bin/claude" },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(credentialsConfiguredMock).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
    });

    await anthropicProvider.fetch(ctx);
    expect(quotaMock).toHaveBeenCalledWith({ binaryPath: "/opt/claude/bin/claude" });
  });
});
