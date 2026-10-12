/**
 * File-backed settings for the TUI and its Settings lines. DisplaySettings also exposes the
 * row selectors the existing renderers consume; these are derived from the tab sections.
 */
import type { Words } from "../core/types.js";
import {
  type CursorQuotaPlan,
  getCursorPlanDisplayName,
  getEffectiveCursorIncludedApiUsd,
} from "../lib/cursor-pricing.js";
import { isRecord } from "../lib/json-guards.js";
import {
  checkSetting,
  defaultSettings,
  diffSettings,
  SETTINGS_SCHEMA,
  type SettingRule,
  type Settings,
  setPath,
} from "../settings/schema.js";
import {
  type BarShape,
  barParts,
  DEFAULT_WORDS,
  formatDuration,
  percentText,
} from "../view/format.js";
import type { RowSettings, Surface } from "../view/select.js";
import type { ColorRole, StatusLevel } from "../view/text.js";

/** Named colors follow OpenCode's theme; hex colors stay fixed; bar follows the row's level. */
export const COLOR_NAMES = ["text", "muted", "accent", "green", "yellow", "red", "blue"] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
export type ColorChoice = ColorName | "bar" | `#${string}`;
type StatusDetail = StatusLevel | "auto" | "one";

export type DisplaySettings = Settings &
  RowSettings & {
    thresholds: { warningBelow: number; lowBelow: number };
    runsOut: Record<Surface, boolean>;
  };

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

function isWhole(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** The tab sections as the row settings the renderers use. */
export function displaySettings(settings: Settings): DisplaySettings {
  return {
    ...settings,
    labels: settings.sidebar.names,
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => [
        surface,
        {
          enabled: settings[surface].show,
          hidden: settings[surface].hidden,
          providerOrder: settings[surface].providerOrder,
          rowOrder: settings[surface].rowOrder,
          names: surface === "toast" ? settings.toast.names : settings.sidebar.names,
        },
      ]),
    ) as RowSettings["surfaces"],
    window: settings.collapsed.window,
    thresholds: {
      warningBelow: Math.max(settings.colors.warningBelow, settings.colors.lowBelow),
      lowBelow: settings.colors.lowBelow,
    },
    runsOut: Object.fromEntries(
      SURFACES.map((surface) => [surface, settings[surface].runsOut]),
    ) as Record<Surface, boolean>,
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
  return displaySettings(next);
}

export function defaultDisplaySettings(): DisplaySettings {
  return displaySettings(defaultSettings());
}

// ---------------------------------------------------------------------------------------------
// The Settings pages: one line per setting, every page from this table.

/**
 * The quota window's Settings pages, one per file section. The tab bar shows Layout (the pages
 * sidebar, collapsed, statusLine, toast, and layout as "All places"), Colors, Words, Providers.
 */
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
> & { tab?: SettingsTab };

/** A setting's page is its first key, for example "toast" in "toast.seconds", unless it names one. */
function tabOf(path: string): SettingsTab {
  return path.split(".")[0] as SettingsTab;
}

function listField(
  path: string,
  title: string,
  initial: FieldValue,
  values: readonly FieldValue[],
  show: Show,
  options: FieldOptions = {},
): Field {
  return { path, tab: tabOf(path), title, initial, values, show, ...options };
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
 * A line of the server's settings.jsonc, on Words, All places or Providers. Its default and its
 * values (a choice, or off and on) come from SETTINGS_SCHEMA; a number line names the `values`
 * it steps through, or none when you type it.
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
  const tab = tabOf(path);
  const initial = rule.default as FieldValue;
  return { path, tab, title, initial, values, show, ...options };
}

/** One switch per place: the Limits tab always shows the pace. */
function runsOutField(surface: Surface, where: string): Field {
  const note = "when a limit, used at your pace so far, runs out before its reset";
  const initial = SETTINGS_SCHEMA[`${surface}.runsOut`].default;
  return {
    ...switchField(`${surface}.runsOut`, "Runs out in …", initial, { note }),
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
/** A Cursor plan with the API use it includes, e.g. "Pro: $20 a month". */
const cursorPlan = (value: FieldValue) => {
  const plan = value as CursorQuotaPlan;
  const includedUsd = getEffectiveCursorIncludedApiUsd({ plan });
  return includedUsd === undefined
    ? "not set"
    : `${getCursorPlanDisplayName(plan)}: $${includedUsd} a month`;
};
const SHOW = {
  detail: (value) => STATUS_DETAILS[value as StatusDetail],
  width: (value) => (value ? `up to ${value} columns` : "all the free room"),
  scroll: (value) => (value ? `every ${value} s` : "off"),
  afterReply: (value) => (value === "low" ? "only when getting low" : String(value)),
  resetNotice: (value) => RESET_NOTICES[String(value)] ?? "off",
  bar: (value) =>
    value === "none" ? "no bars" : `${barParts(value as BarShape, 60, 5).join("")} ${value}`,
  indent: (value) => (value === 1 ? "1 space" : `${value} spaces`),
  gap: (value) => (value === 1 ? "1 empty line" : value ? `${value} empty lines` : "nothing"),
  separator: (value) => (String(value).trim() ? `"${String(value).trim()}"` : "spaces"),
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
  THRESHOLDS.filter((value) => value >= settings.colors.lowBelow);
const lowChoices = (settings: DisplaySettings) =>
  THRESHOLDS.filter((value) => value <= settings.colors.warningBelow);
const isSeparator = (value: unknown) => typeof value === "string" && value.length <= 5;

/** Every plain setting, in the order its tab shows it. */
export const FIELDS: readonly Field[] = [
  tokensField("sidebar.sessionTokens"),
  runsOutField("sidebar", "under the row"),
  runsOutField("collapsed", "under the provider"),
  {
    ...switchField("statusLine.withSidebar", "Next to the sidebar", false, {
      group: "When it shows",
    }),
    show: onOff("hide the line", "show it too"),
  },
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
  listField("toast.afterReply", "After each reply", "low", REPLY_TOASTS, SHOW.afterReply, {
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
  numberField("colors.warningBelow", "'Getting low' below", 50, [0, 100], THRESHOLDS, percentLeft, {
    choices: warningChoices,
  }),
  numberField("colors.lowBelow", "'Almost out' below", 20, [0, 100], THRESHOLDS, percentLeft, {
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
  numberField("layout.providerGap", "Between providers", 1, [0, 2], [0, 1], SHOW.gap, LAYOUT),
  listField("layout.separator", "Separator", " · ", [" · ", " | ", " / ", "  "], SHOW.separator, {
    group: "Status line",
    valid: isSeparator,
  }),
  serverField("words.percent", "Percent", SHOW.percent, { group: "Numbers", preset: "words" }),
  serverField("words.reset", "Reset times", SHOW.reset, { preset: "words" }),
  serverField("words.resetDecimals", "Decimals", SHOW.decimals, {
    note: "for the decimal reset times",
    values: [0, 1, 2],
  }),
  // Words' choices of what shows, which every place follows: on All places.
  serverField("words.detail", "Extra rows", SHOW.rows, { tab: "layout", group: "What shows" }),
  serverField("words.onlyCurrentModel", "Providers shown", SHOW.models, { tab: "layout" }),
  serverField("words.sessionTokens", "Session tokens count", SHOW.tokens, { tab: "layout" }),
  serverField("providers.cursor.plan", "Plan", cursorPlan, {
    ...CURSOR,
    note: "API use the plan includes; shown as a %",
  }),
  serverField("providers.cursor.includedApiUsd", "Included API budget", usd("from the plan"), {
    ...CURSOR,
    note: "a dollar amount to use instead of the plan's",
    placeholder: "a dollar amount",
  }),
  serverField("providers.cursor.billingCycleStartDay", "Billing day", SHOW.day, {
    ...CURSOR,
    note: "the day of the month your Cursor bill renews",
    placeholder: "a day 1-28",
  }),
  serverField("providers.opencode.monthlyLimitUsd", "Monthly budget", usd("from the Console"), {
    provider: "opencode",
    note: "a dollar amount to use instead",
    placeholder: "a dollar amount",
  }),
  serverField("providers.checking.minIntervalMs", "Check for new numbers", SHOW.minutes, {
    group: "Checking",
    values: [1, 2, 5, 10, 15, 30].map((count) => count * MINUTE_MS),
  }),
  serverField("providers.checking.requestTimeoutMs", "Slow provider: give up", SHOW.seconds, {
    values: [5_000, 8_000, 12_000, 20_000, 30_000],
  }),
  serverField("providers.checking.waitForQuotaReset", "A model hits its limit", SHOW.limitHit),
  serverField(
    "providers.pricing.source",
    "Prices from",
    named({ auto: "newest list", bundled: "built-in list only", runtime: "downloaded list only" }),
    { group: "Token prices" },
  ),
  serverField("providers.pricing.autoRefreshDays", "Download new prices", SHOW.days, {
    values: [1, 7, 30],
  }),
];

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
      comfortable: layoutChoice(8, 1, 8, 1),
      roomy: layoutChoice(10, 2, 8, 1),
    },
  },
  toast: {
    tab: "toast",
    title: "When toasts show",
    drives: "the 5 lines under it",
    choices: {
      "only failures": toastChoice("off", false, false, "off"),
      quiet: toastChoice("off", false, true, "off"),
      normal: toastChoice("low", false, true, "off"),
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
  surface: "sidebar" | "toast",
  rowId: string,
  ownLabel: string,
  text: string,
): DisplaySettings {
  const label = text.trim();
  return setIn(
    settings,
    [surface, "names", rowId],
    label && label !== ownLabel ? label : undefined,
  );
}

/**
 * The tab's lines back to their defaults. A surface tab also puts that surface's order, hidden
 * rows and switches back (and Collapsed and Status line the preferred windows); row names stay.
 */
export function resetTab(settings: DisplaySettings, tab: SettingsTab): DisplaySettings {
  let next = FIELDS.filter((field) => field.tab === tab).reduce(
    (result, field) => setIn(result, field.path.split("."), field.initial),
    settings,
  );
  if (isSurfaceTab(tab)) {
    for (const key of ["show", "hidden", "providerOrder", "rowOrder"])
      next = setIn(next, [tab, key], valueAt(defaultSettings(), `${tab}.${key}`));
  }
  if (tab === "collapsed" || tab === "statusLine") next = setIn(next, [tab, "window"], {});
  return next;
}

/** Settings received through the RPC, with this window's draft on top. */
export type DisplayStore = ReturnType<typeof createFileDisplay>;

export function createFileDisplay(server: import("./server-settings.js").ServerSettings) {
  const shown = () => {
    const settings = defaultSettings();
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
      if (key !== "version") {
        const value = server.value(key);
        if (value !== undefined) setPath(settings, key, value);
      }
    }
    return displaySettings(settings);
  };
  return {
    server,
    shown,
    edit(change: (settings: DisplaySettings) => DisplaySettings): void {
      for (const diff of diffSettings(shown(), change(shown()))) server.set(diff.key, diff.after);
    },
  };
}
