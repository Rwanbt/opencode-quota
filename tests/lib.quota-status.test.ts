import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot, QuotaRow } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import { API_KEY_LOGIN_VENDORS, API_KEY_VENDORS } from "../src/lib/api-key-resolver.js";
import type { QuotaProviderContext, QuotaProviderResult } from "../src/lib/entries.js";
import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { buildStatusReportData } from "../src/lib/quota-dialog-commands.js";
import {
  buildQuotaStatusReport,
  buildQuotaStatusReportDocument,
  type QuotaStatusReportParams,
} from "../src/lib/quota-status.js";
import { getPackageVersion } from "../src/lib/version.js";
import { chutesProvider } from "../src/providers/chutes.js";
import { syntheticProvider } from "../src/providers/synthetic.js";
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

/** Each snapshot given is an enabled and available provider, unless the test lists them. */
function params(overrides: Partial<QuotaStatusReportParams> = {}): QuotaStatusReportParams {
  const providers = overrides.providers ?? [];
  return {
    settings: { path: "/cfg/opencode-quota/settings.jsonc", exists: true, issues: [], notRead: [] },
    workspaceRoot: "/ws",
    enabledProviders: "auto",
    onlyCurrentModel: false,
    pricingSnapshotSource: "auto",
    providerAvailability: providers.map(({ providerId }) => ({
      id: providerId,
      enabled: true,
      available: true,
    })),
    providers,
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

  it("has settings, every provider, files and logins, one section per known provider, then prices", async () => {
    const text = await report({
      enabledProviders: ["anthropic", "copilot", "openai"],
      providerAvailability: [
        { id: "anthropic", enabled: true, available: true, matchesCurrentModel: true },
        { id: "copilot", enabled: true, available: true, matchesCurrentModel: false },
        { id: "openai", enabled: true, available: false },
        { id: "xai", enabled: false, available: true },
      ],
      providers: [
        snapshot("anthropic", { checkedAtMs: NOW }),
        snapshot("copilot"),
        snapshot("openai", {
          debug: [{ key: "opencode_provider", value: "no looked_for=openai" }],
        }),
      ],
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
      "openai:",
      "xai:",
      "pricing_snapshot:",
    ]);
    expect(section(text, "providers")).toBe(
      [
        "providers:",
        "- anthropic: enabled available matchesCurrentModel=yes",
        "- copilot: enabled available matchesCurrentModel=no",
        "- openai: enabled unavailable",
        "- xai: disabled available",
      ].join("\n"),
    );
    expect(section(text, "openai")).toContain("- state: unavailable\n");
    expect(section(text, "openai")).toContain("- opencode_provider: no looked_for=openai");
    expect(section(text, "xai")).toBe("xai:\n- state: disabled");
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

  it("shows a JSON-quoted Windows command under a home with a space as ~", async () => {
    const command = JSON.stringify("C:\\Users\\Alice Smith\\.local\\bin\\claude");
    const text = await report({
      homeDir: "C:\\Users\\Alice Smith",
      providers: [
        snapshot("anthropic", {
          debug: [{ key: "checked_commands", value: `claude --version | ${command}` }],
        }),
      ],
    });

    const anthropic = section(text, "anthropic");
    expect(anthropic).toContain(
      '- checked_commands: claude --version | "~\\\\.local\\\\bin\\\\claude"',
    );
    expect(anthropic).not.toContain("Alice");
  });

  it.each([
    {
      name: "rows with their ids, windows and numbers; accounts as numbers",
      provider: snapshot("anthropic", {
        checkedAtMs: NOW,
        okAtMs: NOW,
        rows: [
          row("anthropic.five_hour", {
            window: "five_hour",
            percentRemaining: 43.4,
            resetsAt: RESET,
          }),
          row("anthropic.weekly", {
            label: "Weekly",
            account: "work",
            window: "week",
            percentRemaining: 88,
          }),
          row("anthropic.extra", {
            label: "Extra",
            type: "budget",
            account: "home",
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
        `  - anthropic.five_hour: window=five_hour, 43% left, resets ${RESET}`,
        "  - anthropic.weekly (account 1): window=week, 88% left",
        "  - anthropic.extra (account 2): 4.5/20 USD",
        "  - anthropic.flag: no, text not shown",
      ],
      absent: ["rows from", "error", "work", "Weekly", "Off"],
    },
    {
      name: "an error in the shared words, without its detail",
      provider: snapshot("openai", {
        checkedAtMs: NOW,
        error: { code: "login_expired", detail: "HTTP 401 Unauthorized" },
      }),
      lines: ["- state: error: Sign in again (login_expired)", "- rows: 0"],
      absent: ["Unauthorized", "error_detail"],
    },
    {
      name: "older rows kept after an error; the provider's message only noted",
      provider: snapshot("copilot", {
        checkedAtMs: NOW,
        okAtMs: NOW - 60_000,
        rows: [row("copilot.monthly", { percentRemaining: 50 })],
        error: { code: "provider_error", status: 503, detail: "Billing endpoint HTTP 503" },
        debug: [
          { key: "deployment", value: "github.com" },
          { key: "error", value: "Copilot: Billing endpoint HTTP 503" },
        ],
      }),
      lines: [
        "- state: partial: Provider error 503 (provider_error, http 503)",
        `- checked_at: ${NOW_ISO} (rows from ${new Date(NOW - 60_000).toISOString()})`,
        "- rows: 1\n  - copilot.monthly: 50% left\n- deployment: github.com",
        "- error: (free text, not shown)",
      ],
      absent: ["Billing"],
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
        rows: Array.from({ length: 10 }, (_, index) =>
          row(`google-agy.r${index}`, { percentRemaining: index }),
        ),
      }),
      lines: ["- rows: 10", "  - google-agy.r7: 7% left\n  - … (2 more)"],
      absent: ["google-agy.r8"],
    },
  ])("builds a provider section from its snapshot: $name", async ({ provider, lines, absent }) => {
    const text = section(await report({ providers: [provider] }), provider.providerId);

    for (const line of lines) expect(text).toContain(line);
    for (const line of absent) expect(text).not.toContain(line);
  });

  const HOME_CANARY = "/Users/CANARYalice";
  const WINDOWS_HOME_CANARY = "C:\\Users\\CANARYname";

  it.each([
    { name: "a cookie header with a bare pipe", text: "Cookie: sid=a|CANARY" },
    { name: "a cookie value with a brace", text: "Cookie: sid=a}CANARY" },
    { name: "an escaped quote in a JSON password", text: String.raw`{"password":"a\"CANARY"}` },
    { name: "a bracket in an array of account ids", text: '{"accountIds":["id]CANARY","id2"]}' },
    { name: "a name in JSON unicode escapes", text: String.raw`{"account\u0049d":"CANARY"}` },
    { name: "a URL with a key", text: "https://x.example/v1?key=CANARY" },
    { name: "an email address", text: "alice.CANARY@example.com" },
    { name: "a provider's own message", text: "Weekly window failed for team CANARY" },
    { name: "CJK text", text: "账户：CANARY 令牌＝CANARY" },
    { name: "a terminal escape", text: "probe \u001b[31mCANARY\u0007 failed" },
    { name: "a terminal escape inside the home dir", text: "/Users/CANARY\u001b[0malice/x" },
    { name: "a long text ending in the home dir", text: `${"x".repeat(290)} ${HOME_CANARY}/x` },
    {
      name: "a Windows device path to the home dir",
      text: "\\\\?\\C:\\Users\\CANARYname\\x | \\\\.\\C:\\Users\\CANARYname\\y",
      home: WINDOWS_HOME_CANARY,
    },
  ])("never shows free text from a provider or a login: $name", async ({
    text,
    home = HOME_CANARY,
  }) => {
    const free = (key: string) => ({ key, value: text });
    const output = await report({
      homeDir: home,
      currentModel: text,
      providers: [
        snapshot("anthropic", {
          checkedAtMs: NOW,
          rows: [row("anthropic.five_hour", { account: text, label: text, text, flag: true })],
          error: { code: "provider_error", status: 503, detail: text },
          debug: [
            ...["error", "note", "live_fetch_error", "auth_error", "message", "request"].map(free),
            ...["console_org", "console_server", "username_filter", "cli_version"].map(free),
            // Structured keys: shown only when the value is a structured fact.
            ...["auth_source", "api_key_checked_paths", "binary_path", "checked_commands"].map(
              free,
            ),
            { key: "custom_team_check", value: `outcome=failed checked_paths=${text}` },
          ],
        }),
        snapshot("alibaba-token-plan", {
          checkedAtMs: NOW,
          error: { code: "local_tool", tool: text, missing: true, detail: text },
        }),
      ],
      credentialSource: {
        state: "bound",
        kind: "opencode-integration-api",
        lastListError: { at: NOW, detail: text },
        failures: [
          {
            integrationId: text,
            connectionId: "cred_1",
            label: text,
            category: "refresh_failed",
            detail: text,
            at: NOW,
          },
        ],
      },
      usage: {
        totals: { tokens: { processed: 1_000 }, unpricedShare: 1 },
        models: [{ providerID: "deepseek", modelID: text, priced: false, unpricedTokens: 1_000 }],
      } as unknown as UsageReport,
    });

    expect(output).not.toContain("CANARY");
    expect(output).not.toContain("\u001b");
    expect(section(output, "anthropic")).toContain("- error: (free text, not shown)");
    expect(section(output, "anthropic")).toContain("  - anthropic.five_hour (account 1): yes");
    expect(section(output, "alibaba-token-plan")).toContain(
      "- state: error: Local tool not found (local_tool)",
    );
  });

  it.each([
    {
      name: "a long provider id",
      overrides: { providers: [snapshot("minimax-china-coding-plan", { checkedAtMs: NOW })] },
      title: "providers",
      lines: ["- minimax-china-coding-plan: enabled available"],
    },
    {
      name: "row ids, windows, numbers and reset times",
      overrides: {
        providers: [
          snapshot("google-gemini-cli", {
            checkedAtMs: NOW,
            rows: [
              row("google-gemini-cli.model.gemini_2_5_pro", {
                account: "alice@example.com",
                window: "day",
                percentRemaining: 12,
                resetsAt: RESET,
              }),
            ],
          }),
        ],
      },
      title: "google-gemini-cli",
      lines: [
        `  - google-gemini-cli.model.gemini_2_5_pro (account 1): window=day, 12% left, resets ${RESET}`,
      ],
    },
    {
      name: "model ids from the session and the usage history",
      overrides: {
        currentModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        usage: {
          totals: { tokens: { processed: 2_000 }, unpricedShare: 0.5 },
          models: [
            {
              providerID: "deepseek-ai",
              modelID: "DeepSeek-R1-Distill-Qwen-32B",
              priced: false,
              unpricedTokens: 1_000,
            },
          ],
        } as unknown as UsageReport,
      },
      title: "",
      lines: [
        "- currentModel: Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        "  - deepseek-ai/DeepSeek-R1-Distill-Qwen-32B: 1.00K tokens",
      ],
    },
    {
      name: "error kinds and HTTP statuses in our words",
      overrides: {
        providers: [
          snapshot("copilot", {
            checkedAtMs: NOW,
            error: { code: "provider_error", status: 503, detail: "x" },
          }),
          snapshot("xai", {
            checkedAtMs: NOW,
            error: { code: "rate_limited", status: 429, retryAtMs: NOW + 90_000 },
          }),
          snapshot("anthropic", {
            checkedAtMs: NOW,
            error: { code: "local_tool", tool: "Claude CLI", missing: true },
          }),
          snapshot("openai", { checkedAtMs: NOW, error: { code: "network" } }),
        ],
      },
      title: "",
      lines: [
        "- state: error: Provider error 503 (provider_error, http 503)",
        "- state: error: Rate limited, retry in 2m (rate_limited, http 429)",
        "- state: error: Claude CLI not found (local_tool)",
        "- state: error: Can't reach OpenAI (network)",
      ],
    },
    {
      name: "file paths, under the home dir as ~",
      overrides: {
        providers: [
          snapshot("anthropic", {
            debug: [
              { key: "binary_path", value: "/Users/alice/Library/Application Support/claude" },
              {
                key: "checked_commands",
                value:
                  'claude --version | /opt/homebrew/bin/claude auth status --json | "/Users/alice/My Tools/claude" -p',
              },
              {
                key: "api_key_checked_paths",
                value: "env:CHUTES_API_KEY | /Users/alice/.config/opencode/opencode.json",
              },
              {
                key: "custom_production-gateway-us_check",
                value:
                  "outcome=success http_status=200 credential_source=env:TEAM_KEY checked_paths=/Users/alice/.config/opencode/opencode.json | /opt/opencode/opencode.json",
              },
            ],
          }),
        ],
        homeDir: "/Users/alice",
      },
      title: "anthropic",
      lines: [
        "- binary_path: ~/Library/Application Support/claude",
        '- checked_commands: claude --version | /opt/homebrew/bin/claude auth status --json | "~/My Tools/claude" -p',
        "- api_key_checked_paths: env:CHUTES_API_KEY | ~/.config/opencode/opencode.json",
        "- custom_production-gateway-us_check: outcome=success http_status=200 credential_source=env:TEAM_KEY checked_paths=~/.config/opencode/opencode.json | /opt/opencode/opencode.json",
      ],
    },
    {
      name: "states, yes/no, counts, amounts, hosts and windows",
      overrides: {
        providers: [
          snapshot("copilot", {
            debug: [
              { key: "auth_state", value: "configured" },
              { key: "api_key_configured", value: "false" },
              { key: "account_count", value: "2" },
              { key: "api_host", value: "api.github.com" },
              { key: "billing_period", value: "2026-10" },
              { key: "selected_windows", value: "five_hour,weekly" },
              { key: "api_usage", value: "$1.23 across 45 messages" },
              {
                key: "five_hour_usage",
                value: `status=ok percent_used=12 percent_remaining=88 reset_at=${RESET}`,
              },
              { key: "token_expires_at", value: RESET },
              { key: "alibaba auth configured", value: "true" },
              {
                key: "alibaba coding plan local quota",
                value: `path=/opt/state.json exists=true health=healthy version=1 last_update=${RESET}`,
              },
            ],
          }),
        ],
      },
      title: "copilot",
      lines: [
        "- auth_state: configured",
        "- api_key_configured: false",
        "- account_count: 2",
        "- api_host: api.github.com",
        "- billing_period: 2026-10",
        "- selected_windows: five_hour,weekly",
        "- api_usage: $1.23 across 45 messages",
        `- five_hour_usage: status=ok percent_used=12 percent_remaining=88 reset_at=${RESET}`,
        `- token_expires_at: ${RESET}`,
        "- alibaba auth configured: true",
        `- alibaba coding plan local quota: path=/opt/state.json exists=true health=healthy version=1 last_update=${RESET}`,
      ],
    },
  ] as Array<{
    name: string;
    overrides: Partial<QuotaStatusReportParams>;
    title: string;
    lines: string[];
  }>)("still shows the facts a maintainer needs: $name", async ({ overrides, title, lines }) => {
    const output = await report(overrides);
    const text = title ? section(output, title) : output;

    for (const line of lines) expect(text).toContain(line);
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
        lastListError: { at: 1, detail: "Invalid credential value CANARY" },
        failures: [
          {
            integrationId: "openai",
            connectionId: "cred_1",
            label: "work.CANARY@example.com",
            category: "refresh_failed",
            detail: "HTTP 401 CANARY",
            at: 2,
          },
          {
            integrationId: "xai",
            connectionId: "xai",
            label: "",
            category: "active_failed",
            detail: "database is locked CANARY",
            at: 3,
          },
        ],
      },
      lines: [
        "- source: opencode-integration-api",
        "- list_error: bad_response at 1970-01-01T00:00:00.001Z",
        "- failures: openai: refresh_failed at 1970-01-01T00:00:00.002Z | xai: active_failed at 1970-01-01T00:00:00.003Z",
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
    expect(text).not.toContain("CANARY");
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

  function fakeProvider(
    id: string,
    available: boolean | ((ctx: QuotaProviderContext) => boolean),
    result?: QuotaProviderResult,
  ) {
    return {
      id,
      isAvailable: vi.fn(async (ctx: QuotaProviderContext) =>
        typeof available === "function" ? available(ctx) : available,
      ),
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
    expect(syntheticSection).toContain(
      "- state: partial: Provider error 503 (provider_error, http 503)",
    );
    expect(syntheticSection).toContain(
      `- rows: 1\n  - synthetic.five_hour: window=five_hour, 84% left, resets ${RESET}`,
    );
    expect(syntheticSection).toContain("- api_key_source: env:SYNTHETIC_API_KEY");
    expect(syntheticSection).toContain("- access_token: [redacted]");
    expect(syntheticSection).toContain("- error: (free text, not shown)");
    expect(text).not.toContain(SECRET);
    expect(section(text, "providers")).toContain("- openai: disabled unavailable");
    // An unavailable provider shows local setup details: it is never fetched.
    expect(section(text, "openai")).toContain("- state: unavailable\n");
    expect(section(text, "openai")).toMatch(/- opencode_provider: no looked_for=openai\b/u);
    expect(section(text, "pricing_snapshot")).toContain("- unpriced_30d: (no usage)");
    expect(syntheticProvider.fetch).toHaveBeenCalledOnce();
    expect(openai.fetch).not.toHaveBeenCalled();
    expect(onDetectedProviderIds).toHaveBeenCalledWith(["synthetic"]);
    expect(data.payload?.liveProbes).toEqual([{ id: "synthetic", ok: false }]);
    expect(data.payload?.providers.map((provider) => provider.id)).toEqual(["synthetic", "openai"]);
    expect(data.hasComparableProviderData).toBe(true);
    expect(JSON.stringify(data.payload)).not.toContain(SECRET);
  });

  it("shows the real API-key setup details of providers without a key", async () => {
    vi.stubEnv("CHUTES_API_KEY", "");
    vi.stubEnv("SYNTHETIC_API_KEY", "");
    registry.providers = [chutesProvider, syntheticProvider];

    const { text } = await statusData();

    for (const id of ["chutes", "synthetic"]) {
      expect(section(text, id)).toContain("- state: unavailable\n");
      expect(section(text, id)).toContain("- api_key_configured: false\n- api_key_source: (none)");
    }
  });

  it("shows where every API-key provider looked for its key, without asking it for quota", async () => {
    const ids = [
      ...Object.keys(API_KEY_VENDORS),
      ...Object.keys(API_KEY_LOGIN_VENDORS),
      "openrouter",
    ];
    for (const name of [...Object.values(API_KEY_VENDORS), ...Object.values(API_KEY_LOGIN_VENDORS)]
      .flatMap((vendor) => vendor.envVars)
      .concat("OPENROUTER_API_KEY")) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");
    const providers = ids.map((id) => fakeProvider(id, false));
    registry.providers = providers;
    const configPath = join(root, "config", "opencode", "opencode.json");
    mkdirSync(join(root, "config", "opencode"), { recursive: true });
    writeFileSync(configPath, "{}");

    const { text } = await statusData();

    for (const id of ids) {
      const lines = section(text, id);
      expect(lines).toContain("- state: unavailable\n");
      expect(lines).toContain(
        id === "zai" ? "- api_key_configured: true" : "- api_key_configured: false",
      );
      expect(lines).toContain("- api_key_checked_paths: ");
      expect(lines).toContain("~/config/opencode/opencode.json");
    }
    expect(section(text, "zai")).toContain("- api_key_source: env:ZAI_API_KEY");
    expect(section(text, "zai")).toContain("- auth_state: configured");
    expect(text).not.toContain("zai-test-key");
    for (const provider of providers) expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("uses the plugin's availability rule everywhere, and runs no provider that is turned off", async () => {
    // Like the custom providers: available only when every model is checked, as v6 does.
    const custom = fakeProvider("quota-providers", (ctx) => !ctx.config.onlyCurrentModel);
    const chutes = fakeProvider("chutes", true);
    registry.providers = [custom, chutes];
    writeV5Settings({ enabledProviders: ["quota-providers"], onlyCurrentModel: true });

    const { data, text } = await statusData();

    expect(section(text, "providers")).toBe(
      "providers:\n- quota-providers: enabled available\n- chutes: disabled available",
    );
    expect(section(text, "quota-providers")).toContain(
      "- state: error: Nothing reported (no_data)\n",
    );
    expect(custom.fetch).toHaveBeenCalledOnce();
    expect(section(text, "chutes")).toBe("chutes:\n- state: disabled");
    expect(chutes.fetch).not.toHaveBeenCalled();
    expect(data.payload?.liveProbes).toEqual([{ id: "quota-providers", ok: false }]);
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
