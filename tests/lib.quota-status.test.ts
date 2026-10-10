import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot, QuotaRow } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";
import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { buildStatusReportData } from "../src/lib/quota-dialog-commands.js";
import {
  buildQuotaStatusReport,
  buildQuotaStatusReportDocument,
  type QuotaStatusReportParams,
} from "../src/lib/quota-status.js";
import { getPackageVersion } from "../src/lib/version.js";
import { defaultSettings, loadSettings, type V5Conversion } from "../src/settings/index.js";

const registry = vi.hoisted(() => ({ providers: [] as unknown[] }));

// The providers are the edge here: fakes that answer like the real adapters.
vi.mock("../src/providers/registry.js", () => ({ getProviders: () => registry.providers }));

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const RESET = "2026-10-11T00:00:00.000Z";
const SECRET = "status-secret-canary-0123456789";

let root: string;

/** One temp folder is the home dir and holds every OpenCode folder. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-quota-status-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", "");
  vi.stubEnv("OPENCODE_DB", "");
  // No price download leaves the machine.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(new Error("offline"))),
  );
  registry.providers = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function params(overrides: Partial<QuotaStatusReportParams> = {}): QuotaStatusReportParams {
  return {
    settings: { path: "/cfg/opencode-quota/settings.jsonc", exists: true, issues: [], notRead: [] },
    workspaceRoot: "/ws",
    enabledProviders: "auto",
    onlyCurrentModel: false,
    pricingSnapshotSource: "auto",
    providerAvailability: [],
    providers: [],
    credentialSource: { state: "unbound", failures: [] },
    generatedAtMs: NOW,
    homeDir: root,
    ...overrides,
  };
}

/** A v5 conversion from two files with nothing in it; `extra` fills in what it found. */
function conversion(extra: Partial<V5Conversion>): V5Conversion {
  return {
    sources: ["/cfg/opencode.json", "/cfg/opencode-quota/quota-toast.json"],
    malformed: false,
    written: false,
    values: {},
    settings: defaultSettings(),
    fromFile: [],
    displayImport: {},
    converted: [],
    dropped: [],
    invalid: [],
    notes: [],
    ...extra,
  };
}

function report(overrides: Partial<QuotaStatusReportParams> = {}): Promise<string> {
  return buildQuotaStatusReport(params(overrides));
}

/** A section's text: its title line to the blank line after it. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n${title}:\n`);
  expect(start, `no "${title}:" section in:\n${text}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start + 1);
  return text.slice(start + 1, end === -1 ? undefined : end);
}

function titles(text: string): string[] {
  return text.split("\n\n").map((block) => block.split("\n")[0] ?? "");
}

function snapshot(providerId: string, extra: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return { providerId, label: providerId, rows: [], refreshing: false, debug: [], ...extra };
}

function row(id: string, extra: Partial<QuotaRow> = {}): QuotaRow {
  return {
    id,
    providerId: id.split(".")[0] ?? id,
    label: "5h",
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...extra,
  };
}

describe("buildQuotaStatusReport", () => {
  it("starts with the command, version and time; the dialog gets them as its subtitle", async () => {
    const version = await getPackageVersion();
    const time = formatLocalCallTimestamp(NOW);

    const document = await buildQuotaStatusReportDocument(params());

    expect(document.heading).toEqual({
      line: `# Quota Status (opencode-quota v${version}) (/quota_status) ${time}`,
      subtitle: `opencode-quota v${version} · ${time}`,
    });
    expect((await report()).split("\n")[0]).toBe(document.heading?.line);
  });

  it("has settings, every provider, files and logins, one section per checked provider, then prices", async () => {
    const text = await report({
      providerAvailability: [
        { id: "anthropic", enabled: true, available: true, matchesCurrentModel: true },
        { id: "copilot", enabled: true, available: true, matchesCurrentModel: false },
        { id: "openai", enabled: false, available: false },
      ],
      providers: [snapshot("anthropic", { checkedAtMs: NOW }), snapshot("copilot")],
      maintainerAnnouncements: {
        config: { enabled: true, home: true, homeFrequency: "daily" },
        summary: {
          source: "bundled_only",
          network: false,
          bundledCount: 4,
          activeCount: 2,
          futureCount: 1,
          expiredCount: 1,
          activeAnnouncements: [],
          evaluations: [],
        },
      },
    });

    expect(titles(text).slice(1)).toEqual([
      "settings:",
      "providers:",
      "maintainer_announcements:",
      "paths:",
      "credential_source:",
      "anthropic:",
      "copilot:",
      "pricing_snapshot:",
    ]);
    expect(section(text, "providers")).toBe(
      [
        "providers:",
        "- anthropic: enabled available matchesCurrentModel=yes",
        "- copilot: enabled available matchesCurrentModel=no",
        "- openai: disabled unavailable",
      ].join("\n"),
    );
    expect(section(text, "maintainer_announcements")).toBe(
      [
        "maintainer_announcements:",
        "- enabled: true",
        "- home: true",
        "- home_frequency: daily",
        "- source: bundled_only",
        "- network: false",
        "- active: 2",
        "- future: 1",
        "- expired: 1",
      ].join("\n"),
    );
  });

  it("shows the home dir as ~ in every path, but not in lookalike or outside paths", async () => {
    const params_ = params({
      settings: {
        path: join(root, "config", "opencode", "opencode-quota", "settings.jsonc"),
        exists: true,
        issues: [],
        notRead: [`${root}foo/quota-toast.json`, "/opt/x"],
      },
      workspaceRoot: join(root, "project"),
      providers: [
        snapshot("anthropic", { debug: [{ key: "binary_path", value: join(root, "bin") }] }),
      ],
    });

    const text = await buildQuotaStatusReport(params_);
    const document = await buildQuotaStatusReportDocument(params_);

    expect(text).toContain(
      "- settings_file: ~/config/opencode/opencode-quota/settings.jsonc (exists)",
    );
    expect(text).toContain(`- not_read: ${root}foo/quota-toast.json | /opt/x`);
    expect(text).toContain("- workspace_root: ~/project\n");
    expect(text).toContain(
      "- opencode_dirs: data=~/data/opencode config=~/config/opencode cache=~/cache/opencode state=~/state/opencode",
    );
    expect(text).toContain("- opencode.db: path=~/data/opencode/opencode.db present=false");
    expect(text).toContain("snapshot=~/cache/opencode/opencode-quota/");
    expect(text).toContain("- binary_path: ~/bin");
    expect(text.replaceAll(`${root}foo`, "")).not.toContain(root);
    expect(JSON.stringify(document).replaceAll(`${root}foo`, "")).not.toContain(root);
  });

  it.each([
    {
      name: "a JSON-quoted Windows command under a home with a space",
      homeDir: "C:\\Users\\Alice Smith",
      value: `claude --version | ${JSON.stringify("C:\\Users\\Alice Smith\\.local\\bin\\claude")}`,
      shown: '- checked_commands: claude --version | "~\\\\.local\\\\bin\\\\claude"',
      hidden: "Alice",
    },
    {
      name: "a detail the store cut inside the home dir",
      homeDir: "/Users/alice",
      value: "/etc/claude | /Users/ali",
      shown: "- checked_commands: /etc/claude | ~",
      hidden: "/Users/ali",
    },
    {
      name: "a detail cut before the user name",
      homeDir: "/Users/alice",
      value: "/etc/claude | /Users/",
      shown: "- checked_commands: /etc/claude | /Users/",
      hidden: "~",
    },
  ])("shows $name as ~", async ({ homeDir, value, shown, hidden }) => {
    const text = await report({
      homeDir,
      providers: [snapshot("anthropic", { debug: [{ key: "checked_commands", value }] })],
    });

    const anthropic = section(text, "anthropic");
    expect(anthropic).toContain(shown);
    expect(anthropic).not.toContain(hidden);
  });

  it.each([
    {
      name: "rows with their numbers",
      provider: snapshot("anthropic", {
        checkedAtMs: NOW,
        okAtMs: NOW,
        rows: [
          row("anthropic.five_hour", { percentRemaining: 43.4, resetsAt: RESET }),
          row("anthropic.weekly", { label: "Weekly", account: "work", percentRemaining: 88 }),
          row("anthropic.extra", {
            label: "Extra",
            type: "budget",
            used: { decimal: "4.5", unit: { kind: "currency", code: "USD" } },
            limit: { decimal: "20", unit: { kind: "currency", code: "USD" } },
          }),
          row("anthropic.flag", { label: "Overage", type: "status", flag: false, text: "Off" }),
        ],
      }),
      lines: [
        "- state: ok",
        `- checked_at: ${NOW_ISO}`,
        "- rows: 4",
        `  - anthropic.five_hour: 5h, 43% left, resets ${RESET}`,
        "  - anthropic.weekly (work): Weekly, 88% left",
        "  - anthropic.extra: Extra, 4.5/20 USD",
        "  - anthropic.flag: Overage, Off, no",
      ],
      absent: ["rows from", "error"],
    },
    {
      name: "an error in the shared words, with its detail",
      provider: snapshot("openai", {
        checkedAtMs: NOW,
        error: { code: "login_expired", detail: "HTTP 401 Unauthorized" },
      }),
      lines: [
        "- state: error: Sign in again (login_expired)",
        "- error_detail: HTTP 401 Unauthorized",
        "- rows: 0",
      ],
      absent: [],
    },
    {
      name: "older rows kept after an error, and the provider's own messages",
      provider: snapshot("copilot", {
        checkedAtMs: NOW,
        okAtMs: NOW - 60_000,
        rows: [row("copilot.monthly", { label: "Monthly", percentRemaining: 50 })],
        error: { code: "provider_error", status: 503, detail: "Billing endpoint HTTP 503" },
        debug: [
          { key: "deployment", value: "github.com" },
          { key: "error", value: "Copilot: Billing endpoint HTTP 503" },
        ],
      }),
      lines: [
        "- state: partial: Provider error 503 (provider_error)",
        `- checked_at: ${NOW_ISO} (rows from ${new Date(NOW - 60_000).toISOString()})`,
        "- rows: 1\n  - copilot.monthly: Monthly, 50% left\n- deployment: github.com",
        "- error: Copilot: Billing endpoint HTTP 503",
      ],
      absent: ["error_detail"],
    },
    {
      name: "a provider not checked yet",
      provider: snapshot("xai"),
      lines: ["- state: not checked", "- rows: 0"],
      absent: ["checked_at"],
    },
    {
      name: "a long row list, cut",
      provider: snapshot("google-agy", {
        checkedAtMs: NOW,
        rows: Array.from({ length: 10 }, (_, index) => row(`google-agy.r${index}`)),
      }),
      lines: ["- rows: 10", "  - google-agy.r7: 5h\n  - … (2 more)"],
      absent: ["google-agy.r8"],
    },
  ])("builds a provider section from its snapshot: $name", async ({ provider, lines, absent }) => {
    const text = section(await report({ providers: [provider] }), provider.providerId);

    for (const line of lines) expect(text).toContain(line);
    for (const line of absent) expect(text).not.toContain(line);
  });

  it.each([
    { key: "access_token", value: SECRET, shown: "- access_token: [redacted]" },
    {
      key: "request",
      value: `Authorization: Bearer ${SECRET}`,
      shown: "- request: Authorization: [redacted]",
    },
    { key: "url", value: `https://x.example/?key=${SECRET}`, shown: "?key=[redacted]" },
    {
      key: "probe",
      value: "probe \u001b[31mfailed\u0007\n\twith noise",
      shown: "- probe: probe failed with noise",
    },
  ])("keeps secrets and control characters out of debug detail $key", async ({
    key,
    value,
    shown,
  }) => {
    const text = await report({
      providers: [
        snapshot("chutes", {
          checkedAtMs: NOW,
          debug: [{ key, value }],
          error: { code: "internal", detail: `failed with api_key=${SECRET}` },
        }),
      ],
    });

    expect(text).toContain(shown);
    expect(text).toContain("- error_detail: failed with api_key=[redacted]");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("\u001b");
  });

  it.each([
    {
      name: "the settings file, the providers and the session model",
      overrides: {
        enabledProviders: ["copilot", "openai"],
        onlyCurrentModel: true,
        currentModel: "gpt-5",
      },
      lines: [
        "- settings_file: /cfg/opencode-quota/settings.jsonc (exists)",
        "- project_settings: none: the settings are global; v5 project-scope files are not read",
        "- enabledProviders: copilot | openai",
        "- onlyCurrentModel: true",
        "- currentModel: gpt-5",
        "- workspace_root: /ws",
      ],
      absent: ["settings_issue", "conversion", "not_read"],
    },
    {
      name: "defaults and no session",
      overrides: {
        settings: {
          path: "/cfg/opencode-quota/settings.jsonc",
          exists: false,
          issues: [],
          notRead: [],
        },
        enabledProviders: [],
        sessionModelLookup: "no_session",
      },
      lines: [
        "- settings_file: /cfg/opencode-quota/settings.jsonc (missing; using the defaults)",
        "- enabledProviders: (none)",
        "- currentModel: (no session available)",
      ],
    },
    {
      name: "auto providers, a session without a model, and settings issues",
      overrides: {
        sessionModelLookup: "not_found",
        settings: {
          path: "/cfg/opencode-quota/settings.jsonc",
          exists: true,
          issues: [
            { key: "$file", message: "syntax error on line 2: ValueExpected" },
            { key: "checking.minIntervalMs", message: "expected a number" },
          ],
          notRead: ["/ws/opencode-quota/quota-toast.json"],
        },
      },
      lines: [
        "- enabledProviders: (auto)",
        "- currentModel: (error: session.get returned no modelID)",
        "- settings_issue: $file: syntax error on line 2: ValueExpected\n- settings_issue: checking.minIntervalMs: expected a number",
        "- not_read: /ws/opencode-quota/quota-toast.json",
      ],
    },
    {
      name: "custom provider definitions without their URL, adapter or key",
      overrides: {
        quotaProviders: [
          {
            id: "team",
            providerId: "gateway",
            label: "Team",
            mode: "remote-api",
            url: "https://private.example/secret-path",
            format: "json-v1",
            adapter: {
              mappings: [
                {
                  resultType: "status",
                  name: "Status",
                  metric: { type: "status", value: { literal: "private-adapter-literal" } },
                },
              ],
            },
            apiKeyEnv: "TEAM_KEY",
            modelIds: ["model-a"],
          },
          {
            id: "seats",
            providerId: "gateway",
            mode: "local-estimate",
            windows: [{ id: "day", type: "utc-day", requestLimit: 50 }],
          },
          {
            id: "alibaba-coding-plan",
            providerId: "alibaba-coding-plan",
            mode: "local-estimate",
            windows: [
              { id: "five-hour", type: "rolling", durationMinutes: 300, requestLimit: 1000 },
            ],
          },
        ],
      },
      lines: [
        "- provider_team: provider_id=gateway mode=remote-api format=json-v1 env_name=TEAM_KEY coverage=model-a",
        "- provider_seats: provider_id=gateway mode=local-estimate limits=day:50 coverage=all_models state_path=~/state/opencode/opencode-quota/quota-providers/seats.json",
        "- provider_alibaba-coding-plan: provider_id=alibaba-coding-plan mode=local-estimate limits=five-hour:1000 coverage=all_models tunes=alibaba-coding-plan",
      ],
      absent: ["private.example", "private-adapter-literal"],
    },
    {
      name: "the v5 settings this server converted and wrote",
      overrides: {
        conversion: conversion({
          written: true,
          converted: [
            { key: "enabledProviders", to: "providers.enabled", where: "server" },
            {
              key: "percentDisplayMode",
              to: "words.percent",
              where: "server",
              note: "the TUI shows it",
            },
          ],
          dropped: [{ key: "showOnIdle", reason: "removed in v6" }],
          invalid: [{ key: "minIntervalMs", reason: "expected a number" }],
          notes: ["the project files are not read"],
        }),
      },
      lines: [
        "- conversion: from /cfg/opencode.json | /cfg/opencode-quota/quota-toast.json (2 converted, 1 dropped, 1 invalid); written to settings.jsonc",
        "- conversion_note: percentDisplayMode: the TUI shows it",
        "- conversion_note: showOnIdle dropped: removed in v6",
        "- conversion_note: minIntervalMs invalid: expected a number",
        "- conversion_note: the project files are not read",
      ],
    },
    {
      name: "the v5 settings converted in memory while settings.jsonc is missing",
      overrides: {
        settings: {
          path: "/cfg/opencode-quota/settings.jsonc",
          exists: false,
          issues: [],
          notRead: [],
        },
        conversion: conversion({}),
      },
      lines: [
        "- settings_file: /cfg/opencode-quota/settings.jsonc (missing; the v5 settings are converted in memory)",
        "(0 converted, 0 dropped, 0 invalid); converted in memory",
      ],
      absent: ["conversion_note"],
    },
    {
      name: "the v5 settings that could not be written",
      overrides: {
        conversion: conversion({ notWrittenReason: "settings.jsonc is not writable" }),
      },
      lines: ["(0 converted, 0 dropped, 0 invalid); settings.jsonc is not writable"],
    },
  ] as Array<{
    name: string;
    overrides: Partial<QuotaStatusReportParams>;
    lines: string[];
    absent?: string[];
  }>)("shows where settings come from: $name", async ({ overrides, lines, absent = [] }) => {
    const text = section(await report(overrides), "settings");

    for (const line of lines) expect(text).toContain(line);
    for (const line of absent) expect(text).not.toContain(line);
  });

  it.each([
    {
      name: "the login source, its last list error, and each failed login",
      credentialSource: {
        state: "bound",
        kind: "opencode-integration-api",
        lastListError: { at: 1, detail: "Invalid credential value" },
        failures: [
          {
            integrationId: "openai",
            connectionId: "cred_1",
            label: "Work",
            category: "refresh_failed",
            detail: "HTTP 401 [redacted]",
            at: 2,
          },
          {
            integrationId: "xai",
            connectionId: "xai",
            label: "",
            category: "active_failed",
            detail: "database is locked",
            at: 3,
          },
        ],
      },
      lines: [
        "- source: opencode-integration-api",
        "- list_error: Invalid credential value",
        "- failures: openai:Work:refresh_failed:HTTP 401 [redacted] | xai::active_failed:database is locked",
      ],
    },
    {
      name: "the terminal command's database",
      credentialSource: { state: "bound", kind: "sqlite", failures: [] },
      lines: ["- source: sqlite", "- list_error: (none)", "- failures: (none)"],
    },
    {
      name: "no login source",
      credentialSource: { state: "unbound", failures: [] },
      lines: ["- source: unbound"],
    },
  ] as Array<{
    name: string;
    credentialSource: QuotaStatusReportParams["credentialSource"];
    lines: string[];
  }>)("reports $name", async ({ credentialSource, lines }) => {
    const text = section(await report({ credentialSource }), "credential_source");

    for (const line of lines) expect(text).toContain(line);
  });

  it.each([
    { configured: "auto", note: undefined },
    { configured: "bundled", note: "bundled config pins the packaged snapshot" },
    { configured: "runtime", note: "runtime config requested the local runtime snapshot" },
  ] as const)("explains the $configured price list choice", async ({ configured, note }) => {
    const text = section(await report({ pricingSnapshotSource: configured }), "pricing_snapshot");

    expect(text).toContain(`- selection: configured=${configured} active=bundled`);
    expect(text).toContain("- refresh: (no runtime refresh state yet)");
    if (note) expect(text).toContain(`- selection_note: ${note}`);
    else expect(text).not.toContain("selection_note");
  });

  it.each([
    {
      name: "unreadable history",
      usage: null,
      lines: ["- unpriced_30d: (the usage history could not be read)"],
    },
    {
      name: "no usage",
      usage: { totals: { tokens: { processed: 0 }, unpricedShare: 0 }, models: [] },
      lines: ["- unpriced_30d: (no usage)"],
    },
    {
      name: "models without a price, the first five listed",
      usage: {
        totals: { tokens: { processed: 80_000 }, unpricedShare: 0.125 },
        models: [
          { providerID: "anthropic", modelID: "claude", priced: true, unpricedTokens: 0 },
          ...Array.from({ length: 7 }, (_, index) => ({
            providerID: "deepseek",
            modelID: `model-${index}`,
            priced: false,
            unpricedTokens: 1_500,
          })),
        ],
      },
      lines: [
        "- unpriced_30d: 12.5% of 80.0K tokens",
        "  - deepseek/model-4: 1.50K tokens\n  - … (2 more)",
      ],
      absent: ["anthropic/claude", "model-5"],
    },
  ])("lists the last 30 days' models without a price: $name", async ({
    usage,
    lines,
    absent = [],
  }) => {
    const text = section(await report({ usage: usage as UsageReport | null }), "pricing_snapshot");

    for (const line of lines) expect(text).toContain(line);
    for (const line of absent) expect(text).not.toContain(line);
  });
});

describe("buildStatusReportData", () => {
  const client = { config: { providers: async () => ({ data: { providers: [] } }) } };

  function fakeProvider(id: string, available: boolean, result?: QuotaProviderResult) {
    return {
      id,
      isAvailable: vi.fn(async () => available),
      fetch: vi.fn(async () => result ?? { attempted: true, entries: [], errors: [] }),
    };
  }

  const synthetic = () =>
    fakeProvider("synthetic", true, {
      attempted: true,
      entries: [
        {
          accounting: {
            resultType: "quota",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          name: "Synthetic 5h",
          group: "Synthetic",
          label: "5h:",
          percentRemaining: 84,
          resetTimeIso: RESET,
        },
      ],
      errors: [{ label: "Synthetic", message: `Weekly HTTP 503 Bearer ${SECRET}` }],
      statusDetails: [
        { key: "api_key_source", value: "env:SYNTHETIC_API_KEY" },
        { key: "access_token", value: SECRET },
      ],
    });

  function writeV5Settings(settings: Record<string, unknown>): void {
    const dir = join(root, "config", "opencode", "opencode-quota");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "quota-toast.json"), JSON.stringify(settings));
  }

  async function statusData(options: { providerFilterId?: string } = {}) {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const loaded = await loadSettings();
    const onDetectedProviderIds = vi.fn(async () => {});
    const data = await buildStatusReportData({
      host: { client, workspaceRoot: workspace, settings: () => loaded },
      generatedAtMs: NOW,
      onDetectedProviderIds,
      ...options,
    });
    return { data, text: data.output, onDetectedProviderIds };
  }

  it("checks every enabled provider through a store and shows what it returned, secrets redacted", async () => {
    const syntheticProvider = synthetic();
    const openai = fakeProvider("openai", false);
    registry.providers = [syntheticProvider, openai];

    const { data, text, onDetectedProviderIds } = await statusData();

    const syntheticSection = section(text, "synthetic");
    expect(syntheticSection).toContain("- state: partial: Provider error 503 (provider_error)");
    expect(syntheticSection).toContain(
      `- rows: 1\n  - synthetic.five_hour: 5h, 84% left, resets ${RESET}`,
    );
    expect(syntheticSection).toContain("- api_key_source: env:SYNTHETIC_API_KEY");
    expect(syntheticSection).toContain("- access_token: [redacted]");
    expect(syntheticSection).toContain("- error: Synthetic: Weekly HTTP 503 Bearer [redacted]");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("\nopenai:\n");
    expect(section(text, "providers")).toContain("- openai: disabled unavailable");
    expect(section(text, "pricing_snapshot")).toContain("- unpriced_30d: (no usage)");
    expect(syntheticProvider.fetch).toHaveBeenCalledOnce();
    expect(openai.fetch).not.toHaveBeenCalled();
    expect(onDetectedProviderIds).toHaveBeenCalledWith(["synthetic"]);
    expect(data.payload?.liveProbes).toEqual([{ id: "synthetic", ok: false }]);
    expect(data.payload?.providers.map((provider) => provider.id)).toEqual(["synthetic", "openai"]);
    expect(data.hasComparableProviderData).toBe(true);
    expect(JSON.stringify(data.payload)).not.toContain(SECRET);
  });

  it("checks and shows only the provider asked for", async () => {
    const syntheticProvider = synthetic();
    const chutes = fakeProvider("chutes", true);
    registry.providers = [syntheticProvider, chutes];

    const { data, text } = await statusData({ providerFilterId: "chutes" });

    expect(text).toContain("\nchutes:\n- state: error: Nothing reported (no_data)");
    expect(text).not.toContain("\nsynthetic:\n");
    expect(syntheticProvider.fetch).not.toHaveBeenCalled();
    expect(data.payload?.providers.map((provider) => provider.id)).toEqual(["chutes"]);
    expect(data.payload?.liveProbes).toEqual([{ id: "chutes", ok: false }]);
    expect(data.hasComparableProviderData).toBe(false);
  });

  it("converts the v5 settings in memory until settings.jsonc exists", async () => {
    registry.providers = [synthetic()];
    writeV5Settings({ enabledProviders: ["synthetic"] });

    const before = section((await statusData()).text, "settings");

    expect(before).toContain(
      "- settings_file: ~/config/opencode/opencode-quota/settings.jsonc (missing; the v5 settings are converted in memory)",
    );
    expect(before).toContain("- enabledProviders: synthetic");
    expect(before).toMatch(
      /- conversion: from ~\/config\/opencode\/opencode-quota\/quota-toast\.json \(\d+ converted, \d+ dropped, \d+ invalid\); converted in memory/u,
    );

    writeFileSync(join(root, "config", "opencode", "opencode-quota", "settings.jsonc"), "{ ");
    const after = section((await statusData()).text, "settings");

    expect(after).toContain("settings.jsonc (exists)");
    expect(after).toMatch(/- settings_issue: \$file: syntax error/u);
    expect(after).not.toContain("- conversion:");
  });
});
