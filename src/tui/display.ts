/**
 * The TUI's display settings: what the sidebar, status line, toasts and `/quota` show and how
 * they look.
 * They live only in OpenCode's plugin storage (`context.storage.store("settings")`), which
 * OpenCode saves atomically, keeps across restarts and syncs to every open TUI. The words
 * (percent style, reset style, …) are the server's and come with the snapshot.
 *
 * `FIELDS` is the one table of the plain settings: each line of the quota window's Settings
 * tabs, with its default and the values a stored setting may hold. Its Words and Providers lines
 * are the server's settings.jsonc instead (their defaults and values come from
 * `SETTINGS_SCHEMA`). While you edit, the surfaces draw the saved settings with your changes on
 * top, until Save stores them or Discard drops them.
 */
import { createSignal } from "solid-js";
import type { Words } from "../core/types.js";
import { isQuotaWindow } from "../core/windows.js";
import type { DisplayImport } from "../settings/index.js";
import { checkSetting, SETTINGS_SCHEMA, type SettingRule } from "../settings/schema.js";
import {
  type BarShape,
  barParts,
  DEFAULT_WORDS,
  formatDuration,
  percentText,
} from "../view/format.js";
import type { RowSettings, Surface, SurfaceRows, WindowChoice } from "../view/select.js";
import type { ColorRole, Layout, StatusLevel } from "../view/text.js";

/**
 * Bump when the stored shape changes, and teach `readDisplaySettings` the old one. Settings of
 * an older version keep every value that still fits; Save refuses settings of a newer one.
 */
export const SETTINGS_VERSION = 1;

/** Named colors follow the user's OpenCode theme; "#rrggbb" stays fixed; "bar" = the row's level color. */
export const COLOR_NAMES = ["text", "muted", "accent", "green", "yellow", "red", "blue"] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
export type ColorChoice = ColorName | "bar" | `#${string}`;
type StatusDetail = StatusLevel | "auto" | "one";

export type DisplaySettings = RowSettings & {
  /** Only the colors you changed; every other color follows the OpenCode theme. */
  colors: Partial<Record<ColorRole, ColorChoice>>;
  /** Below `warningBelow` percent left a bar is "getting low"; below `lowBelow` "almost out". */
  thresholds: { warningBelow: number; lowBelow: number };
  layout: Layout;
  /**
   * width 0 = all the room OpenCode's footer leaves free, else at most that many columns.
   * detail "one" = v5's prompt bar: only the first provider, with a big bar. home = at the
   * bottom of Home, whether or not it shows in sessions (`surfaces.statusLine.enabled`).
   */
  statusLine: { width: number; detail: StatusDetail; autoScrollSeconds: number; home: boolean };
  sidebar: { sessionTokens: boolean };
  /**
   * Per surface: "runs out in 2h" where a limit, used at its pace so far, runs out before its
   * reset. The quota window's Limits tab always shows the pace.
   */
  runsOut: Record<Surface, boolean>;
  /** OpenCode shows one toast at a time, so the frequent ones (every reply, question) start off. */
  toast: {
    afterReply: "off" | "always" | "low";
    afterQuestion: boolean;
    afterCompaction: boolean;
    whenAllFail: boolean;
    resetNotice: "off" | "weekly" | "all";
    seconds: number;
    sessionTokens: boolean;
  };
  /** How `/quota` shows its quick look: a popup, a toast, or a message in the session. */
  quickLook: QuickLookForm;
};

export type QuickLookForm = "dialog" | "toast" | "chat";
const QUICK_LOOK_FORMS: readonly QuickLookForm[] = ["dialog", "toast", "chat"];

/** The stored value; `settings` is missing until display settings were saved once. */
export type StoredDisplay = { version: number; settings?: DisplaySettings };

const NOTHING_SAVED: StoredDisplay = { version: SETTINGS_VERSION };

/** Every colored thing: its Colors line (and group) and the theme color it gets by default. */
const COLOR_LINES: ReadonlyArray<{
  role: ColorRole;
  title: string;
  theme: ColorName | "bar";
  group?: string;
}> = [
  { role: "good", title: "Plenty left", theme: "green", group: "Bars" },
  { role: "warning", title: "Getting low", theme: "yellow" },
  { role: "low", title: "Almost out", theme: "red" },
  { role: "empty", title: "Used part of a bar", theme: "muted" },
  { role: "title", title: "Panel title", theme: "text", group: "Names" },
  { role: "provider", title: "Provider names", theme: "text" },
  { role: "account", title: "Accounts (Pro, …)", theme: "muted" },
  { role: "label", title: "Row labels", theme: "text" },
  { role: "percent", title: "Percent numbers", theme: "bar", group: "Numbers and times" },
  { role: "reset", title: "Reset times", theme: "muted" },
  { role: "value", title: "Balances, other text", theme: "muted" },
  { role: "error", title: "Errors", theme: "red" },
  { role: "statusName", title: "Provider names", theme: "muted", group: "Status line" },
  { role: "separator", title: "Separators", theme: "muted" },
  { role: "arrows", title: "‹ +N › arrows", theme: "accent" },
];

/** The theme color each role gets unless you change it. */
export const THEME_COLORS = Object.fromEntries(
  COLOR_LINES.map(({ role, theme }) => [role, theme]),
) as Record<ColorRole, ColorName | "bar">;
const SURFACES: readonly Surface[] = ["sidebar", "collapsed", "statusLine", "toast"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWhole(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** The string entries of a record whose values pass `check`. */
function recordOf<T>(value: unknown, check: (item: unknown) => item is T): Record<string, T> {
  if (!isRecord(value)) return {};
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) if (check(item)) out[key] = item;
  return out;
}

function isColorChoice(value: unknown): value is ColorChoice {
  return (
    value === "bar" ||
    COLOR_NAMES.includes(value as ColorName) ||
    (typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value))
  );
}

function readSurface(value: unknown): SurfaceRows {
  const stored = isRecord(value) ? value : {};
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : true,
    hidden: isStringList(stored.hidden) ? [...stored.hidden] : [],
    providerOrder: isStringList(stored.providerOrder) ? [...stored.providerOrder] : [],
    rowOrder: Object.fromEntries(
      Object.entries(recordOf(stored.rowOrder, isStringList)).map(([id, rows]) => [id, [...rows]]),
    ),
  };
}

/** The value at a field's path, for example "layout.barWidth". */
export function valueAt(settings: unknown, path: string): FieldValue {
  let value = settings;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  return value as FieldValue;
}

/** Puts `value` at `keys` in `target` itself; undefined removes the key. */
function putAt(target: object, keys: readonly string[], value: unknown): void {
  let parent = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(parent[key])) parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete parent[last];
  else parent[last] = value;
}

/**
 * A copy of the settings with `value` at `keys` (a key may hold a dot, like a row id);
 * undefined removes the key, which puts a color back to the theme's or a row name back.
 */
export function setIn(
  settings: DisplaySettings,
  keys: readonly string[],
  value: unknown,
): DisplaySettings {
  const next = JSON.parse(JSON.stringify(settings)) as DisplaySettings;
  putAt(next, keys, value);
  return next;
}

export function defaultDisplaySettings(): DisplaySettings {
  const settings = {
    labels: {},
    surfaces: Object.fromEntries(SURFACES.map((surface) => [surface, readSurface(undefined)])),
    window: {},
    colors: {},
  };
  for (const field of DISPLAY_FIELDS) putAt(settings, field.path.split("."), field.initial);
  return settings as DisplaySettings;
}

/**
 * The settings in plugin storage, made whole: a missing or invalid value takes its default,
 * so a hand edit or an older or newer plugin never breaks a surface.
 */
export function readDisplaySettings(stored: unknown): DisplaySettings {
  const settings = defaultDisplaySettings();
  const from = isRecord(stored) && isRecord(stored.settings) ? stored.settings : {};
  for (const field of DISPLAY_FIELDS) {
    const value = valueAt(from, field.path);
    if (!field.color && fieldHolds(field, value)) putAt(settings, field.path.split("."), value);
  }
  const surfaces = isRecord(from.surfaces) ? from.surfaces : {};
  for (const surface of SURFACES) settings.surfaces[surface] = readSurface(surfaces[surface]);
  settings.labels = recordOf(from.labels, (item): item is string => typeof item === "string");
  settings.window = recordOf(
    from.window,
    (item): item is WindowChoice => item === "lowest" || isQuotaWindow(item),
  );
  settings.colors = recordOf(from.colors, isColorChoice);
  const { thresholds } = settings;
  thresholds.warningBelow = Math.max(thresholds.warningBelow, thresholds.lowBelow);
  return settings;
}

// ---------------------------------------------------------------------------------------------
// The Settings tabs: one line per setting, every tab from this table.

/** The quota window's Settings tabs; Words and Providers edit server settings. */
export type SettingsTab =
  | "sidebar"
  | "collapsed"
  | "statusLine"
  | "toast"
  | "colors"
  | "layout"
  | "words"
  | "providers";

export function isSurfaceTab(tab: SettingsTab): tab is Surface {
  return SURFACES.includes(tab as Surface);
}

/** What a setting line holds; undefined only for a color that follows the theme, null for unset. */
export type FieldValue = string | number | boolean | null | undefined;

export type PresetName = "layout" | "toast" | "words";

/**
 * One setting line: ‹ › step through `values`; a color line also takes a typed "#rrggbb", a
 * line with a `placeholder` a typed number. Its `path` ("layout.barWidth") is also its id.
 */
export type Field = {
  path: string;
  /** Where it is saved: plugin storage, or the server's settings.jsonc (`path` is its key). */
  store: "display" | "server";
  tab: SettingsTab;
  title: string;
  initial: FieldValue;
  values: readonly FieldValue[];
  show: (value: FieldValue) => string;
  /** What a stored value may hold besides `values` (typed by hand, or imported from v5). */
  valid?: (value: unknown) => boolean;
  /** The values ‹ › step through when some of `values` don't fit the other settings. */
  choices?: (settings: DisplaySettings) => readonly FieldValue[];
  /** A heading above the line, which starts a group. */
  group?: string;
  /** Short muted text after the value. */
  note?: string;
  /** The preset on top of the tab sets this line. */
  preset?: PresetName;
  color?: true;
  /** A number you type ("a dollar amount"); nothing typed is null. */
  placeholder?: string;
  /** On the Providers tab: nested under this provider's tick, while it is ticked. */
  provider?: string;
};

type Show = (value: FieldValue) => string;
type FieldOptions = Pick<
  Field,
  "valid" | "choices" | "group" | "note" | "preset" | "placeholder" | "provider"
>;

function fieldHolds(field: Field, value: unknown): boolean {
  return field.valid ? field.valid(value) : field.values.includes(value as FieldValue);
}

/** A setting's tab: its first key ("toast.seconds"), except thresholds (Colors) and runsOut.<tab>. */
function tabOf(path: string): SettingsTab {
  const [first, second] = path.split(".");
  if (first === "thresholds") return "colors";
  return (first === "runsOut" ? second : first) as SettingsTab;
}

function listField(
  path: string,
  title: string,
  initial: FieldValue,
  values: readonly FieldValue[],
  show: Show,
  options: FieldOptions = {},
): Field {
  return { path, store: "display", tab: tabOf(path), title, initial, values, show, ...options };
}

const onOff = (off: string, on: string) => (value: FieldValue) => (value ? on : off);

function switchField(path: string, title: string, initial: boolean, options: FieldOptions = {}) {
  return listField(path, title, initial, [false, true], onOff("off", "on"), options);
}

/** ‹ › step through `values`; a stored whole number from `min` to `max` counts too. */
function numberField(
  path: string,
  title: string,
  initial: number,
  [min, max]: readonly [number, number],
  values: readonly number[],
  show: Show,
  options: FieldOptions = {},
): Field {
  const valid = (value: unknown) => isWhole(value, min, max);
  return listField(path, title, initial, values, show, { valid, ...options });
}

/**
 * A line of the server's settings.jsonc, on Words or Providers. Its default and its values (a
 * choice, or off and on) come from SETTINGS_SCHEMA; a number line names the `values` it steps
 * through, or none when you type it.
 */
function serverField(
  path: keyof typeof SETTINGS_SCHEMA,
  title: string,
  show: Show,
  options: FieldOptions & { values?: readonly number[] } = {},
): Field {
  const rule: SettingRule = SETTINGS_SCHEMA[path];
  const values =
    rule.kind === "choice" ? rule.values : rule.kind === "boolean" ? [false, true] : [];
  const tab = path.startsWith("words.") ? "words" : "providers";
  const initial = rule.default as FieldValue;
  return { path, store: "server", tab, title, initial, values, show, ...options };
}

/** One switch per place: the Limits tab always shows the pace. */
function runsOutField(surface: Surface, where: string): Field {
  const note = "when a limit, used at your pace so far, runs out before its reset";
  return {
    ...switchField(`runsOut.${surface}`, "Runs out in …", false, { note }),
    show: onOff("off", where),
  };
}

function tokensField(path: string): Field {
  return { ...switchField(path, "Session tokens line", true), show: onOff("hidden", "shown") };
}

function colorTitle(choice: FieldValue): string {
  return choice === "bar" ? "bar color" : String(choice);
}

/** A color line; undefined follows the theme. The bar colors themselves can't follow the bar. */
function colorField({ role, title, theme, group }: (typeof COLOR_LINES)[number]): Field {
  const isLevel = role === "good" || role === "warning" || role === "low";
  const values = [undefined, ...COLOR_NAMES, ...(isLevel ? [] : ["bar"])];
  const show = (value: FieldValue) =>
    value === undefined ? `${colorTitle(theme)} (theme)` : colorTitle(value);
  return { ...listField(`colors.${role}`, title, undefined, values, show, { group }), color: true };
}

const COLOR_FIELDS = COLOR_LINES.map(colorField);
const THRESHOLDS = [10, 15, 20, 25, 30, 40, 50, 60];
const STATUS_DETAILS: Record<StatusDetail, string> = {
  auto: "as much as fits",
  one: "one provider, big bar",
  full: "bar, % and reset",
  bar: "bar and %",
  reset: "% and reset",
  numbers: "% only",
};
const BAR_SHAPES: readonly BarShape[] = ["blocks", "shades", "line", "squares", "dots", "none"];
const TOAST = { preset: "toast" } as const;
const LAYOUT = { preset: "layout" } as const;
const unit = (word: string) => (value: FieldValue) => `${value} ${word}`;
const percentLeft = unit("% left");
const RESET_NOTICES: Record<string, string> = { weekly: "weekly limits", all: "every limit" };
const QUICK_LOOK_TITLES: Record<QuickLookForm, string> = {
  dialog: "a popup",
  toast: "a toast",
  chat: "a chat message",
};
const REPLY_TOASTS = ["off", "always", "low"];
const NOTICE_TOASTS = ["off", "weekly", "all"];
const MINUTE_MS = 60_000;
/** A reset 2h 14m away and one 5d 3h 20m away, as each reset style writes them. */
const RESET_EXAMPLES_MS = [134 * MINUTE_MS, 7_400 * MINUTE_MS];
const named = (names: Record<string, string>) => (value: FieldValue) =>
  names[String(value)] ?? String(value);
const usd = (unset: string) => (value: FieldValue) =>
  typeof value === "number" ? `$${value} a month` : unset;
const CURSOR = { provider: "cursor" } as const;
const SHOW = {
  detail: (value) => STATUS_DETAILS[value as StatusDetail],
  width: (value) => (value ? `up to ${value} columns` : "all the free room"),
  scroll: (value) => (value ? `every ${value} s` : "off"),
  afterReply: (value) => (value === "low" ? "only when getting low" : String(value)),
  resetNotice: (value) => RESET_NOTICES[String(value)] ?? "off",
  bar: (value) =>
    value === "none" ? "no bars" : `${barParts(value as BarShape, 60, 5).join("")} ${value}`,
  indent: (value) => (value === 1 ? "1 space" : `${value} spaces`),
  gap: (value) => (value ? "1 empty line" : "nothing"),
  separator: (value) => (String(value).trim() ? `"${String(value).trim()}"` : "spaces"),
  quickLook: (value) => QUICK_LOOK_TITLES[value as QuickLookForm],
  percent: (value) =>
    percentText({ ...DEFAULT_WORDS, percent: value as Words["percent"] }, 58, true),
  reset: (value) =>
    RESET_EXAMPLES_MS.map((ms) => formatDuration(ms, value as Words["reset"], 1)).join(" · "),
  decimals: (value) =>
    `${value} (${formatDuration(RESET_EXAMPLES_MS[0] as number, "decimal", Number(value))})`,
  minutes: (value) => `every ${Number(value) / MINUTE_MS} min`,
  seconds: (value) => `after ${Number(value) / 1_000} s`,
  days: (value) => (value === 1 ? "every day" : `every ${value} days`),
  day: (value) => (typeof value === "number" ? `day ${value}` : "calendar month"),
  rows: named({ summary: "main rows only", detailed: "all rows" }),
  models: named({ false: "all", true: "current model's only" }),
  tokens: named({ current: "this session", tree: "with subagents" }),
  limitHit: named({ false: "retry like normal", true: "wait for the reset" }),
} satisfies Record<string, Show>;
// "Getting low" stays at or above "almost out", so ‹ › skip the values that would break that.
const warningChoices = (settings: DisplaySettings) =>
  THRESHOLDS.filter((value) => value >= settings.thresholds.lowBelow);
const lowChoices = (settings: DisplaySettings) =>
  THRESHOLDS.filter((value) => value <= settings.thresholds.warningBelow);
const isSeparator = (value: unknown) => typeof value === "string" && value.length <= 5;

/** Every plain setting, in the order its tab shows it. */
export const FIELDS: readonly Field[] = [
  tokensField("sidebar.sessionTokens"),
  runsOutField("sidebar", "under the row"),
  runsOutField("collapsed", "under the provider"),
  listField("statusLine.detail", "Show", "auto", Object.keys(STATUS_DETAILS), SHOW.detail, {
    group: "What it shows",
  }),
  runsOutField("statusLine", "after the provider"),
  numberField("statusLine.width", "Width", 0, [0, 1000], [0, 40, 60, 80], SHOW.width, {
    group: "Fine-tune",
  }),
  numberField(
    "statusLine.autoScrollSeconds",
    "Scroll by itself",
    0,
    [0, 600],
    [0, 5, 10],
    SHOW.scroll,
  ),
  switchField("statusLine.home", "At the bottom of Home", false, {
    note: "even when the line under the message box is off",
  }),
  listField("toast.afterReply", "After each reply", "off", REPLY_TOASTS, SHOW.afterReply, {
    group: "Fine-tune",
    ...TOAST,
  }),
  switchField("toast.afterQuestion", "After a question to you", false, TOAST),
  switchField("toast.afterCompaction", "After compaction", true, TOAST),
  switchField("toast.whenAllFail", "When every provider fails", true, TOAST),
  listField(
    "toast.resetNotice",
    "When a limit resets",
    "off",
    NOTICE_TOASTS,
    SHOW.resetNotice,
    TOAST,
  ),
  numberField("toast.seconds", "Stays on screen", 9, [1, 120], [5, 9, 15, 30], unit("s"), {
    group: "Look",
  }),
  tokensField("toast.sessionTokens"),
  runsOutField("toast", "after the row"),
  ...COLOR_FIELDS.slice(0, 4),
  numberField(
    "thresholds.warningBelow",
    "'Getting low' below",
    50,
    [0, 100],
    THRESHOLDS,
    percentLeft,
    {
      choices: warningChoices,
    },
  ),
  numberField("thresholds.lowBelow", "'Almost out' below", 20, [0, 100], THRESHOLDS, percentLeft, {
    choices: lowChoices,
  }),
  ...COLOR_FIELDS.slice(4),
  listField("layout.bar", "Bar shape", "blocks", BAR_SHAPES, SHOW.bar, { group: "Bars" }),
  numberField(
    "layout.barWidth",
    "Bar width",
    8,
    [1, 30],
    [4, 6, 8, 10, 12],
    unit("columns"),
    LAYOUT,
  ),
  numberField("layout.indent", "Row indent", 1, [0, 4], [0, 1, 2, 3], SHOW.indent, {
    group: "Spacing",
    ...LAYOUT,
  }),
  numberField(
    "layout.labelWidth",
    "Label width",
    8,
    [3, 20],
    [6, 8, 10, 12],
    unit("letters"),
    LAYOUT,
  ),
  numberField("layout.providerGap", "Between providers", 0, [0, 2], [0, 1], SHOW.gap, LAYOUT),
  listField("layout.separator", "Separator", " · ", [" · ", " | ", " / ", "  "], SHOW.separator, {
    group: "Status line",
    valid: isSeparator,
  }),
  // On Layout: how /quota looks, next to how the other places look.
  {
    ...listField("quickLook", "/quota shows", "dialog", QUICK_LOOK_FORMS, SHOW.quickLook, {
      group: "/quota quick look",
      note: "type /quota to try it, even before you save",
    }),
    tab: "layout",
  },
  serverField("words.percent", "Percent", SHOW.percent, { group: "Numbers", preset: "words" }),
  serverField("words.reset", "Reset times", SHOW.reset, { preset: "words" }),
  serverField("words.resetDecimals", "Decimals", SHOW.decimals, {
    note: "for the decimal reset times",
    values: [0, 1, 2],
  }),
  serverField("words.detail", "Extra rows", SHOW.rows, { group: "What shows" }),
  serverField("words.onlyCurrentModel", "Providers shown", SHOW.models),
  serverField("words.sessionTokens", "Session tokens count", SHOW.tokens),
  serverField("words.runsOut", "Runs out in …", onOff("off", "on"), {
    group: "Web, Desktop and CLI text",
    note: "the sidebar, status line and toasts have their own switch",
  }),
  serverField("providers.cursor.plan", "Plan", named({}), CURSOR),
  serverField("providers.cursor.includedApiUsd", "Included API budget", usd("from the plan"), {
    ...CURSOR,
    placeholder: "a dollar amount",
  }),
  serverField("providers.cursor.billingCycleStartDay", "Billing day", SHOW.day, {
    ...CURSOR,
    placeholder: "a day 1-28",
  }),
  serverField("providers.opencode.monthlyLimitUsd", "Monthly budget", usd("not set"), {
    provider: "opencode",
    placeholder: "a dollar amount",
  }),
  serverField("checking.minIntervalMs", "Check for new numbers", SHOW.minutes, {
    group: "Checking",
    values: [1, 2, 5, 10, 15, 30].map((count) => count * MINUTE_MS),
  }),
  serverField("checking.requestTimeoutMs", "Slow provider: give up", SHOW.seconds, {
    values: [5_000, 8_000, 12_000, 20_000, 30_000],
  }),
  serverField("checking.waitForQuotaReset", "A model hits its limit", SHOW.limitHit),
  serverField(
    "pricing.source",
    "Prices from",
    named({ auto: "newest list", bundled: "built-in list only", runtime: "downloaded list only" }),
    { group: "Token prices" },
  ),
  serverField("pricing.autoRefreshDays", "Download new prices", SHOW.days, { values: [1, 7, 30] }),
  serverField("export.enabled", "Quota file (JSON)", onOff("off", "on"), {
    group: "For other tools",
    note: "for status bars and scripts; the opencode-quota CLI works either way",
  }),
  serverField("telemetry.enabled", "OpenTelemetry metrics", onOff("off", "on")),
];
const DISPLAY_FIELDS = FIELDS.filter((field) => field.store === "display");

/** A line on top of a tab that sets the lines marked with its name in one step. */
export type Preset = {
  tab: SettingsTab;
  title: string;
  /** What it sets, after "sets". */
  drives: string;
  /** The values of each choice, by path. */
  choices: Record<string, Record<string, FieldValue>>;
};

function layoutChoice(barWidth: number, indent: number, labelWidth: number, providerGap: number) {
  return {
    "layout.barWidth": barWidth,
    "layout.indent": indent,
    "layout.labelWidth": labelWidth,
    "layout.providerGap": providerGap,
  };
}

function toastChoice(
  afterReply: string,
  afterQuestion: boolean,
  afterCompaction: boolean,
  resetNotice: string,
) {
  return {
    "toast.afterReply": afterReply,
    "toast.afterQuestion": afterQuestion,
    "toast.afterCompaction": afterCompaction,
    "toast.whenAllFail": true,
    "toast.resetNotice": resetNotice,
  };
}

export const PRESETS: Record<PresetName, Preset> = {
  layout: {
    tab: "layout",
    title: "Layout preset",
    drives: "bar width and the 3 spacing lines",
    choices: {
      compact: layoutChoice(6, 1, 6, 0),
      comfortable: layoutChoice(8, 1, 8, 0),
      roomy: layoutChoice(10, 2, 8, 1),
    },
  },
  toast: {
    tab: "toast",
    title: "When toasts show",
    drives: "the 5 lines under it",
    choices: {
      "only failures": toastChoice("off", false, false, "off"),
      normal: toastChoice("off", false, true, "off"),
      "when getting low": toastChoice("low", false, true, "weekly"),
      "every reply": toastChoice("always", true, true, "all"),
    },
  },
  words: {
    tab: "words",
    title: "Wording",
    drives: "the 2 lines under it",
    choices: {
      normal: { "words.percent": "left", "words.reset": "exact" },
      short: { "words.percent": "bare", "words.reset": "compact" },
      "spelled out": { "words.percent": "remaining", "words.reset": "exact" },
    },
  },
};

/** The value `delta` steps from `current` in `values`, wrapping; an unknown one counts as the first. */
export function stepIn<T>(values: readonly T[], current: T, delta: number): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + delta + values.length) % values.length] as T;
}

/** A typed number the server takes for the field ("$" allowed); null for nothing typed. */
export function typedNumber(field: Field, text: string): FieldValue {
  const trimmed = text.trim().replace(/^\$/u, "");
  if (!trimmed) return null;
  const value = Number(trimmed);
  return checkSetting(field.path, value).issues.length === 0 ? value : undefined;
}

/** A typed "#89b4fa" (the # is optional); nothing typed puts the theme's color back. */
export function typedColor(settings: DisplaySettings, field: Field, text: string): DisplaySettings {
  const hex = text.trim().replace(/^#/u, "").toLowerCase();
  if (hex && !/^[0-9a-f]{6}$/u.test(hex)) return settings;
  return setIn(settings, field.path.split("."), hex ? `#${hex}` : undefined);
}

/** The preset choice whose values all match the lines' values; undefined is "your own". */
export function presetChoice(
  name: PresetName,
  value: (path: string) => unknown,
): string | undefined {
  return Object.entries(PRESETS[name].choices).find(([, values]) =>
    Object.entries(values).every(([path, wanted]) => value(path) === wanted),
  )?.[0];
}

/** ‹ or ›: the values of the previous or next choice after `current`; from "your own", the first. */
export function presetValues(
  name: PresetName,
  current: string | undefined,
  delta: number,
): Readonly<Record<string, FieldValue>> {
  const names = Object.keys(PRESETS[name].choices);
  const next = current === undefined ? names[0] : stepIn(names, current, delta);
  return PRESETS[name].choices[next as string] ?? {};
}

/** Your name for a row; nothing typed, or its own name, puts its own name back. */
export function renameRow(
  settings: DisplaySettings,
  rowId: string,
  ownLabel: string,
  text: string,
): DisplaySettings {
  const label = text.trim();
  return setIn(settings, ["labels", rowId], label && label !== ownLabel ? label : undefined);
}

/**
 * The tab's lines back to their defaults. A surface tab also puts that surface's order, hidden
 * rows and switches back (and Collapsed and Status line the preferred windows); row names stay.
 */
export function resetTab(settings: DisplaySettings, tab: SettingsTab): DisplaySettings {
  let next = DISPLAY_FIELDS.filter((field) => field.tab === tab).reduce(
    (result, field) => setIn(result, field.path.split("."), field.initial),
    settings,
  );
  if (isSurfaceTab(tab)) next = setIn(next, ["surfaces", tab], readSurface(undefined));
  if (tab === "collapsed" || tab === "statusLine") next = setIn(next, ["window"], {});
  return next;
}

// ---------------------------------------------------------------------------------------------
// Plugin storage: the saved settings and this window's changes

/** What `context.storage.store` needs from the TUI context. */
export type DisplayStorage = {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>];
};

/** One changed setting: its keys and its new value (undefined = removed). */
type Change = { keys: string[]; value: unknown };

/** Where `next` differs from `base`: records key by key, anything else as a whole. */
function changesBetween(base: unknown, next: unknown, keys: string[] = []): Change[] {
  if (isRecord(base) && isRecord(next)) {
    return [...new Set([...Object.keys(base), ...Object.keys(next)])].flatMap((key) =>
      changesBetween(base[key], next[key], [...keys, key]),
    );
  }
  return JSON.stringify(base) === JSON.stringify(next) ? [] : [{ keys, value: next }];
}

function withChanges(settings: DisplaySettings, changes: readonly Change[]): DisplaySettings {
  const next = JSON.parse(JSON.stringify(settings)) as DisplaySettings;
  for (const change of changes) putAt(next, change.keys, change.value);
  return readDisplaySettings({ settings: next });
}

export const NEWER_SETTINGS =
  "These settings were saved by a newer version of the plugin; update it to change these settings.";

export type DisplayStore = ReturnType<typeof createDisplayStore>;

/**
 * The saved settings come from the live plugin store, so a surface that reads them inside its
 * JSX updates when they change (an edit in another TUI or by hand). This window's changes are
 * kept as the settings they change, so everything else stays live. The store opens when
 * something first reads it, never during plugin setup.
 */
export function createDisplayStore(storage: DisplayStorage) {
  let store:
    | readonly [StoredDisplay, (mutation: (draft: StoredDisplay) => void) => Promise<void>]
    | undefined;
  const open = () => {
    store ??= storage.store<StoredDisplay>("settings", { initial: NOTHING_SAVED });
    return store;
  };
  const [changes, setChanges] = createSignal<readonly Change[]>([]);
  /** The changes a Save is writing; this window's changes go on top of them until it is done. */
  const [saving, setSaving] = createSignal<readonly Change[]>([]);
  const saved = () => readDisplaySettings(open()[0]);
  const base = () => (saving().length > 0 ? withChanges(saved(), saving()) : saved());
  /** The saved settings with this window's changes on top. The surfaces draw these. */
  const shown = () => (changes().length > 0 ? withChanges(base(), changes()) : base());
  return {
    saved,
    shown,
    /** Only the settings that end up different from the saved ones count as changes. */
    edit(change: (settings: DisplaySettings) => DisplaySettings): void {
      setChanges(changesBetween(base(), readDisplaySettings({ settings: change(shown()) })));
    },
    dirty: () => changesBetween(saved(), shown()).length > 0,
    /**
     * Writes the changes over what storage holds at that moment, so another TUI's saved
     * settings stay, unless a newer plugin saved them. Changes made while it writes (one back
     * to the old value too) stay unsaved.
     */
    async save(): Promise<void> {
      const pending = changes();
      if (pending.length === 0) return;
      let newer = false;
      setSaving(pending);
      setChanges([]);
      try {
        await open()[1]((value) => {
          newer = typeof value.version === "number" && value.version > SETTINGS_VERSION;
          if (newer) return;
          const next = withChanges(readDisplaySettings(value), pending);
          value.version = SETTINGS_VERSION;
          value.settings = JSON.parse(JSON.stringify(next));
        });
      } finally {
        const now = shown();
        setSaving([]);
        setChanges(changesBetween(saved(), now));
      }
      if (newer) throw new Error(NEWER_SETTINGS);
    },
    discard: () => setChanges([]),
  };
}

/**
 * Saves the v5 looks the settings conversion found as the display settings, only while
 * nothing is saved yet: a choice made in any TUI is never overwritten.
 */
export async function applyDisplayImport(
  storage: DisplayStorage,
  displayImport: DisplayImport,
): Promise<void> {
  if (Object.keys(displayImport).length === 0) return;
  const [, update] = storage.store<StoredDisplay>("settings", { initial: NOTHING_SAVED });
  await update((draft) => {
    if (draft.settings !== undefined) return;
    draft.version = SETTINGS_VERSION;
    draft.settings = readDisplaySettings({ settings: displayImport });
  });
}
