import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot, QuotaRow } from "../src/core/types.js";
import type { UsageReport } from "../src/core/usage.js";
import { WINDOWS } from "../src/core/windows.js";
import { API_KEY_LOGIN_VENDORS, API_KEY_VENDORS } from "../src/lib/api-key-resolver.js";
import { COPILOT_AUTH_KEYS } from "../src/lib/copilot.js";
import { CURSOR_CANONICAL_PLUGIN_PACKAGE } from "../src/lib/cursor-detection.js";
import type { QuotaProviderContext, QuotaProviderResult } from "../src/lib/entries.js";
import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { AGY_AUTH_KEYS } from "../src/lib/google-agy.js";
import { GEMINI_CLI_AUTH_KEYS } from "../src/lib/google-gemini-cli.js";
import { __resetPricingSnapshotForTests } from "../src/lib/modelsdev-pricing.js";
import { OPENAI_AUTH_SOURCE_KEYS } from "../src/lib/openai.js";
import {
  QUOTA_PROVIDER_CATALOG,
  QUOTA_PROVIDER_RUNTIME_IDS,
} from "../src/lib/provider-metadata.js";
import { buildStatusReportData } from "../src/lib/quota-dialog-commands.js";
import type { QuotaProviderDefinition } from "../src/lib/quota-providers.js";
import {
  buildQuotaStatusReport,
  buildQuotaStatusReportDocument,
  KNOWN_ABSOLUTE_PATHS,
  KNOWN_FILE_NAMES,
  KNOWN_PATH_PARTS,
  type QuotaStatusReportParams,
} from "../src/lib/quota-status.js";
import { getPackageVersion } from "../src/lib/version.js";
import { chutesProvider } from "../src/providers/chutes.js";
import { syntheticProvider } from "../src/providers/synthetic.js";
import {
  defaultSettings,
  loadSettings,
  SETTINGS_SCHEMA,
  type V5Conversion,
} from "../src/settings/index.js";
import { PROVIDER_ROW_KEYS } from "./helpers/provider-assertions.js";

const registry = vi.hoisted(() => ({ providers: [] as unknown[] }));

// The providers are the edge here: fakes that answer like the real adapters.
vi.mock("../src/providers/registry.js", () => ({ getProviders: () => registry.providers }));

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const RESET = "2026-10-11T00:00:00.000Z";
const SECRET = "status-secret-canary-0123456789";
/** A model id the shipped price list has. */
const KNOWN_MODEL = "gpt-4.1";

let root: string;

/** One temp folder is the home dir and holds every OpenCode folder, at OpenCode's defaults. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-quota-status-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  for (const name of [
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DB",
    "CURSOR_API_KEY",
    "CURSOR_ACP_HOME_DIR",
  ]) {
    vi.stubEnv(name, "");
  }
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

function remoteDefinition(
  id: string,
  extra: Record<string, unknown> = {},
): QuotaProviderDefinition {
  return {
    id,
    providerId: id,
    label: id,
    mode: "remote-api",
    url: `https://${id}.example/quota`,
    format: "quota-v1",
    ...extra,
  } as QuotaProviderDefinition;
}

/** Splits a printed line into its words; a path, a row id or a sentence is several. */
const WORD_SPLIT = /[\s,|=:()/\\;.…"'`{}<>$+[\]]+/u;
/** Any ISO-shaped time, also one before 2000 or after 2099. */
const ANY_ISO_TIME = /[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu;
/** A secret of digits only: no number the report prints may hold it. */
const DIGITS = "987654321098765";
/** Texts that look like a time but are none the report may print. */
const DATE_LIKE = [
  "987654",
  "20261011",
  "2026-13-45",
  "+275760-09-13T00:00:00.000Z",
  "1999-12-31T23:59:59.999Z",
  "2100-01-01T00:00:00.000Z",
];
/** Secrets that are also words of the report: each may show only where that word belongs. */
const KNOWN_WORD_SECRETS = [
  "anthropic",
  "opencode",
  "present",
  "true",
  "set",
  "five_hour",
  "settings.jsonc",
  "OPENROUTER_API_KEY",
];

/** The report's own fixed words: its keys, states, codes and the words of its sentences. */
const REPORT_WORDS: readonly string[] = `
  - Couldn Local Provider Rate a account account_count active age_ms and api_host
  api_key_checked_paths api_key_diagnostics api_key_source are arg at auth_selected_path
  auth_source auth_state auto auto_refresh_days billing_cycle_start_day binary_path bundled
  bundled_only check checked_at checked_commands checked_paths cli_version code config_source
  configured conversion conversion_converted conversion_dropped conversion_invalid
  conversion_notes converted credential_source currency currentModel custom_provider
  cycle_reset_at data date debug details downloaded dropped enabledProviders enterprise env
  error exists experimental expired failures false file files found from future generated_at
  github global history home_frequency host http http_error http_status id in integration
  internal invalid jsonc_used_over_json left limited line list list_error live_error_usage
  local_state_path local_tool maintainer_announcements matchesCurrentModel max_age_ms memory
  missing models more network no none not not_read number oauth_configured of ok on
  opencode-integration-api opencode_db opencode_dirs opencode_provider other out outcome part
  partial pat_enterprise pat_organization pat_path paths per present price pricing_snapshot
  project-scope project_settings provider provider_error quotaProviders quotaToast range
  rate_limited read refresh refresh_failed refresh_policy refresh_state remote-api resets
  retry row rows runtime_paths selected_windows selection set settings_file settings_issue
  shown snapshot stale staleness success syntax t text the token token_expires_at tokens tool
  true unbound unit units unknown unpriced unpriced_30d usage v5 value window workspace_root
  written yes yet ~
`.split(/\s+/u);

/**
 * Every word the report may print: the members of the sets it reads (provider ids and labels,
 * OpenCode's ids, row keys, setting keys, env variable names, path parts, windows, currencies,
 * login keys) and the report's own fixed words. A provider's text, a label or a path never is one.
 */
function reportVocabulary(): Set<string> {
  const members = [
    ...Object.keys(QUOTA_PROVIDER_CATALOG),
    ...Object.values(QUOTA_PROVIDER_CATALOG).map((entry) => entry.label),
    ...Object.values(QUOTA_PROVIDER_RUNTIME_IDS).flat(),
    ...Object.keys(SETTINGS_SCHEMA),
    ...[...Object.values(API_KEY_VENDORS), ...Object.values(API_KEY_LOGIN_VENDORS)].flatMap(
      (vendor) => vendor.envVars,
    ),
    "OPENROUTER_API_KEY",
    "CURSOR_API_KEY",
    "MIMO_USAGE_COOKIE",
    ...Object.values(PROVIDER_ROW_KEYS).flat(),
    ...KNOWN_PATH_PARTS,
    ...KNOWN_FILE_NAMES,
    ...KNOWN_ABSOLUTE_PATHS,
    ...COPILOT_AUTH_KEYS,
    ...AGY_AUTH_KEYS,
    ...GEMINI_CLI_AUTH_KEYS,
    ...OPENAI_AUTH_SOURCE_KEYS,
    CURSOR_CANONICAL_PLUGIN_PACKAGE,
    ...Object.keys(WINDOWS),
    ...Intl.supportedValuesOf("currency"),
    KNOWN_MODEL,
    ...REPORT_WORDS,
  ];
  return new Set(members.flatMap((text) => text.split(WORD_SPLIT)));
}

const DATE = String.raw`20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;
const TIME = String.raw`(?:${DATE}|\(none\)|\(invalid date\))`;
/** A whole number this report counts: rows, accounts, parts, details, keys. */
const SMALL = String.raw`\d{1,3}`;
const RANGED = String.raw`(?:${SMALL}|\(out of range\))`;
/** Three significant digits at most, then K, M, B or T. */
const AMOUNT = String.raw`(?:-?\d{1,3}(?:\.\d{1,2})?[KMBT]?|-?0\.0*[1-9]\d{0,2}|\(not a number\)|\(out of range\))`;
const UNIT = String.raw`(?:[\w-]+|\((?:custom unit|currency|unit)\))`;
const ROW_FACT = String.raw`(?:window=\S+|${SMALL}% left|percent \(out of range\)|${AMOUNT}/${AMOUNT} ${UNIT}|${AMOUNT} ${UNIT}|yes|no|text not shown|resets ${TIME})`;
const ROW_ID = String.raw`(?:\(other row\)|[\w-]+(?:\.(?:[\w-]+|\((?:part|custom) ${SMALL}\)|\(other row\)))*)`;

/**
 * Every form of a line that has a number, by its field: each number is one this report
 * formats, in that field's range. A line with any other number is a leak.
 */
const NUMBER_LINES: readonly RegExp[] = [
  String.raw`- settings_issue: \S+: syntax error on line ${RANGED}`,
  String.raw`- settings_issue: ${SMALL} unknown keys?`,
  String.raw`- conversion: from .+ \(${SMALL} converted, ${SMALL} dropped, ${SMALL} invalid\); .+`,
  String.raw`- conversion_\w+: .*\(\+${SMALL} unknown keys?\)|- conversion_\w+: ${SMALL} unknown keys?`,
  String.raw`- enabledProviders: .+ \(\+${SMALL} unknown ids?\)`,
  String.raw`- custom_provider: custom ${SMALL} (?:off .+|\([\w-]+, (?:${SMALL} models?|all models)(?:, tunes [\w-]+)?\))`,
  String.raw`- (?:active|future|expired): ${SMALL}`,
  String.raw`- (?:checked_at|token_expires_at|cycle_reset_at|reset_at|billing_period_end|grace_until|local_state_last_update): ${TIME}(?: \(rows from ${TIME}\))?`,
  String.raw`- (?:list_error|failures): .*`,
  String.raw`- state: (?:error|partial): [^()]*\((?:[\w ]+|[\w_]+, http \d{3})\)`,
  String.raw`- rows: ${SMALL}`,
  String.raw`  - ${ROW_ID}(?: \(account ${SMALL}\))?: ${ROW_FACT}(?:, ${ROW_FACT})*`,
  String.raw`  - … \(${SMALL} more\)`,
  String.raw`- ${SMALL} other details? not shown`,
  String.raw`- (?:account_count|valid_account_count|unknown_cursor_models|local_state_version): ${RANGED}`,
  String.raw`- billing_cycle_start_day: (?:\d{1,2}|\(out of range\))`,
  String.raw`- cli_version: (?:${SMALL}\.${SMALL}\.${SMALL}|\(out of range\))`,
  String.raw`- billing_period: (?:20\d\d-\d\d|\(invalid date\))`,
  String.raw`- custom ${SMALL} check: .*`,
  String.raw`- pricing: source=\w+ generated_at=${TIME} units=(?:USD per 1M tokens|\(other units\))`,
  String.raw`- staleness: age_ms=[\d,]+ max_age_ms=[\d,]+ stale=(?:true|false)`,
  String.raw`- refresh_policy: auto_refresh_days=\d{1,4}`,
  String.raw`- refresh: last_attempt_at=${TIME} last_success_at=${TIME} last_failure_at=${TIME} last_result=\S+`,
  String.raw`- providers: \d{1,4}`,
  String.raw`- unpriced_30d: \d{1,3}\.\d% of ${AMOUNT} tokens`,
  String.raw`  - [\w.-]+/[\w.-]+: ${AMOUNT} tokens`,
  String.raw`  - … \(${SMALL} more unpriced models?\)`,
].map((form) => new RegExp(`^(?:${form})$`, "u"));

const NO_VALUE = String.raw`\(none\)|\(unknown\)|unknown`;
const PATH = String.raw`(?:~(?:/[^\s/|]+)*|\(custom path\)(?:/[^\s/|]+)?)`;

/**
 * Lines whose whole form is fixed, number or not: which lines, and the form. A secret that is
 * also a known word shows in none of these fields.
 */
const FIELD_FORMS: ReadonlyArray<readonly [RegExp, RegExp]> = (
  [
    [
      /^ {2}- /u,
      String.raw`  - ${ROW_ID}(?: \(account ${SMALL}\))?: ${ROW_FACT}(?:, ${ROW_FACT})*|  - … \(${SMALL} more\)|  - [\w.-]+/[\w.-]+: ${AMOUNT} tokens|  - … \(${SMALL} more unpriced models?\)`,
    ],
    [
      /^- custom_provider: /u,
      String.raw`- custom_provider: custom ${SMALL} (?:off \(switch on in /quota_settings → Providers\)|\((?:remote-api|local-estimate), (?:${SMALL} models?|all models)(?:, tunes [\w-]+)?\))`,
    ],
    [
      /^- currentModel: /u,
      String.raw`- currentModel: (?:gpt-4\.1|\((?:a model not in the price list|error: session\.get returned no modelID|no session available|unknown)\))`,
    ],
    [/^- settings_file: /u, String.raw`- settings_file: ${PATH} \((?:exists|missing; .+)\)`],
    [/^- workspace_root: /u, String.raw`- workspace_root: ${PATH}`],
    [/^- pat_(?:organization|enterprise): /u, String.raw`- pat_\w+: (?:set|not set|${NO_VALUE})`],
    [
      /^- api_host: /u,
      String.raw`- api_host: (?:api\.github\.com|github enterprise \(custom host\)|${NO_VALUE})`,
    ],
    [
      /^- deployment: /u,
      String.raw`- deployment: (?:github\.com|ghe\.com|invalid|none|${NO_VALUE})`,
    ],
    [
      /^- auth_state: /u,
      String.raw`- auth_state: (?:none|configured|invalid|missing|present|${NO_VALUE})`,
    ],
    [
      /^- subscription_state: /u,
      String.raw`- subscription_state: (?:active|grace|inactive|${NO_VALUE})`,
    ],
  ] as const
).map(([lines, form]) => [lines, new RegExp(`^(?:${form})$`, "u")] as const);

/**
 * What a printed text breaks of the closed vocabulary: words that are no member, numbers in a
 * line of no number form, times outside 2000 to 2099, and fields not in their fixed form.
 * The heading is checked as the exact line it must be.
 */
function vocabularyProblems(
  lines: readonly string[],
  vocabulary: ReadonlySet<string>,
  numberLines: readonly RegExp[],
): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    for (const time of line.match(ANY_ISO_TIME) ?? []) {
      if (!new RegExp(`^${DATE}$`, "u").test(time)) problems.push(`time ${time} in: ${line}`);
    }
    const words = line.replace(ANY_ISO_TIME, " ").split(WORD_SPLIT);
    const unknown = words.filter((word) => word !== "" && !vocabulary.has(word));
    const numbers = unknown.filter((word) => /\d/u.test(word));
    for (const word of unknown) {
      if (!/^-?\d+[%KMBTmh]?$/u.test(word)) problems.push(`word ${word} in: ${line}`);
    }
    if (numbers.length > 0 && !numberLines.some((form) => form.test(line))) {
      problems.push(`numbers ${numbers.join(" ")} in: ${line}`);
    }
    for (const [which, form] of FIELD_FORMS) {
      if (which.test(line) && !form.test(line)) problems.push(`form of: ${line}`);
    }
  }
  return problems;
}

/** Each env variable a provider section names is one that provider reads, or `env:(other)`. */
function envProblems(text: string): string[] {
  const vendors: Record<string, { envVars: readonly string[] }> = {
    ...API_KEY_VENDORS,
    ...API_KEY_LOGIN_VENDORS,
    openrouter: { envVars: ["OPENROUTER_API_KEY"] },
    cursor: { envVars: ["CURSOR_API_KEY"] },
    xiaomi: { envVars: ["MIMO_USAGE_COOKIE"] },
  };
  return text.split("\n\n").flatMap((block) => {
    const id = (block.split("\n")[0] ?? "").replace(/:$/u, "");
    const allowed = ["(other)", ...(vendors[id]?.envVars ?? [])];
    return [...block.matchAll(/env:(\S+?)(?=$|[\s|,])/gmu)]
      .map((match) => match[1] ?? "")
      .filter((name) => !allowed.includes(name))
      .map((name) => `env:${name} in ${id}`);
  });
}

/** The leaves of a JSON value as `path: value` lines. */
function jsonLines(value: unknown, path = ""): string[] {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => jsonLines(item, `${path}${key}.`));
  }
  return [`${path.slice(0, -1)}: ${String(value)}`];
}

/** A small seeded random source, so a failure can be run again. */
function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random text for every free field: words with "zq" in them in many shapes (paths, env names,
 * URLs, terminal escapes, `name=value` lists), 40-character hex tokens (kept to look for), the
 * digit-only secret, date-like texts and secrets that are also words of the report.
 */
function garbageSource(seed: number) {
  const random = randomSource(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const chars = (alphabet: string, length: number) =>
    Array.from({ length }, () => pick([...alphabet])).join("");
  const hex: string[] = [];
  const word = () => `zq${chars("abcdefghijklmnopqrstuvwxyz0123456789", (4 + random() * 12) | 0)}`;
  const garbage = (): string => {
    const w = word();
    const forms = [
      () => w,
      () => w.toUpperCase(),
      () => `SK-${w}`,
      () => `env:${w.toUpperCase()}_KEY`,
      () => `env:${pick(["ZAI_API_KEY", "OPENROUTER_API_KEY", "MIMO_USAGE_COOKIE"])}`,
      () => `~/${w}/opencode.db`,
      () => join(root, w, "settings.jsonc"),
      () => join(root, ".config", w, "auth.json"),
      () => `${w}@example.com`,
      () => `\u001b[31m${w}\u001b[0m`,
      () => `https://${w}.example/v1?key=${w}`,
      () => `outcome=success checked_paths=${w}`,
      () => `yes found=openai,${w}`,
      () => `true key=${w}`,
      () => `${w} ${w}`,
      () => DIGITS,
      () => `${DIGITS}.1.2`,
      () => pick(DATE_LIKE),
      () => pick(KNOWN_WORD_SECRETS),
      () => {
        const token = chars("0123456789abcdef", 40);
        hex.push(token);
        return token;
      },
    ];
    return pick(forms)();
  };
  return { random, pick, word, garbage, hex };
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
          debug: [{ key: "opencode_provider", value: "no looked_for=openai,codex" }],
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
    expect(section(text, "openai")).toContain("- opencode_provider: no looked_for=openai,codex");
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

  it("shows a path made of known folders under the home dir as ~, and every other path as (custom path)", async () => {
    const params_ = params({
      settings: {
        path: join(root, ".config", "opencode", "opencode-quota", "settings.jsonc"),
        exists: true,
        issues: [],
        notRead: [`${root}foo/quota-toast.json`, "/opt/x"],
      },
      workspaceRoot: join(root, "project"),
      providers: [
        snapshot("anthropic", {
          debug: [{ key: "binary_path", value: join(root, ".local", "bin", "claude") }],
        }),
      ],
    });

    const text = await buildQuotaStatusReport(params_);
    const document = await buildQuotaStatusReportDocument(params_);

    expect(text).toContain(
      "- settings_file: ~/.config/opencode/opencode-quota/settings.jsonc (exists)",
    );
    expect(text).toContain("- not_read: (custom path)/quota-toast.json | (custom path)\n");
    expect(text).toContain("- workspace_root: (custom path)\n");
    expect(text).toContain(
      "- opencode_dirs: data=~/.local/share/opencode config=~/.config/opencode cache=~/.cache/opencode state=~/.local/state/opencode",
    );
    expect(text).toContain("- opencode.db: path=~/.local/share/opencode/opencode.db present=false");
    expect(text).toContain(
      "- runtime_paths: snapshot=~/.cache/opencode/opencode-quota/modelsdev-pricing.runtime.min.json refresh_state=~/.cache/opencode/opencode-quota/modelsdev-pricing.refresh-state.json",
    );
    expect(text).toContain("- binary_path: ~/.local/bin/claude");
    expect(text).not.toContain(root);
    expect(JSON.stringify(document)).not.toContain(root);
  });

  it("shows the folders an env variable chose as (custom path)", async () => {
    vi.stubEnv("XDG_DATA_HOME", join(root, "my-data"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, ".config", "opencode"));

    const text = section(await report(), "paths");

    expect(text).toContain(
      "- opencode_dirs: data=(custom path) config=~/.config/opencode cache=~/.cache/opencode state=~/.local/state/opencode",
    );
    expect(text).toContain("- opencode.db: path=(custom path)/opencode.db present=false");
  });

  it("shows a JSON-quoted Windows command under a home with a space as ~", async () => {
    const command = `${JSON.stringify("C:\\Users\\Alice Smith\\.local\\bin\\claude")} auth status --json`;
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
      "- checked_commands: claude --version | ~/.local/bin/claude auth status --json",
    );
    expect(anthropic).not.toContain("Alice");
  });

  it.each([
    {
      name: "ledger row ids, windows and numbers; accounts as numbers",
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
          row("anthropic.extra_usage", {
            label: "Extra",
            type: "budget",
            account: "home",
            used: { decimal: "4.50", unit: { kind: "currency", code: "USD" } },
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
        "  - anthropic.extra_usage (account 2): 4.5/20 USD",
        "  - anthropic.(other row): no, text not shown",
      ],
      absent: ["rows from", "error", "work", "Weekly", "Off", "flag"],
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
      name: "older rows kept after an error; the provider's message only counted",
      provider: snapshot("copilot", {
        checkedAtMs: NOW,
        okAtMs: NOW - 60_000,
        rows: [row("copilot.allowance", { percentRemaining: 50 })],
        error: { code: "provider_error", status: 503, detail: "Billing endpoint HTTP 503" },
        debug: [
          { key: "deployment", value: "github.com" },
          { key: "error", value: "Copilot: Billing endpoint HTTP 503" },
        ],
      }),
      lines: [
        "- state: partial: Provider error 503 (provider_error, http 503)",
        `- checked_at: ${NOW_ISO} (rows from ${new Date(NOW - 60_000).toISOString()})`,
        "- rows: 1\n  - copilot.allowance: 50% left\n- deployment: github.com",
        "- 1 other detail not shown",
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
      name: "a long row list, cut; a part the provider named, numbered",
      provider: snapshot("google-agy", {
        checkedAtMs: NOW,
        rows: Array.from({ length: 10 }, (_, index) =>
          row(`google-agy.model${index}.weekly`, { percentRemaining: index }),
        ),
      }),
      lines: [
        "- rows: 10",
        "  - google-agy.(part 1).weekly: 0% left",
        "  - google-agy.(part 8).weekly: 7% left\n  - … (2 more)",
      ],
      absent: ["model7", "(part 9)"],
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
            // Allowed keys: shown only through their rule.
            ...["auth_status", "binary_path", "checked_commands"].map(free),
            { key: "custom_team_check", value: `outcome=success checked_paths=${text}` },
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
    expect(section(output, "anthropic")).toMatch(/- \d+ other details not shown/u);
    expect(section(output, "anthropic")).toContain("  - anthropic.five_hour (account 1): yes");
    expect(section(output, "alibaba-token-plan")).toContain(
      "- state: error: Local tool not found (local_tool)",
    );
  });

  const HEX_CANARY = "0123456789abcdef0123456789abcdef01234567";
  const SK_CANARY = "sk-secretcanary0123456789";

  it.each([
    {
      name: "a lowercase word as a login state",
      canary: "lowercasecanary",
      overrides: {
        providers: [snapshot("zai", { debug: [{ key: "auth_state", value: "lowercasecanary" }] })],
      },
    },
    {
      name: "an env variable this plugin does not read",
      canary: "SECRET_CANARY_0123456789",
      shows: "- auth_source: env:(other)",
      overrides: {
        providers: [
          snapshot("opencode-go", {
            debug: [{ key: "auth_source", value: "env:SECRET_CANARY_0123456789" }],
          }),
        ],
      },
    },
    {
      name: "a folder under the home dir this plugin did not name",
      canary: "lowercasecanary",
      shows: "- binary_path: (custom path)/claude",
      overrides: {
        providers: [
          snapshot("anthropic", {
            debug: [{ key: "binary_path", value: "~/lowercasecanary/claude" }],
          }),
        ],
      },
    },
    {
      name: "a debug key no allow list has",
      canary: "lowercasecanary",
      shows: "- 1 other detail not shown",
      overrides: {
        providers: [snapshot("zai", { debug: [{ key: "lowercasecanary", value: "true" }] })],
      },
    },
    {
      name: "a short secret as the session's model",
      canary: "lowercasecanary",
      shows: "- currentModel: (a model not in the price list)",
      overrides: { currentModel: "lowercasecanary" },
    },
    {
      name: "a short secret as a model of the usage history",
      canary: "lowercasecanary",
      shows: "  - … (1 more unpriced model)",
      overrides: {
        usage: {
          totals: { tokens: { processed: 1_000 }, unpricedShare: 1 },
          models: [
            { providerID: "openai", modelID: "lowercasecanary", priced: false, unpricedTokens: 9 },
          ],
        } as unknown as UsageReport,
      },
    },
    {
      name: "a token in a rejected providers.enabled value",
      canary: HEX_CANARY,
      shows: "- settings_issue: providers.enabled: unknown provider id",
      overrides: {
        settings: {
          path: "/cfg/settings.jsonc",
          exists: true,
          issues: [
            {
              key: "providers.enabled",
              message: `unknown provider id(s): ${HEX_CANARY}; valid: openai`,
            },
          ],
          notRead: [],
        },
      },
    },
    {
      name: "an invalid v5 value",
      canary: "lowercasecanary",
      shows: "- conversion_invalid: percentDisplayMode",
      overrides: {
        conversion: conversion({
          invalid: [
            {
              key: "percentDisplayMode",
              reason: '"lowercasecanary" was not valid in v5 either',
            },
          ],
        }),
      },
    },
    {
      name: "unknown setting keys",
      canary: "lowercasecanary",
      shows: "- settings_issue: 2 unknown keys",
      overrides: {
        settings: {
          path: "/cfg/settings.jsonc",
          exists: true,
          issues: [
            { key: "lowercasecanary", message: "unknown setting; valid: version" },
            { key: "words.lowercasecanary", message: "unknown setting; valid in group: x" },
          ],
          notRead: [],
        },
        conversion: conversion({
          dropped: [{ key: "lowercasecanary", reason: "not a v5 setting" }],
        }),
      },
    },
    {
      name: "a custom definition's id, provider id, env variable and model ids",
      canary: "secretcanary",
      shows: "- custom_provider: custom 1 (remote-api, 1 model)",
      overrides: {
        quotaProviders: [
          remoteDefinition(SK_CANARY, { apiKeyEnv: "SK_SECRETCANARY", modelIds: [SK_CANARY] }),
        ],
        providers: [
          snapshot("quota-providers", {
            rows: [
              row(`quota-providers.custom.${SK_CANARY}.${SK_CANARY}`, { percentRemaining: 5 }),
            ],
            debug: [
              {
                key: `custom_${SK_CANARY}_check`,
                value: "outcome=success credential_source=explicit_env checked_paths=(none)",
              },
            ],
          }),
        ],
      },
    },
    {
      name: "a token in a row id the provider named",
      canary: HEX_CANARY,
      shows: "  - google-gemini-cli.model.(part 1): 5% left",
      overrides: {
        providers: [
          snapshot("google-gemini-cli", {
            rows: [row(`google-gemini-cli.model.${HEX_CANARY}`, { percentRemaining: 5 })],
          }),
        ],
      },
    },
    {
      name: "a custom amount symbol",
      canary: "SECRETCANARY",
      shows: "  - xai.credits: 5 (custom unit)",
      overrides: {
        providers: [
          snapshot("xai", {
            rows: [
              row("xai.credits", {
                amount: { decimal: "5", unit: { kind: "custom", symbol: "SECRETCANARY" } },
              }),
            ],
          }),
        ],
      },
    },
    {
      name: "an OPENCODE_DB path",
      canary: "secretcanary",
      shows: "- opencode.db: path=(custom path)/opencode.db",
      env: { OPENCODE_DB: `~/${SK_CANARY}/opencode.db` },
      overrides: {},
    },
    {
      name: "a terminal escape inside the home dir of a path",
      canary: "CANARY",
      shows: "- settings_file: ~/.config/opencode/opencode-quota/settings.jsonc (exists)",
      overrides: {
        homeDir: HOME_CANARY,
        settings: {
          path: "/Users/CANARY\u001b[0malice/.config/opencode/opencode-quota/settings.jsonc",
          exists: true,
          issues: [],
          notRead: [],
        },
        providers: [
          snapshot("anthropic", {
            debug: [{ key: "binary_path", value: "/Users/CANARY\u001b[0malice/.local/bin/claude" }],
          }),
        ],
      },
    },
    {
      name: "an unknown error code",
      canary: "lowercasecanary",
      shows: "- state: error: (unknown error code)",
      overrides: {
        providers: [
          snapshot("openai", {
            checkedAtMs: NOW,
            error: { code: "lowercasecanary" as "internal", status: 503 },
          }),
        ],
      },
    },
    {
      name: "an unknown window and reset time",
      canary: "lowercasecanary",
      shows: "  - openai.weekly: window=(other), resets (invalid date)",
      overrides: {
        providers: [
          snapshot("openai", {
            rows: [
              row("openai.weekly", {
                window: "lowercasecanary" as "week",
                resetsAt: "lowercasecanary",
              }),
            ],
          }),
        ],
      },
    },
    {
      name: "an unknown login integration",
      canary: "lowercasecanary",
      shows: "- failures: (other integration): refresh_failed",
      overrides: {
        credentialSource: {
          state: "bound",
          kind: "sqlite",
          failures: [
            {
              integrationId: "lowercasecanary",
              connectionId: "c",
              label: "lowercasecanary",
              category: "refresh_failed",
              detail: "lowercasecanary",
              at: NOW,
            },
          ],
        },
      },
    },
    {
      name: "an unknown provider id in the provider list and a row",
      canary: "lowercasecanary",
      shows: "- (other provider): enabled available",
      overrides: {
        enabledProviders: ["openai", "lowercasecanary"],
        providerAvailability: [{ id: "lowercasecanary", enabled: true, available: true }],
        providers: [
          snapshot("lowercasecanary", {
            rows: [row("lowercasecanary.five_hour", { percentRemaining: 1 })],
          }),
        ],
      },
    },
    {
      name: "v5 source files, notes and a write failure",
      canary: "lowercasecanary",
      shows: "- conversion_notes: (other)",
      overrides: {
        conversion: conversion({
          sources: ["/lowercasecanary/opencode.json (experimental.quotaToast)"],
          notes: ["/lowercasecanary/x was not converted"],
          notWrittenReason: "could not write /lowercasecanary/settings.jsonc",
        }),
      },
    },
  ] as Array<{
    name: string;
    canary: string;
    shows?: string;
    env?: Record<string, string>;
    overrides: Partial<QuotaStatusReportParams>;
  }>)("shows only members of its own sets: $name", async ({ canary, shows, env, overrides }) => {
    for (const [name, value] of Object.entries(env ?? {})) {
      vi.stubEnv(name, value.replace(/^~/u, root));
    }

    const output = await report(overrides);

    expect(output.toLowerCase()).not.toContain(canary.toLowerCase());
    if (shows) expect(output).toContain(shows);
  });

  it("shows only fixed words for a downloaded price list's own fields", async () => {
    const dir = join(root, ".cache", "opencode", "opencode-quota");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "modelsdev-pricing.runtime.min.json"),
      JSON.stringify({
        _meta: { source: `https://${SK_CANARY}.example`, generatedAt: NOW, units: SK_CANARY },
        providers: { [SK_CANARY]: { [SK_CANARY]: { input: 1, output: 2 } } },
      }),
    );
    __resetPricingSnapshotForTests();

    const text = section(await report(), "pricing_snapshot");

    expect(text).toContain(
      `- pricing: source=downloaded generated_at=${NOW_ISO} units=(other units)`,
    );
    expect(text).toMatch(/- providers: \d+\n/u);
    expect(text).not.toContain("secretcanary");
  });

  /**
   * A big report where every free field holds random text, and every number and time field a
   * random, digit-only or out-of-range value: ids, labels, accounts, messages, paths, env names,
   * model ids, setting keys, debug keys and values, amounts, percents, counts and times.
   */
  function fuzzedParams(seed: number): { params: QuotaStatusReportParams; hex: string[] } {
    const { random, pick, word, garbage, hex } = garbageSource(seed);
    const huge = Number(DIGITS);
    const validValues = [
      "true",
      "false",
      "configured",
      "present",
      "active",
      "github.com",
      "api.acme.ghe.com",
      "(none)",
      "2",
      "12",
      "2026-10",
      "1.2.3",
      RESET,
      "env:ZAI_API_KEY",
      "env:NANOGPT_API_KEY",
      "opencode.db",
      join(root, ".config", "opencode", "opencode.json"),
      "yes found=openai,codex",
      "outcome=http_error http_status=503 credential_source=opencode_db checked_paths=(none)",
      "claude --version",
      "2.1.3 (Claude Code)",
    ];
    const debugKeys = [
      "auth_state",
      "auth_source",
      "api_key_source",
      "api_key_checked_paths",
      "binary_path",
      "checked_commands",
      "cli_version",
      "pat_path",
      "pat_organization",
      "pat_enterprise",
      "deployment",
      "api_host",
      "billing_period",
      "opencode_provider",
      "oauth_configured",
      "api_key_diagnostics",
      "selected_windows",
      "token_expires_at",
      "cycle_reset_at",
      "account_count",
      "unknown_cursor_models",
      "billing_cycle_start_day",
      "local_state_version",
      "local_state_path",
      "subscription_state",
      "live_error_usage",
      "config_source",
      "auth_selected_path",
      "error",
      "message",
    ];
    const providerIds = Object.keys(QUOTA_PROVIDER_CATALOG);
    const definitions = Array.from({ length: 3 }, () =>
      remoteDefinition(word(), {
        providerId: garbage(),
        apiKeyEnv: garbage(),
        modelIds: [garbage(), KNOWN_MODEL],
      }),
    );
    const providers = [...providerIds, garbage()].map((providerId) =>
      snapshot(providerId, {
        checkedAtMs: pick([NOW, huge, -1]),
        okAtMs: NOW - 1_000,
        error: pick([
          undefined,
          { code: "provider_error", status: 503, detail: garbage() },
          { code: "provider_error", status: huge, detail: garbage() },
          { code: "rate_limited", retryAtMs: NOW + huge },
          { code: "rate_limited", retryAtMs: NOW + 90 * 60_000 },
          { code: garbage() as "internal", status: 999, detail: garbage() },
          { code: "local_tool", tool: garbage(), missing: true },
        ]),
        rows: [...(PROVIDER_ROW_KEYS[providerId] ?? ["five_hour"]), word()].map((key) =>
          row(`${pick([providerId, garbage()])}.${key.replaceAll("*", definitions[0]?.id ?? "")}`, {
            account: garbage(),
            label: garbage(),
            text: garbage(),
            window: pick(["week", garbage()]) as "week",
            percentRemaining: pick([random() * 100, huge, -5, 250]),
            used: {
              decimal: pick(["1.5", DIGITS]),
              unit: { kind: "count", unit: pick(["request", garbage()]) },
            },
            limit: {
              decimal: pick(["10", DIGITS]),
              unit: { kind: "currency", code: pick(["USD", "ZQZ"]) },
            },
            amount: { decimal: garbage(), unit: { kind: "custom", symbol: garbage() } },
            resetsAt: pick([RESET, garbage()]),
          }),
        ),
        debug: [
          ...debugKeys.flatMap((key) => [
            { key, value: garbage() },
            { key, value: pick(validValues) },
          ]),
          { key: garbage(), value: pick(validValues) },
          { key: `custom_${definitions[1]?.id}_check`, value: garbage() },
          { key: `custom_${definitions[2]?.id}_check`, value: pick(validValues) },
        ],
      }),
    );
    vi.stubEnv("OPENCODE_DB", join(root, word(), "opencode.db"));
    vi.stubEnv("XDG_STATE_HOME", join(root, word()));
    return {
      hex,
      params: params({
        settings: {
          path: garbage(),
          exists: false,
          issues: [
            { key: garbage(), message: garbage() },
            { key: "providers.enabled", message: `unknown provider id(s): ${garbage()}` },
            { key: "words.percent", message: `expected ${garbage()}` },
            { key: "$file", message: `syntax error on line ${pick(["3", DIGITS])}: ${garbage()}` },
          ],
          notRead: [garbage(), garbage()],
        },
        conversion: conversion({
          sources: [garbage(), `${garbage()} (experimental.quotaToast)`],
          converted: [{ key: garbage(), to: garbage(), where: "server", note: garbage() }],
          dropped: [
            { key: "debug", reason: garbage() },
            { key: garbage(), reason: garbage() },
          ],
          invalid: [{ key: `quotaProviders[0].${garbage()}`, reason: garbage() }],
          notes: [
            garbage(),
            `${garbage()} was not converted: v5 used ${garbage()} when both exist`,
          ],
          notWrittenReason: garbage(),
        }),
        workspaceRoot: garbage(),
        enabledProviders: ["openai", garbage()],
        quotaProviders: definitions,
        currentModel: pick([garbage(), KNOWN_MODEL]),
        providerAvailability: providers.map((provider) => ({
          id: provider.providerId,
          enabled: true,
          available: true,
          matchesCurrentModel: true,
        })),
        providers,
        credentialSource: {
          state: "bound",
          kind: "opencode-integration-api",
          lastListError: { at: pick([NOW, huge]), detail: garbage() },
          failures: [
            {
              integrationId: garbage(),
              connectionId: garbage(),
              label: garbage(),
              category: "refresh_failed",
              detail: garbage(),
              at: pick([NOW, huge]),
            },
          ],
        },
        usage: {
          totals: { tokens: { processed: pick([9_000, huge]) }, unpricedShare: 0.5 },
          models: [
            { providerID: "openai", modelID: KNOWN_MODEL, priced: false, unpricedTokens: 3_000 },
            { providerID: garbage(), modelID: garbage(), priced: false, unpricedTokens: huge },
            { providerID: "openai", modelID: garbage(), priced: false, unpricedTokens: 3_000 },
          ],
        } as unknown as UsageReport,
      }),
    };
  }

  /** The exact first line: the report's title, this version and the generation time. */
  async function headingLine(): Promise<string> {
    const version = await getPackageVersion();
    return `# Quota Status (opencode-quota v${version}) (/quota_status) ${formatLocalCallTimestamp(NOW)}`;
  }

  it.each([
    { seed: 1 },
    { seed: 2 },
    { seed: 3 },
    { seed: 4 },
    { seed: 5 },
    { seed: 6 },
  ])("prints only words of its own vocabulary, and numbers and times in their field's form (seed $seed)", async ({
    seed,
  }) => {
    const { params: fuzzed, hex } = fuzzedParams(seed);

    const output = await buildQuotaStatusReport(fuzzed);

    const [heading, ...lines] = output.split("\n");
    expect(heading).toBe(await headingLine());
    expect.soft(vocabularyProblems(lines, reportVocabulary(), NUMBER_LINES)).toEqual([]);
    expect.soft(envProblems(output)).toEqual([]);
    expect(output.toLowerCase()).not.toContain("zq");
    expect(output.replaceAll(",", "")).not.toContain(DIGITS.slice(0, 8));
    for (const token of hex) expect(output).not.toContain(token);
    // The report still has its facts: known model, row ids, custom numbers.
    expect(output).toContain(`- currentModel: `);
    expect(output).toContain(`  - openai/${KNOWN_MODEL}: 3.00K tokens`);
    expect(output).toContain("- custom_provider: custom 3 (remote-api, 2 models)");
  });

  it.each([
    {
      name: "row ids from the ledger, windows, numbers and reset times",
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
              row("google-gemini-cli.pro", { percentRemaining: 50 }),
            ],
          }),
        ],
      },
      title: "google-gemini-cli",
      lines: [
        `  - google-gemini-cli.model.(part 1) (account 1): window=day, 12% left, resets ${RESET}`,
        "  - google-gemini-cli.pro: 50% left",
      ],
    },
    {
      name: "model ids the shipped price list has",
      overrides: {
        currentModel: KNOWN_MODEL,
        usage: {
          totals: { tokens: { processed: 2_000 }, unpricedShare: 0.5 },
          models: [
            {
              providerID: "github-copilot",
              modelID: KNOWN_MODEL,
              priced: false,
              unpricedTokens: 1_000,
            },
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
        `- currentModel: ${KNOWN_MODEL}`,
        `  - github-copilot/${KNOWN_MODEL}: 1.00K tokens\n  - … (1 more unpriced model)`,
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
      name: "the Claude CLI's paths and commands",
      overrides: {
        homeDir: "/Users/alice",
        providers: [
          snapshot("anthropic", {
            debug: [
              { key: "cli_installed", value: "true" },
              { key: "cli_version", value: "2.1.3 (Claude Code)" },
              { key: "binary_path", value: "/Users/alice/.claude/local/claude" },
              {
                key: "checked_commands",
                value:
                  'claude --version | /opt/homebrew/bin/claude auth status --json | "/Users/alice/My Tools/claude" -p',
              },
              { key: "auth_status", value: "authenticated" },
              { key: "quota_source", value: "claude-credentials-oauth-api" },
            ],
          }),
        ],
      },
      title: "anthropic",
      lines: [
        "- cli_installed: true",
        "- cli_version: 2.1.3",
        "- binary_path: ~/.claude/local/claude",
        "- checked_commands: claude --version | /opt/homebrew/bin/claude auth status --json | (custom path)/claude (arg)",
        "- auth_status: authenticated",
        "- quota_source: claude-credentials-oauth-api",
      ],
    },
    {
      name: "where an API key was looked for",
      overrides: {
        homeDir: "/Users/alice",
        providers: [
          snapshot("zai", {
            debug: [
              { key: "auth_state", value: "configured" },
              { key: "api_key_configured", value: "true" },
              { key: "api_key_source", value: "env:ZAI_API_KEY" },
              {
                key: "api_key_checked_paths",
                value: "env:ZAI_API_KEY | /Users/alice/.config/opencode/opencode.json",
              },
              {
                key: "api_key_credential_database_paths",
                value: "~/.local/share/opencode/opencode.db",
              },
            ],
          }),
          snapshot("synthetic", {
            debug: [
              {
                key: "api_key_diagnostics",
                value:
                  "configured=true source=opencode.json checked=~/.config/opencode/opencode.json",
              },
            ],
          }),
        ],
      },
      title: "",
      lines: [
        "- auth_state: configured\n- api_key_configured: true\n- api_key_source: env:ZAI_API_KEY",
        "- api_key_checked_paths: env:ZAI_API_KEY | ~/.config/opencode/opencode.json",
        "- api_key_credential_database_paths: ~/.local/share/opencode/opencode.db",
        "- api_key_diagnostics: configured=true source=opencode.json checked=~/.config/opencode/opencode.json",
      ],
    },
    {
      name: "a custom definition's check under its number",
      overrides: {
        homeDir: "/Users/alice",
        quotaProviders: [remoteDefinition("team"), remoteDefinition("production-gateway-us")],
        providers: [
          snapshot("quota-providers", {
            rows: [
              row("quota-providers.custom.production-gateway-us.day", { percentRemaining: 9 }),
            ],
            debug: [
              {
                key: "custom_production-gateway-us_check",
                value:
                  "outcome=success http_status=200 credential_source=explicit_env checked_paths=/Users/alice/.config/opencode/opencode.json | /opt/opencode/opencode.json",
              },
            ],
          }),
        ],
      },
      title: "quota-providers",
      lines: [
        "  - quota-providers.custom.(custom 2).(part 1): 9% left",
        "- custom 2 check: outcome=success http_status=200 credential_source=explicit_env checked_paths=~/.config/opencode/opencode.json | (custom path)/opencode.json",
      ],
    },
    {
      name: "states, yes/no, counts, times and lists",
      overrides: {
        providers: [
          snapshot("copilot", {
            debug: [
              { key: "pat_state", value: "valid" },
              { key: "deployment", value: "github.com" },
              { key: "api_host", value: "api.github.com" },
              {
                key: "oauth_configured",
                value: "true key=github-copilot refresh=true access=false enterprise_host=false",
              },
              { key: "billing_api_access_likely", value: "false" },
              { key: "opencode_provider", value: "yes found=copilot,github-copilot" },
            ],
          }),
          snapshot("google-agy", { debug: [{ key: "account_count", value: "2" }] }),
          snapshot("opencode-go", {
            debug: [
              { key: "selected_windows", value: "rolling,weekly" },
              { key: "console_error", value: "Console returned HTTP 500 for alice" },
            ],
          }),
          snapshot("openai", { debug: [{ key: "token_expires_at", value: RESET }] }),
          snapshot("alibaba-coding-plan", {
            debug: [
              { key: "alibaba auth configured", value: "true" },
              { key: "local_state_health", value: "healthy" },
            ],
          }),
        ],
      },
      title: "",
      lines: [
        "- pat_state: valid\n- deployment: github.com\n- api_host: api.github.com",
        "- oauth_configured: true key=github-copilot refresh=true access=false enterprise_host=false",
        "- billing_api_access_likely: false",
        "- opencode_provider: yes found=copilot,github-copilot",
        "- account_count: 2",
        "- selected_windows: rolling,weekly\n- console_error: (text not shown)",
        `- token_expires_at: ${RESET}`,
        "- alibaba auth configured: true\n- local_state_health: healthy",
      ],
    },
    {
      name: "a Copilot organization, enterprise, GHE host and month, and NanoGPT's subscription, in fixed words",
      overrides: {
        providers: [
          snapshot("copilot", {
            debug: [
              { key: "pat_organization", value: "acme-private-org" },
              { key: "pat_enterprise", value: "acme-private-ent" },
              { key: "api_host", value: "api.acme-private.ghe.com" },
              { key: "billing_period", value: "2026-10" },
            ],
          }),
          snapshot("nanogpt", {
            debug: [
              { key: "subscription_state", value: "grace" },
              { key: "live_error_usage", value: "HTTP 500 for alice" },
              { key: "live_error_balance", value: "timeout" },
            ],
          }),
        ],
      },
      title: "",
      lines: [
        "- pat_organization: set\n- pat_enterprise: set\n- api_host: github enterprise (custom host)",
        "- billing_period: 2026-10",
        "- subscription_state: grace\n- live_error_usage: (text not shown)\n- live_error_balance: (text not shown)",
      ],
      absent: ["acme", "alice"],
    },
    {
      name: "numbers and times only in their range, and env variables only of their provider",
      overrides: {
        providers: [
          snapshot("google-agy", { debug: [{ key: "account_count", value: DIGITS }] }),
          snapshot("anthropic", { debug: [{ key: "cli_version", value: `${DIGITS}.1.2` }] }),
          snapshot("cursor", { debug: [{ key: "billing_cycle_start_day", value: "45" }] }),
          snapshot("copilot", { debug: [{ key: "billing_period", value: "1999-12" }] }),
          snapshot("openai", {
            checkedAtMs: NOW,
            error: { code: "rate_limited", retryAtMs: NOW + Number(DIGITS) },
            rows: [
              row("openai.five_hour", {
                percentRemaining: 250,
                used: { decimal: DIGITS, unit: { kind: "count", unit: "request" } },
                limit: { decimal: "1234.5", unit: { kind: "currency", code: "USD" } },
                resetsAt: "987654",
              }),
            ],
            debug: [{ key: "token_expires_at", value: "2100-01-01T00:00:00.000Z" }],
          }),
          snapshot("nanogpt", {
            debug: [
              { key: "api_key_source", value: "env:ZAI_API_KEY" },
              { key: "api_key_checked_paths", value: "env:NANOGPT_API_KEY | env:ZAI_API_KEY" },
            ],
          }),
        ],
      },
      title: "",
      lines: [
        "- account_count: (out of range)",
        "- cli_version: (out of range)",
        "- billing_cycle_start_day: (out of range)",
        "- billing_period: (invalid date)",
        "- state: partial: Rate limited (rate_limited)",
        "  - openai.five_hour: percent (out of range), 988T/1.23K USD, resets (invalid date)",
        "- token_expires_at: (invalid date)",
        "- api_key_source: env:(other)\n- api_key_checked_paths: env:NANOGPT_API_KEY | env:(other)",
      ],
      absent: ["98765", "ZAI_API_KEY"],
    },
  ] as Array<{
    name: string;
    overrides: Partial<QuotaStatusReportParams>;
    title: string;
    lines: string[];
    absent?: string[];
  }>)("still shows the facts a maintainer needs: $name", async ({
    overrides,
    title,
    lines,
    absent = [],
  }) => {
    const output = await report(overrides);
    const text = title ? section(output, title) : output;

    for (const line of lines) expect(text).toContain(line);
    for (const word of absent) expect(text).not.toContain(word);
    expect(text).not.toContain("other detail");
  });

  it.each([
    {
      name: "the settings file, the providers and the session model",
      overrides: {
        enabledProviders: ["copilot", "openai"],
        onlyCurrentModel: true,
        currentModel: KNOWN_MODEL,
      },
      lines: [
        "- settings_file: (custom path)/settings.jsonc (exists)",
        "- project_settings: none: the settings are global; v5 project-scope files are not read",
        "- enabledProviders: copilot | openai",
        "- onlyCurrentModel: true",
        `- currentModel: ${KNOWN_MODEL}`,
        "- workspace_root: (custom path)",
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
        "- settings_file: (custom path)/settings.jsonc (missing; using the defaults)",
        "- enabledProviders: (none)",
        "- currentModel: (no session available)",
      ],
    },
    {
      name: "auto providers, a session without a model, and settings issues in our words",
      overrides: {
        sessionModelLookup: "not_found",
        settings: {
          path: "/cfg/opencode-quota/settings.jsonc",
          exists: true,
          issues: [
            { key: "$file", message: "syntax error on line 2: ValueExpected" },
            { key: "checking.minIntervalMs", message: "expected a number" },
            { key: "providers.custom[0].url", message: "expected an https URL" },
            { key: "words.percent", message: "duplicate key; the last valid value is used" },
            { key: "colour", message: "unknown setting; valid: version" },
          ],
          notRead: ["/ws/opencode-quota/quota-toast.json"],
        },
      },
      lines: [
        "- enabledProviders: (auto)",
        "- currentModel: (error: session.get returned no modelID)",
        [
          "- settings_issue: $file: syntax error on line 2",
          "- settings_issue: checking.minIntervalMs: invalid value",
          "- settings_issue: providers.custom: invalid value",
          "- settings_issue: words.percent: duplicate key",
          "- settings_issue: 1 unknown key",
        ].join("\n"),
        "- not_read: (custom path)/quota-toast.json",
      ],
      absent: ["ValueExpected", "colour", "https URL"],
    },
    {
      name: "custom provider definitions as their number, mode and model count",
      overrides: {
        quotaProviders: [
          remoteDefinition("team", {
            providerId: "gateway",
            label: "Team",
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
          }),
          {
            id: "seats",
            providerId: "gateway",
            label: "seats",
            mode: "local-estimate",
            windows: [{ id: "day", label: "Day", type: "utc-day", requestLimit: 50 }],
          },
          {
            id: "alibaba-coding-plan",
            providerId: "alibaba-coding-plan",
            label: "Alibaba",
            mode: "local-estimate",
            windows: [
              {
                id: "five-hour",
                label: "5h",
                type: "rolling",
                durationMinutes: 300,
                requestLimit: 1000,
              },
            ],
          },
        ],
      },
      lines: [
        "- custom_provider: custom 1 (remote-api, 1 model)",
        "- custom_provider: custom 2 (local-estimate, all models)",
        "- custom_provider: custom 3 (local-estimate, all models, tunes alibaba-coding-plan)",
      ],
      absent: ["team", "seats", "gateway", "TEAM_KEY", "model-a", "private"],
    },
    {
      name: "a switched-off custom provider as off, with where to switch it on",
      overrides: {
        quotaProviders: [
          {
            id: "my-gateway-quota",
            providerId: "my-gateway",
            label: "My Gateway",
            mode: "remote-api",
            url: "https://gateway.example/v1/quota",
            format: "quota-v1",
            enabled: false,
          },
        ],
      },
      lines: ["- custom_provider: custom 1 off (switch on in /quota_settings → Providers)"],
      absent: ["gateway.example", "my-gateway", "My Gateway"],
    },
    {
      name: "the v5 settings this server converted and wrote, by their v5 keys",
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
          dropped: [
            { key: "debug", reason: "/quota_status shows the diagnostics" },
            { key: "myOwnKey", reason: "not a v5 setting" },
          ],
          invalid: [{ key: "minIntervalMs", reason: "expected a number" }],
          notes: [
            "/cfg/a.json does not parse as a JSON object, so it was not converted",
            "/cfg/quota-toast.json was not converted: v5 used /cfg/quota-toast.jsonc when both exist",
            "experimental.quotaToast in /cfg/opencode.json was not converted: v5 ignored it while /cfg/quota-toast.jsonc exists",
            "/cfg/opencode.jsonc does not parse, so its experimental.quotaToast was not converted",
            "the project files are not read",
          ],
        }),
      },
      lines: [
        "- conversion: from (custom path)/opencode.json | (custom path)/quota-toast.json (2 converted, 2 dropped, 1 invalid); written to settings.jsonc",
        "- conversion_converted: enabledProviders, percentDisplayMode",
        "- conversion_dropped: debug (+1 unknown key)",
        "- conversion_invalid: minIntervalMs",
        "- conversion_notes: file_not_a_json_object, jsonc_used_over_json, quota_toast_block_ignored, config_not_parsed, (other)",
      ],
      absent: ["myOwnKey", "the TUI shows it", "project files", "/cfg/a.json"],
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
        "- settings_file: (custom path)/settings.jsonc (missing; the v5 settings are converted in memory)",
        "(0 converted, 0 dropped, 0 invalid); converted in memory",
      ],
      absent: ["conversion_converted", "conversion_notes"],
    },
    {
      name: "the v5 settings that could not be written",
      overrides: {
        conversion: conversion({ notWrittenReason: "settings.jsonc is not writable" }),
      },
      lines: ["(0 converted, 0 dropped, 0 invalid); not written"],
      absent: ["writable"],
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
        lastListError: { at: NOW + 1, detail: "Invalid credential value CANARY" },
        failures: [
          {
            integrationId: "openai",
            connectionId: "cred_1",
            label: "work.CANARY@example.com",
            category: "refresh_failed",
            detail: "HTTP 401 CANARY",
            at: NOW + 2,
          },
          {
            integrationId: "xai",
            connectionId: "xai",
            label: "",
            category: "active_failed",
            detail: "database is locked CANARY",
            at: NOW + 3,
          },
        ],
      },
      lines: [
        "- source: opencode-integration-api",
        "- list_error: bad_response at 2026-10-10T12:00:00.001Z",
        "- failures: openai: refresh_failed at 2026-10-10T12:00:00.002Z | xai: active_failed at 2026-10-10T12:00:00.003Z",
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

    expect(text).toMatch(/- pricing: source=bundled generated_at=\S+Z units=USD per 1M tokens\n/u);
    expect(text).toContain(`- selection: configured=${configured} active=bundled`);
    expect(text).toContain("- refresh: (no runtime refresh state yet)");
    expect(text).toMatch(/- providers: \d+\n/u);
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
      name: "models without a price: the first five the price list knows, the others counted",
      usage: {
        totals: { tokens: { processed: 80_000 }, unpricedShare: 0.125 },
        models: [
          { providerID: "anthropic", modelID: "claude", priced: true, unpricedTokens: 0 },
          ...[
            "gpt-4",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4-turbo",
            "gpt-3.5-turbo",
            "codex-mini-latest",
          ].map((modelID) => ({
            providerID: "openai",
            modelID,
            priced: false,
            unpricedTokens: 1_500,
          })),
          { providerID: "deepseek", modelID: "model-x", priced: false, unpricedTokens: 1_500 },
        ],
      },
      lines: [
        "- unpriced_30d: 12.5% of 80.0K tokens",
        "  - openai/gpt-4: 1.50K tokens",
        "  - openai/gpt-3.5-turbo: 1.50K tokens\n  - … (2 more unpriced models)",
      ],
      absent: ["anthropic/claude", "codex-mini-latest", "model-x"],
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
    const dir = join(root, ".config", "opencode", "opencode-quota");
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

  /** The forms of the JSON fields that hold a number: the version and two times. */
  const JSON_NUMBER_LINES: readonly RegExp[] = [
    String.raw`version: \d+\.\d+\.\d+[\w.-]*`,
    String.raw`generatedAt: ${DATE}`,
    String.raw`pricing\.snapshot\.generatedAt: ${TIME}`,
  ].map((form) => new RegExp(`^(?:${form})$`, "u"));

  it.each([
    { seed: 11 },
    { seed: 12 },
    { seed: 13 },
  ])("prints only its own vocabulary in the text and in `status --json` (seed $seed)", async ({
    seed,
  }) => {
    const { pick, word, garbage, hex } = garbageSource(seed);
    const configHome = join(root, word());
    const cacheHome = join(root, pick([word(), ".cache"]));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("XDG_CACHE_HOME", cacheHome);
    const settingsDir = join(configHome, "opencode", "opencode-quota");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.jsonc"),
      JSON.stringify({ providers: { enabled: ["synthetic", garbage(), garbage()] } }),
    );
    const pricingDir = join(cacheHome, "opencode", "opencode-quota");
    mkdirSync(pricingDir, { recursive: true });
    writeFileSync(
      join(pricingDir, "modelsdev-pricing.runtime.min.json"),
      JSON.stringify({
        _meta: { source: garbage(), generatedAt: pick([NOW, Number(DIGITS)]), units: garbage() },
        providers: { [garbage()]: { [garbage()]: { input: 1, output: 2 } } },
      }),
    );
    __resetPricingSnapshotForTests();
    registry.providers = [
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
            name: garbage(),
            group: garbage(),
            label: garbage(),
            percentRemaining: pick([84, Number(DIGITS)]),
            resetTimeIso: pick([RESET, ...DATE_LIKE]),
          },
        ],
        errors: [{ label: garbage(), message: garbage() }],
        statusDetails: [
          { key: "api_key_source", value: garbage() },
          { key: "api_key_checked_paths", value: garbage() },
          { key: garbage(), value: garbage() },
        ],
      }),
    ];

    const { data, text } = await statusData();

    const json = JSON.stringify(data.payload);
    const leaves = jsonLines(JSON.parse(json));
    const [, ...lines] = text.split("\n");
    const vocabulary = reportVocabulary();
    expect.soft(vocabularyProblems(lines, vocabulary, NUMBER_LINES)).toEqual([]);
    expect.soft(envProblems(text)).toEqual([]);
    const values = leaves.map((line) => line.slice(line.indexOf(": ") + 2));
    expect(vocabularyProblems(values, vocabulary, [/^\S+$/u])).toEqual([]);
    expect(
      leaves.filter(
        (line) =>
          /\d/u.test(line.slice(line.indexOf(": "))) &&
          !JSON_NUMBER_LINES.some((form) => form.test(line)),
      ),
    ).toEqual([]);
    for (const output of [text, json]) {
      expect(output.toLowerCase()).not.toContain("zq");
      expect(output.replaceAll(",", "")).not.toContain(DIGITS.slice(0, 8));
      expect(output).not.toContain(root);
      for (const token of hex) expect(output).not.toContain(token);
    }
    expect(data.payload.config.settingsPath).toBe("(custom path)/settings.jsonc");
    expect(data.payload.config.enabledProviders).toContain("synthetic");
  });

  it("checks every enabled provider through a store and shows what it returned, secrets hidden", async () => {
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
    // The access token and the error message.
    expect(syntheticSection).toContain("- 2 other details not shown");
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
    expect(data.payload?.config.settingsPath).toBe(
      "~/.config/opencode/opencode-quota/settings.jsonc",
    );
    expect(data.payload?.pricing.snapshot.source).toBe("bundled");
    expect(data.hasComparableProviderData).toBe(true);
    expect(JSON.stringify(data.payload)).not.toContain(SECRET);
    expect(JSON.stringify(data.payload)).not.toContain(root);
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

  /** Every provider that reads an API key or a key file: each shows where it looked. */
  const KEY_PROVIDERS = [
    "chutes",
    "deepseek",
    "kilo",
    "nanogpt",
    "ollama-cloud",
    "synthetic",
    "zai",
    "zhipu",
    "opencode-go",
    "kimi-code-plan-global",
    "kimi-code-plan-cn",
    "minimax-coding-plan",
    "minimax-china-coding-plan",
    "alibaba-coding-plan",
    "openrouter",
    "cursor",
  ];

  it("lists every provider that reads an API key", () => {
    expect(
      [
        ...Object.keys(API_KEY_VENDORS),
        ...Object.keys(API_KEY_LOGIN_VENDORS),
        "openrouter",
        "cursor",
      ].sort(),
    ).toEqual([...KEY_PROVIDERS].sort());
  });

  it("shows where every API-key provider looked for its key, without asking it for quota", async () => {
    for (const name of [...Object.values(API_KEY_VENDORS), ...Object.values(API_KEY_LOGIN_VENDORS)]
      .flatMap((vendor) => vendor.envVars)
      .concat("OPENROUTER_API_KEY")) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("ZAI_API_KEY", "zai-test-key");
    const providers = KEY_PROVIDERS.map((id) => fakeProvider(id, false));
    registry.providers = providers;
    mkdirSync(join(root, ".config", "opencode"), { recursive: true });
    writeFileSync(join(root, ".config", "opencode", "opencode.json"), "{}");

    const { text } = await statusData();

    for (const id of KEY_PROVIDERS) {
      const lines = section(text, id);
      expect(lines).toContain("- state: unavailable\n");
      if (id === "cursor") {
        expect(lines).toContain("- auth_state: missing");
        expect(lines).toContain("- auth_candidate_paths: ~/.local/share/opencode/opencode.db | ");
        expect(lines).toContain("~/.config/cursor/auth.json");
        continue;
      }
      expect(lines).toContain(
        id === "zai" ? "- api_key_configured: true" : "- api_key_configured: false",
      );
      expect(lines).toContain("- api_key_checked_paths: ");
      expect(lines).toContain("~/.config/opencode/opencode.json");
      expect(lines).not.toContain("other detail");
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
      "- settings_file: ~/.config/opencode/opencode-quota/settings.jsonc (missing; the v5 settings are converted in memory)",
    );
    expect(before).toContain("- enabledProviders: synthetic");
    expect(before).toMatch(
      /- conversion: from ~\/\.config\/opencode\/opencode-quota\/quota-toast\.json \(\d+ converted, \d+ dropped, \d+ invalid\); converted in memory/u,
    );

    writeFileSync(join(root, ".config", "opencode", "opencode-quota", "settings.jsonc"), "{ ");
    const after = section((await statusData()).text, "settings");

    expect(after).toContain("settings.jsonc (exists)");
    expect(after).toMatch(/- settings_issue: \$file: syntax error on line \d+\n/u);
    expect(after).not.toContain("- conversion:");
  });
});
