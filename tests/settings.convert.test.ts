import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertV5,
  type DisplayImport,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsPath,
} from "../src/settings/index.js";
import { VALID_QUOTA_PROVIDER_INPUTS, VALID_QUOTA_PROVIDERS } from "./fixtures/quota-providers.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-settings-convert-"));
  configDir = join(root, "config");
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeFile(path: string, content: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

/** A v5 sidecar, `<dir>/opencode-quota/<name>`. */
function writeV5(content: unknown, name = "quota-toast.jsonc", dir = configDir): string {
  return writeFile(join(dir, "opencode-quota", name), content);
}

/** OpenCode's own config with a v5 `experimental.quotaToast` block. */
function writeHost(quotaToast: unknown, name = "opencode.json", dir = configDir): string {
  return writeFile(join(dir, name), { experimental: { quotaToast } });
}

function valueAt(settings: object, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], settings);
}

const GO_HIDDEN = { hidden: ["opencode-go.five_hour", "opencode-go.monthly"] };

/** One row per v5 key (docs/v6-plan §5 table and §8 "where each v5 key went"). */
const ROWS: Array<{
  name: string;
  v5: Record<string, unknown>;
  server?: Record<string, unknown>;
  display?: DisplayImport;
  dropped?: string[];
}> = [
  { name: "enabled", v5: { enabled: false }, dropped: ["enabled"] },
  {
    name: "enableToast",
    v5: { enableToast: false },
    display: { surfaces: { toast: { enabled: false } } },
  },
  { name: "showOnIdle", v5: { showOnIdle: true }, display: { toast: { afterReply: "always" } } },
  {
    name: "showOnQuestion",
    v5: { showOnQuestion: true },
    display: { toast: { afterQuestion: true } },
  },
  {
    name: "showOnCompact",
    v5: { showOnCompact: false },
    display: { toast: { afterCompaction: false } },
  },
  {
    name: "showOnBothFail",
    v5: { showOnBothFail: false },
    display: { toast: { whenAllFail: false } },
  },
  { name: "toastDurationMs", v5: { toastDurationMs: 4_600 }, display: { toast: { seconds: 5 } } },
  {
    name: "resetNotifications, weekly",
    v5: { resetNotifications: { enabled: true } },
    display: { toast: { resetNotice: "weekly" } },
  },
  {
    name: "resetNotifications, other windows",
    v5: { resetNotifications: { enabled: true, windows: ["daily", "weekly"] } },
    display: { toast: { resetNotice: "all" } },
  },
  {
    name: "resetNotifications, off",
    v5: { resetNotifications: { enabled: false, windows: ["monthly"] } },
    display: { toast: { resetNotice: "off" } },
  },
  {
    name: "tuiCommandDisplay",
    v5: { tuiCommandDisplay: "inline" },
    dropped: ["tuiCommandDisplay"],
  },
  {
    name: "formatStyle, toastStyle and the per-surface formatStyle",
    v5: {
      formatStyle: "allWindows",
      toastStyle: "classic",
      tuiSidebarPanel: { formatStyle: "grouped" },
      tuiCompactStatus: { formatStyle: "singleWindow" },
    },
    dropped: [
      "formatStyle",
      "toastStyle",
      "tuiCompactStatus.formatStyle",
      "tuiSidebarPanel.formatStyle",
    ],
  },
  {
    name: "percentDisplayMode",
    v5: { percentDisplayMode: "used" },
    server: { "words.percent": "used" },
  },
  {
    name: "percentLabelStyle",
    v5: { percentLabelStyle: "bare" },
    server: { "words.percent": "bare" },
  },
  {
    name: "accountingDetail",
    v5: { accountingDetail: "detailed" },
    server: { "words.detail": "detailed" },
  },
  {
    name: "opencodeZenDisplay",
    v5: { opencodeZenDisplay: "detailed" },
    server: { "words.detail": "detailed" },
  },
  {
    name: "opencodeZenDisplay next to accountingDetail",
    v5: { opencodeZenDisplay: "detailed", accountingDetail: "summary" },
    server: { "words.detail": "summary" },
    dropped: ["opencodeZenDisplay"],
  },
  { name: "quotaProjection", v5: { quotaProjection: "runway" }, server: { "words.runsOut": true } },
  {
    name: "resetTimeDecimals",
    v5: { resetTimeDecimals: 2, resetTimeSpaced: false },
    server: { "words.reset": "decimal", "words.resetDecimals": 2 },
  },
  { name: "resetTimeSpaced", v5: { resetTimeSpaced: false }, server: { "words.reset": "compact" } },
  {
    name: "minIntervalMs, requestTimeoutMs, waitForQuotaReset",
    v5: { minIntervalMs: 60_000, requestTimeoutMs: 9_000, waitForQuotaReset: false },
    server: {
      "checking.minIntervalMs": 60_000,
      "checking.requestTimeoutMs": 9_000,
      "checking.waitForQuotaReset": false,
    },
  },
  { name: "debug", v5: { debug: true }, dropped: ["debug"] },
  {
    name: "enabledProviders",
    v5: { enabledProviders: ["nano-gpt", "quota-providers", "copilot"] },
    server: { "providers.enabled": ["nanogpt", "custom", "copilot"] },
  },
  {
    name: "quotaProviders",
    v5: { quotaProviders: VALID_QUOTA_PROVIDER_INPUTS },
    server: { "providers.custom": VALID_QUOTA_PROVIDERS },
  },
  {
    name: "anthropicBinaryPath",
    v5: { anthropicBinaryPath: " /opt/claude " },
    server: { "providers.anthropic.binaryPath": "/opt/claude" },
  },
  {
    name: "cursorPlan, cursorIncludedApiUsd, cursorBillingCycleStartDay",
    v5: { cursorPlan: "pro", cursorIncludedApiUsd: 25, cursorBillingCycleStartDay: 3 },
    server: {
      "providers.cursor.plan": "pro",
      "providers.cursor.includedApiUsd": 25,
      "providers.cursor.billingCycleStartDay": 3,
    },
  },
  {
    name: "opencodeGoWindows",
    v5: { opencodeGoWindows: ["weekly"] },
    display: {
      surfaces: {
        sidebar: GO_HIDDEN,
        collapsed: GO_HIDDEN,
        statusLine: GO_HIDDEN,
        toast: GO_HIDDEN,
      },
    },
  },
  {
    name: "opencodeMonthlyLimit",
    v5: { opencodeMonthlyLimit: 20 },
    server: { "providers.opencode.monthlyLimitUsd": 20 },
  },
  {
    name: "pricingSnapshot",
    v5: { pricingSnapshot: { source: "bundled", autoRefresh: 3 } },
    server: { "pricing.source": "bundled", "pricing.autoRefreshDays": 3 },
  },
  {
    name: "onlyCurrentModel",
    v5: { onlyCurrentModel: true },
    server: { "words.onlyCurrentModel": true },
  },
  {
    name: "showSessionTokens",
    v5: { showSessionTokens: false },
    display: { sidebar: { sessionTokens: false }, toast: { sessionTokens: false } },
  },
  {
    name: "sessionTokenScope",
    v5: { sessionTokenScope: "tree" },
    server: { "words.sessionTokens": "tree" },
  },
  {
    name: "tuiSidebarPanel.enabled",
    v5: { tuiSidebarPanel: { enabled: false } },
    display: { surfaces: { sidebar: { enabled: false } } },
  },
  {
    name: "tuiSidebarPanel.opencodeGoPreferredWindow",
    v5: { tuiSidebarPanel: { opencodeGoPreferredWindow: "rolling" } },
    display: { window: { "opencode-go": "five_hour" } },
  },
  {
    name: "tuiCompactStatus",
    v5: { tuiCompactStatus: { enabled: true, homeBottom: false } },
    display: { surfaces: { statusLine: { enabled: true } }, statusLine: { home: false } },
  },
  {
    name: "tuiPromptBar",
    v5: { tuiPromptBar: { enabled: true } },
    display: {
      surfaces: { statusLine: { enabled: true } },
      statusLine: { home: false, detail: "one" },
    },
  },
  {
    name: "tuiCompactStatus.maxWidth",
    v5: { tuiCompactStatus: { maxWidth: 80 } },
    dropped: ["tuiCompactStatus.maxWidth"],
  },
  {
    name: "maintainerAnnouncements",
    v5: { maintainerAnnouncements: { enabled: false, home: false, homeFrequency: "always" } },
    server: {
      "announcements.enabled": false,
      "announcements.home": false,
      "announcements.homeFrequency": "always",
    },
  },
  {
    name: "layout",
    v5: { layout: { maxWidth: 60, narrowAt: 40, tinyAt: 30 } },
    dropped: ["layout.maxWidth", "layout.narrowAt", "layout.tinyAt"],
  },
  {
    name: "export",
    v5: { export: { enabled: true, path: "~/quota.json" } },
    server: { "export.enabled": true, "export.path": "~/quota.json" },
  },
  {
    name: "telemetry",
    v5: { telemetry: { enabled: true } },
    server: { "telemetry.enabled": true },
  },
  {
    name: "removed and unknown keys",
    v5: {
      alibabaCodingPlanTier: "pro",
      customSources: [],
      someTypo: 1,
      tuiCompactStatus: { suppressWhenNativeProviderQuota: true },
    },
    dropped: ["alibabaCodingPlanTier", "customSources", "someTypo"],
  },
];

describe("convertV5, key by key", () => {
  it.each(ROWS)("$name", async (row) => {
    writeV5(row.v5);

    const conversion = await convertV5();
    const loaded = await loadSettings();

    expect(conversion?.written).toBe(true);
    expect(conversion?.invalid).toEqual([]);
    expect(conversion?.displayImport).toEqual(row.display ?? {});
    expect(conversion?.dropped.map((item) => item.key).sort()).toEqual(
      [...(row.dropped ?? [])].sort(),
    );
    expect(loaded.exists).toBe(true);
    expect(loaded.issues).toEqual([]);
    for (const [key, value] of Object.entries(row.server ?? {})) {
      expect(valueAt(loaded.settings, key), key).toEqual(value);
    }
    // Only what the user set is written, so every other key keeps its v6 default.
    const userKeys = loaded.fromFile.filter((key) => key !== "version").sort();
    expect(userKeys).toEqual(Object.keys(row.server ?? {}).sort());
  });

  it("lists values v5 rejected too and converts the rest", async () => {
    writeV5({ percentDisplayMode: "most", enabledProviders: ["copilot", "nope"] });

    const conversion = await convertV5();

    expect(conversion?.invalid.map((item) => item.key)).toEqual([
      "percentDisplayMode",
      "enabledProviders",
    ]);
    expect(conversion?.settings.words.percent).toBe("left");
    expect(conversion?.settings.providers.enabled).toEqual(["copilot"]);
  });
});

describe("convertV5, which v5 files", () => {
  it("writes settings.jsonc once, 0600, says where it came from, and leaves the old file", async () => {
    const old = writeV5({ percentDisplayMode: "used" });

    const conversion = await convertV5();

    expect(conversion?.sources).toEqual([old]);
    const text = readFileSync(settingsPath(), "utf8");
    expect(text).toMatch(
      /^\/\/ OpenCode Quota server settings, converted on \d{4}-\d{2}-\d{2} from:/,
    );
    expect(text).toContain(old);
    expect(readFileSync(old, "utf8")).toContain('"percentDisplayMode": "used"');
    if (process.platform !== "win32") {
      expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    }
    expect(await convertV5()).toBeUndefined();
  });

  it("converts the sidecar and names the experimental.quotaToast block v5 ignored", async () => {
    const sidecar = writeV5({ percentDisplayMode: "used" });
    const host = writeHost({ accountingDetail: "detailed" }, "opencode.jsonc");

    const conversion = await convertV5();

    expect(conversion?.sources).toEqual([sidecar]);
    expect(conversion?.settings.words).toMatchObject({ percent: "used", detail: "summary" });
    expect(conversion?.notes).toEqual([
      `experimental.quotaToast in ${host} was not converted: v5 ignored it while ${sidecar} exists`,
    ]);
  });

  it("without a sidecar reads opencode.json then opencode.jsonc; a bad later value never wins", async () => {
    writeHost({ percentDisplayMode: "used", minIntervalMs: 60_000 }, "opencode.json");
    writeHost({ percentDisplayMode: "sideways", minIntervalMs: 120_000 }, "opencode.jsonc");

    const conversion = await convertV5();

    expect(conversion?.written).toBe(true);
    expect(conversion?.sources).toHaveLength(2);
    expect(conversion?.settings.words.percent).toBe("used");
    expect(conversion?.settings.checking.minIntervalMs).toBe(120_000);
    expect(conversion?.invalid.map((item) => item.key)).toEqual(["percentDisplayMode"]);
  });

  it("converts quota-toast.jsonc when both sidecars exist and names the other", async () => {
    const jsonc = writeV5('// comment\n{ "accountingDetail": "detailed", }', "quota-toast.jsonc");
    const json = writeV5({ accountingDetail: "summary" }, "quota-toast.json");

    const conversion = await convertV5();

    expect(conversion?.settings.words.detail).toBe("detailed");
    expect(conversion?.notes).toEqual([
      `${json} was not converted: v5 used ${jsonc} when both exist`,
    ]);
  });

  it("converts a malformed old setup in memory only, from what parses", async () => {
    writeV5("{ broken");
    writeHost({ percentDisplayMode: "used" });

    const conversion = await convertV5();
    const loaded = await loadSettings();

    expect(conversion?.written).toBe(false);
    expect(conversion?.notWrittenReason).toMatch(/does not parse/);
    expect(existsSync(settingsPath())).toBe(false);
    expect(loaded.exists).toBe(false);
    expect(loaded.settings.words.percent).toBe("used");
    expect(loaded.conversion?.sources).toHaveLength(1);
  });

  it("keeps the converted values on the first save while they are only in memory", async () => {
    writeV5("{ broken");
    writeHost({ percentDisplayMode: "used" });

    const result = await saveSettings({ words: { reset: "short" } });

    expect(result.diff).toEqual([{ key: "words.reset", before: "exact", after: "short" }]);
    const loaded = await loadSettings();
    expect(loaded.settings.words).toMatchObject({ percent: "used", reset: "short" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "in a read-only folder writes nothing, says why, and still uses the values",
    async () => {
      writeV5({ percentDisplayMode: "used" });
      const folder = join(configDir, "opencode-quota");
      chmodSync(folder, 0o500);
      try {
        const conversion = await convertV5();
        const loaded = await loadSettings();

        expect(conversion?.written).toBe(false);
        expect(conversion?.notWrittenReason).toMatch(/^could not write /);
        expect(loaded.settings.words.percent).toBe("used");
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );

  it("once settings.jsonc exists, reads no v5 file and names the old sidecar", async () => {
    const old = writeV5({ percentDisplayMode: "used" });
    writeFile(settingsPath(), '{ "version": 6 }');

    expect(await convertV5()).toBeUndefined();
    const loaded = await loadSettings();

    expect(loaded.settings).toEqual(defaultSettings());
    expect(loaded.notRead).toEqual([old]);
  });

  it("never reads project-scope v5 files and names them", async () => {
    const project = join(root, "project");
    const sidecar = writeV5({ percentDisplayMode: "used" }, "quota-toast.json", project);
    const host = writeHost({ accountingDetail: "detailed" }, "opencode.jsonc", project);

    expect(await convertV5()).toBeUndefined();
    const loaded = await loadSettings({ projectDir: project });

    expect(loaded.settings).toEqual(defaultSettings());
    expect(loaded.notRead).toEqual([sidecar, `${host} (experimental.quotaToast)`]);
  });
});
