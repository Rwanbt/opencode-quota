/**
 * The one-time move from v5 settings. A frozen copy of how v5 read its GLOBAL settings (which
 * files, the authoritative-sidecar rule, each key's check), and where each v5 key went: server
 * keys into settings.jsonc, display keys into `displayImport` for the TUI's plugin storage.
 * This file only reads; `convertV5` in file.ts writes the result.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { canonicalProviderId, SETTINGS_SCHEMA, type Settings, settingsFrom } from "./schema.js";

/** A v5 key that moved: `to` is a dotted key of settings.jsonc or of the TUI display settings. */
export type ConvertedKey = { key: string; to: string; where: "server" | "display"; note?: string };
export type SkippedKey = { key: string; reason: string };

type DisplaySurface = "sidebar" | "collapsed" | "statusLine" | "toast";

/**
 * The display settings a v5 file chose, in the shape the TUI stores them (only what the user
 * set; the TUI fills in its defaults). The TUI applies it once, when its storage is empty.
 */
export type DisplayImport = {
  surfaces?: Partial<Record<DisplaySurface, { enabled?: boolean; hidden?: string[] }>>;
  /** The collapsed sidebar's window per provider id. */
  window?: Record<string, string>;
  statusLine?: { detail?: "one"; home?: boolean };
  sidebar?: { sessionTokens?: boolean };
  toast?: {
    afterReply?: "off" | "always";
    afterQuestion?: boolean;
    afterCompaction?: boolean;
    whenAllFail?: boolean;
    resetNotice?: "off" | "weekly" | "all";
    seconds?: number;
    sessionTokens?: boolean;
  };
};

export type V5Conversion = {
  /** The v5 files the values came from, in the order v5 applied them. */
  sources: string[];
  /** An old file does not parse: never write settings.jsonc from partial data. */
  malformed: boolean;
  /** True when this call wrote settings.jsonc. */
  written: boolean;
  /** Why settings.jsonc was not written, when a write was tried. */
  notWrittenReason?: string;
  /** The converted server values by dotted key, in file order. */
  values: Record<string, unknown>;
  settings: Settings;
  /** The server keys the conversion set; every other key has its default. */
  fromFile: string[];
  displayImport: DisplayImport;
  converted: ConvertedKey[];
  dropped: SkippedKey[];
  invalid: SkippedKey[];
  notes: string[];
};

const SIDECAR_NAMES = ["quota-toast.jsonc", "quota-toast.json"] as const;
/** v5 applied opencode.json first, so opencode.jsonc won per key. */
const HOST_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

const V5_GROUPS = new Set([
  "resetNotifications",
  "pricingSnapshot",
  "tuiSidebarPanel",
  "tuiCompactStatus",
  "tuiPromptBar",
  "maintainerAnnouncements",
  "layout",
  "export",
  "telemetry",
]);

const NO_FORMAT_STYLE =
  "no v6 equivalent: the sidebar shows every row and the collapsed sidebar one per provider; hide rows in the /quota window";

/** v5 keys v6 does not keep, and why. */
const DROPPED: ReadonlyMap<string, string> = new Map(
  Object.entries({
    enabled: "v6 has no switch of its own; turn the plugin off in OpenCode's plugin list",
    tuiCommandDisplay: "/quota always opens the quota window in v6",
    formatStyle: NO_FORMAT_STYLE,
    toastStyle: NO_FORMAT_STYLE,
    "tuiSidebarPanel.formatStyle": NO_FORMAT_STYLE,
    "tuiCompactStatus.formatStyle": NO_FORMAT_STYLE,
    debug: "/quota_status shows the diagnostics",
    "layout.maxWidth": "OpenCode sizes toasts",
    "layout.narrowAt": "OpenCode sizes toasts",
    "layout.tinyAt": "OpenCode sizes toasts",
    "tuiCompactStatus.maxWidth": "the status line uses the room the footer leaves free",
    alibabaCodingPlanTier: 'removed in v4; tune Alibaba through "providers.custom"',
    customSources: 'removed in v4; use "providers.custom"',
  }),
);
/** 4.x leftovers v5 already ignored without a word. */
const SILENT = new Set(["tuiCompactStatus.suppressWhenNativeProviderQuota"]);

const isBoolean = (value: unknown) => typeof value === "boolean";
const isPositive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const oneOf =
  (...values: unknown[]) =>
  (value: unknown) =>
    values.includes(value);
const isWholeFrom = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isListOf = (check: (value: unknown) => boolean) => (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every(check);
const isAnything = () => true;

/** v5's check for every key it kept (5.x src/lib/config.ts); `enabledProviders` is read apart. */
const V5_CHECKS: ReadonlyMap<string, (value: unknown) => boolean> = new Map(
  Object.entries({
    enableToast: isBoolean,
    "resetNotifications.enabled": isBoolean,
    "resetNotifications.windows": isListOf(
      oneOf("fiveHour", "hourly", "daily", "weekly", "monthly", "yearly"),
    ),
    percentDisplayMode: oneOf("remaining", "used"),
    quotaProjection: oneOf("runway"),
    percentLabelStyle: oneOf("full", "bare"),
    accountingDetail: oneOf("summary", "detailed"),
    resetTimeDecimals: isWholeFrom(0, 4),
    resetTimeSpaced: isBoolean,
    minIntervalMs: isPositive,
    requestTimeoutMs: isPositive,
    // Copied as it is; the v6 check reports a bad definition (v5 dropped the whole list).
    quotaProviders: isAnything,
    anthropicBinaryPath: (value) => typeof value === "string" && value.trim() !== "",
    cursorPlan: oneOf("none", "pro", "pro-plus", "ultra"),
    cursorIncludedApiUsd: isPositive,
    cursorBillingCycleStartDay: isWholeFrom(1, 28),
    opencodeGoWindows: isListOf(oneOf("rolling", "weekly", "monthly")),
    opencodeMonthlyLimit: isPositive,
    // Removed in v5 but still translated (the rule lived in `update`, which v6 removed).
    opencodeZenDisplay: isAnything,
    "pricingSnapshot.source": oneOf("auto", "bundled", "runtime"),
    "pricingSnapshot.autoRefresh": (value) => Number.isInteger(value) && (value as number) > 0,
    showOnIdle: isBoolean,
    showOnQuestion: isBoolean,
    showOnCompact: isBoolean,
    showOnBothFail: isBoolean,
    toastDurationMs: isPositive,
    onlyCurrentModel: isBoolean,
    waitForQuotaReset: isBoolean,
    showSessionTokens: isBoolean,
    sessionTokenScope: oneOf("current", "tree"),
    "tuiSidebarPanel.enabled": isBoolean,
    "tuiSidebarPanel.opencodeGoPreferredWindow": oneOf("rolling", "weekly", "monthly"),
    "tuiCompactStatus.enabled": isBoolean,
    "tuiCompactStatus.homeBottom": isBoolean,
    "tuiCompactStatus.sessionPrompt": isBoolean,
    "tuiPromptBar.enabled": isBoolean,
    "maintainerAnnouncements.enabled": isBoolean,
    "maintainerAnnouncements.home": isBoolean,
    "maintainerAnnouncements.homeFrequency": oneOf("daily", "always"),
    "export.enabled": isBoolean,
    "export.path": (value) => typeof value === "string",
    "telemetry.enabled": isBoolean,
  }),
);

/** v5 keys that moved to settings.jsonc unchanged. */
const SERVER_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["enabledProviders", "providers.enabled"],
  ["quotaProviders", "providers.custom"],
  ["cursorPlan", "providers.cursor.plan"],
  ["cursorIncludedApiUsd", "providers.cursor.includedApiUsd"],
  ["cursorBillingCycleStartDay", "providers.cursor.billingCycleStartDay"],
  ["opencodeMonthlyLimit", "providers.opencode.monthlyLimitUsd"],
  ["minIntervalMs", "checking.minIntervalMs"],
  ["requestTimeoutMs", "checking.requestTimeoutMs"],
  ["waitForQuotaReset", "checking.waitForQuotaReset"],
  ["accountingDetail", "words.detail"],
  ["onlyCurrentModel", "words.onlyCurrentModel"],
  ["sessionTokenScope", "words.sessionTokens"],
  ["pricingSnapshot.source", "pricing.source"],
  ["pricingSnapshot.autoRefresh", "pricing.autoRefreshDays"],
  ["maintainerAnnouncements.enabled", "announcements.enabled"],
  ["maintainerAnnouncements.home", "announcements.home"],
  ["maintainerAnnouncements.homeFrequency", "announcements.homeFrequency"],
  ["export.enabled", "export.enabled"],
  ["export.path", "export.path"],
  ["telemetry.enabled", "telemetry.enabled"],
];

/** v5's OpenCode Go window names → v6 row ids and collapsed-sidebar windows. */
const GO_WINDOWS = [
  { v5: "rolling", row: "opencode-go.five_hour", window: "five_hour" },
  { v5: "weekly", row: "opencode-go.weekly", window: "week" },
  { v5: "monthly", row: "opencode-go.monthly", window: "month" },
] as const;

const SURFACES: readonly DisplaySurface[] = ["sidebar", "collapsed", "statusLine", "toast"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonFile = { state: "missing" } | { state: "invalid" } | { state: "parsed"; value: unknown };

/** v5 read `.json` and `.jsonc` alike: comments and trailing commas allowed. */
async function readJsonFile(path: string): Promise<JsonFile> {
  if (!existsSync(path)) return { state: "missing" };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { state: "invalid" };
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  return errors.length > 0 ? { state: "invalid" } : { state: "parsed", value };
}

function quotaToastBlock(value: unknown): Record<string, unknown> | undefined {
  const block = isRecord(value) && isRecord(value.experimental) && value.experimental.quotaToast;
  return isRecord(block) ? block : undefined;
}

type V5Source = { path: string; raw: Record<string, unknown> };
type V5Files = { sources: V5Source[]; notes: string[]; malformed: boolean; sidecarSeen: boolean };

/**
 * v5's global files: the first sidecar that parses is authoritative (the other sidecar and
 * `experimental.quotaToast` are ignored); without one, `experimental.quotaToast` from
 * opencode.json, then opencode.jsonc.
 */
async function readV5GlobalFiles(configDir: string): Promise<V5Files> {
  const sidecars = SIDECAR_NAMES.map((name) => join(configDir, "opencode-quota", name));
  const hostFiles = HOST_FILE_NAMES.map((name) => join(configDir, name));
  const notes: string[] = [];
  let malformed = false;
  let sidecarSeen = false;

  for (const path of sidecars) {
    const file = await readJsonFile(path);
    if (file.state === "missing") continue;
    sidecarSeen = true;
    if (file.state === "invalid" || !isRecord(file.value)) {
      malformed = true;
      notes.push(`${path} does not parse as a JSON object, so it was not converted`);
      continue;
    }
    if (path === sidecars[0] && existsSync(sidecars[1])) {
      notes.push(`${sidecars[1]} was not converted: v5 used ${path} when both exist`);
    }
    for (const hostPath of hostFiles) {
      const host = await readJsonFile(hostPath);
      if (host.state === "parsed" && quotaToastBlock(host.value)) {
        notes.push(
          `experimental.quotaToast in ${hostPath} was not converted: v5 ignored it while ${path} exists`,
        );
      }
    }
    return { sources: [{ path, raw: file.value }], notes, malformed, sidecarSeen };
  }

  const sources: V5Source[] = [];
  for (const path of hostFiles) {
    const file = await readJsonFile(path);
    if (file.state === "missing") continue;
    if (file.state === "invalid") {
      malformed = true;
      notes.push(`${path} does not parse, so its experimental.quotaToast was not converted`);
      continue;
    }
    const block = quotaToastBlock(file.value);
    if (block) sources.push({ path: `${path} (experimental.quotaToast)`, raw: block });
  }
  return { sources, notes, malformed, sidecarSeen };
}

/** v5 `enabledProviders`: aliases made canonical; a value without one known id meant "none". */
function readV5EnabledProviders(value: unknown): {
  value: "auto" | string[];
  unknown: string[];
} {
  if (value === "auto") return { value, unknown: [] };
  if (!Array.isArray(value)) return { value: [], unknown: [JSON.stringify(value)] };
  const known: string[] = [];
  const unknown: string[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? canonicalProviderId(item) : undefined;
    if (id) known.push(id);
    else unknown.push(typeof item === "string" ? item : JSON.stringify(item));
  }
  return { value: [...new Set(known)], unknown };
}

/** A v5 object as dotted keys; v5's nested groups are opened one level deep. */
function flattenV5(raw: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(raw).flatMap(
    ([key, value]): Array<[string, unknown]> =>
      V5_GROUPS.has(key) && isRecord(value)
        ? Object.entries(value).map(([name, child]): [string, unknown] => [`${key}.${name}`, child])
        : [[key, value]],
  );
}

/** The valid v5 values in the order v5 applied them (a later valid value wins, an invalid one never does). */
function readV5Values(sources: readonly V5Source[]): {
  values: Map<string, unknown>;
  dropped: SkippedKey[];
  invalid: SkippedKey[];
} {
  const values = new Map<string, unknown>();
  const dropped: SkippedKey[] = [];
  const invalid: SkippedKey[] = [];
  for (const source of sources) {
    for (const [key, value] of flattenV5(source.raw)) {
      if (SILENT.has(key)) continue;
      const droppedReason = DROPPED.get(key);
      const check = V5_CHECKS.get(key);
      if (droppedReason) {
        dropped.push({ key, reason: droppedReason });
      } else if (key === "enabledProviders") {
        const read = readV5EnabledProviders(value);
        if (read.unknown.length > 0) {
          invalid.push({ key, reason: `unknown provider id(s): ${read.unknown.join(", ")}` });
        }
        // v5: a list of only unknown ids showed nothing, unless an earlier file set a list.
        const onlyUnknown = read.value.length === 0 && read.unknown.length > 0;
        if (!(onlyUnknown && values.has(key))) values.set(key, read.value);
      } else if (V5_GROUPS.has(key)) {
        invalid.push({ key, reason: "expected an object" });
      } else if (!check) {
        dropped.push({ key, reason: "not a v5 setting" });
      } else if (check(value)) {
        values.set(key, value);
      } else {
        invalid.push({ key, reason: `${JSON.stringify(value)} was not valid in v5 either` });
      }
    }
  }
  return { values, dropped, invalid };
}

/** Where every valid v5 value goes. */
function mapV5Values(values: ReadonlyMap<string, unknown>): {
  server: Record<string, unknown>;
  display: DisplayImport;
  converted: ConvertedKey[];
  dropped: SkippedKey[];
} {
  const server: Record<string, unknown> = {};
  const converted: ConvertedKey[] = [];
  const dropped: SkippedKey[] = [];
  const surfaces: NonNullable<DisplayImport["surfaces"]> = {};
  const toast: NonNullable<DisplayImport["toast"]> = {};
  const sidebar: NonNullable<DisplayImport["sidebar"]> = {};
  const window: Record<string, string> = {};
  let statusLine: DisplayImport["statusLine"];

  const has = (key: string) => values.has(key);
  const chosen = <T>(key: string, fallback: T): T =>
    values.has(key) ? (values.get(key) as T) : fallback;
  const toServer = (key: string, to: string, value: unknown, note?: string) => {
    server[to] = value;
    converted.push({ key, to, where: "server", ...(note ? { note } : {}) });
  };
  const toDisplay = (key: string, to: string, note?: string) => {
    converted.push({ key, to, where: "display", ...(note ? { note } : {}) });
  };
  const surface = (name: DisplaySurface) => {
    surfaces[name] ??= {};
    return surfaces[name];
  };

  for (const [from, to] of SERVER_RENAMES) {
    if (has(from)) toServer(from, to, values.get(from));
  }
  if (has("anthropicBinaryPath")) {
    const path = String(values.get("anthropicBinaryPath")).trim();
    toServer("anthropicBinaryPath", "providers.anthropic.binaryPath", path);
  }

  const percentKeys = ["percentDisplayMode", "percentLabelStyle"].filter(has);
  if (percentKeys.length > 0) {
    const used = chosen<string>("percentDisplayMode", "remaining") === "used";
    const bare = chosen<string>("percentLabelStyle", "full") === "bare";
    const note = used && bare ? 'v6 has no bare "used" percent; it shows "42% used"' : undefined;
    for (const key of percentKeys) {
      toServer(key, "words.percent", used ? "used" : bare ? "bare" : "left", note);
    }
  }

  const resetKeys = ["resetTimeDecimals", "resetTimeSpaced"].filter(has);
  if (resetKeys.length > 0) {
    const decimals = values.get("resetTimeDecimals");
    const spaced = chosen("resetTimeSpaced", true);
    const reset = decimals !== undefined ? "decimal" : spaced ? "exact" : "compact";
    for (const key of resetKeys) toServer(key, "words.reset", reset);
    if (decimals !== undefined) server["words.resetDecimals"] = decimals;
  }

  if (has("quotaProjection")) toServer("quotaProjection", "words.runsOut", true);

  if (has("opencodeZenDisplay")) {
    const zen = values.get("opencodeZenDisplay");
    if (has("accountingDetail")) {
      dropped.push({ key: "opencodeZenDisplay", reason: "accountingDetail is set and wins" });
    } else if (zen === "default" || zen === "detailed") {
      toServer("opencodeZenDisplay", "words.detail", zen === "default" ? "summary" : "detailed");
    } else {
      dropped.push({ key: "opencodeZenDisplay", reason: 'expected "default" or "detailed"' });
    }
  }

  if (has("enableToast")) {
    surface("toast").enabled = chosen("enableToast", true);
    toDisplay("enableToast", "surfaces.toast.enabled");
  }
  if (has("showOnIdle")) {
    toast.afterReply = chosen("showOnIdle", false) ? "always" : "off";
    toDisplay("showOnIdle", "toast.afterReply");
  }
  if (has("showOnQuestion")) {
    toast.afterQuestion = chosen("showOnQuestion", false);
    toDisplay("showOnQuestion", "toast.afterQuestion");
  }
  if (has("showOnCompact")) {
    toast.afterCompaction = chosen("showOnCompact", true);
    toDisplay("showOnCompact", "toast.afterCompaction");
  }
  if (has("showOnBothFail")) {
    toast.whenAllFail = chosen("showOnBothFail", true);
    toDisplay("showOnBothFail", "toast.whenAllFail");
  }
  if (has("toastDurationMs")) {
    toast.seconds = Math.max(1, Math.round(chosen("toastDurationMs", 9000) / 1000));
    toDisplay("toastDurationMs", "toast.seconds");
  }

  const resetNoticeKeys = ["resetNotifications.enabled", "resetNotifications.windows"].filter(has);
  if (resetNoticeKeys.length > 0) {
    const enabled = chosen("resetNotifications.enabled", false);
    const windows = chosen<string[]>("resetNotifications.windows", ["weekly"]);
    const onlyWeekly = windows.length === 1 && windows[0] === "weekly";
    toast.resetNotice = !enabled ? "off" : onlyWeekly ? "weekly" : "all";
    const note =
      enabled && !onlyWeekly
        ? `v6 notifies for weekly limits or for every limit; ${windows.join(", ")} became every limit`
        : undefined;
    for (const key of resetNoticeKeys) toDisplay(key, "toast.resetNotice", note);
  }

  if (has("showSessionTokens")) {
    sidebar.sessionTokens = chosen("showSessionTokens", true);
    toast.sessionTokens = chosen("showSessionTokens", true);
    toDisplay("showSessionTokens", "sidebar.sessionTokens, toast.sessionTokens");
  }

  if (has("tuiSidebarPanel.enabled")) {
    surface("sidebar").enabled = chosen("tuiSidebarPanel.enabled", true);
    toDisplay("tuiSidebarPanel.enabled", "surfaces.sidebar.enabled");
  }
  if (has("tuiSidebarPanel.opencodeGoPreferredWindow")) {
    const v5Window = values.get("tuiSidebarPanel.opencodeGoPreferredWindow");
    const go = GO_WINDOWS.find((entry) => entry.v5 === v5Window);
    if (go) window["opencode-go"] = go.window;
    toDisplay(
      "tuiSidebarPanel.opencodeGoPreferredWindow",
      'window["opencode-go"]',
      "v5 ignored this setting; the collapsed sidebar uses it now",
    );
  }

  const statusKeys = [
    "tuiCompactStatus.enabled",
    "tuiCompactStatus.homeBottom",
    "tuiCompactStatus.sessionPrompt",
    "tuiPromptBar.enabled",
  ].filter(has);
  if (statusKeys.length > 0) {
    // What v5 showed, with v5's defaults for the keys the user did not set.
    const compact = chosen("tuiCompactStatus.enabled", false);
    const promptBar = chosen("tuiPromptBar.enabled", false);
    surface("statusLine").enabled =
      promptBar || (compact && chosen("tuiCompactStatus.sessionPrompt", true));
    statusLine = {
      home: compact && chosen("tuiCompactStatus.homeBottom", true),
      ...(promptBar ? { detail: "one" as const } : {}),
    };
    for (const key of statusKeys) toDisplay(key, "surfaces.statusLine.enabled, statusLine");
  }

  if (has("opencodeGoWindows")) {
    const kept = chosen<string[]>("opencodeGoWindows", []);
    const hidden = GO_WINDOWS.filter((go) => !kept.includes(go.v5)).map((go) => go.row);
    for (const name of SURFACES) surface(name).hidden = hidden;
    toDisplay(
      "opencodeGoWindows",
      "surfaces.*.hidden",
      "the other OpenCode Go windows are hidden now, not removed: export and /quota still list them",
    );
  }

  const display: DisplayImport = {
    ...(Object.keys(surfaces).length > 0 ? { surfaces } : {}),
    ...(Object.keys(window).length > 0 ? { window } : {}),
    ...(statusLine ? { statusLine } : {}),
    ...(Object.keys(sidebar).length > 0 ? { sidebar } : {}),
    ...(Object.keys(toast).length > 0 ? { toast } : {}),
  };
  return { server, display, converted, dropped };
}

function firstPerKey(list: readonly SkippedKey[]): SkippedKey[] {
  const seen = new Set<string>();
  return list.filter((item) => !seen.has(item.key) && seen.add(item.key));
}

/**
 * The v5 global settings converted in memory, or undefined when there are none. Nothing is
 * written here.
 */
export async function planV5Conversion(configDir: string): Promise<V5Conversion | undefined> {
  const files = await readV5GlobalFiles(configDir);
  if (files.sources.length === 0 && !files.sidecarSeen) return undefined;

  const read = readV5Values(files.sources);
  const mapped = mapV5Values(read.values);
  const values = Object.fromEntries(
    Object.keys(SETTINGS_SCHEMA)
      .filter((key) => Object.hasOwn(mapped.server, key))
      .map((key) => [key, mapped.server[key]]),
  );
  const checked = settingsFrom(Object.entries(values).map(([key, value]) => ({ key, value })));
  return {
    sources: files.sources.map((source) => source.path),
    malformed: files.malformed,
    written: false,
    values,
    settings: checked.settings,
    fromFile: checked.fromFile,
    displayImport: mapped.display,
    converted: mapped.converted,
    dropped: firstPerKey([...read.dropped, ...mapped.dropped]),
    invalid: firstPerKey([
      ...read.invalid,
      ...checked.issues.map((issue) => ({ key: issue.key, reason: issue.message })),
    ]),
    notes: files.notes,
  };
}

/**
 * v5 settings files that exist but v6 does not read: the global sidecars once settings.jsonc
 * exists, and every project-scope file (v6 has no project settings).
 */
export async function findUnreadV5Files(
  configDir: string,
  options: { includeGlobal: boolean; projectDir?: string },
): Promise<string[]> {
  const globalSidecars = SIDECAR_NAMES.map((name) => join(configDir, "opencode-quota", name));
  const unread = options.includeGlobal ? globalSidecars.filter((path) => existsSync(path)) : [];
  const projectDir = options.projectDir;
  if (!projectDir) return unread;

  const projectSidecars = SIDECAR_NAMES.map((name) => join(projectDir, "opencode-quota", name));
  for (const path of projectSidecars) {
    if (!globalSidecars.includes(path) && existsSync(path)) unread.push(path);
  }
  for (const name of HOST_FILE_NAMES) {
    const path = join(projectDir, name);
    if (path === join(configDir, name)) continue;
    const file = await readJsonFile(path);
    if (file.state === "parsed" && quotaToastBlock(file.value)) {
      unread.push(`${path} (experimental.quotaToast)`);
    }
  }
  return unread;
}
