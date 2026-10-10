/**
 * The TUI's display settings: what the sidebar, status line and toasts show and how they look.
 * They live only in OpenCode's plugin storage (`context.storage.store("settings")`), which
 * OpenCode saves atomically, keeps across restarts and syncs to every open TUI. The words
 * (percent style, reset style, …) are the server's and come with the snapshot.
 *
 * The quota window's Settings tabs edit a draft: every setting line comes from `FIELDS`, and
 * the surfaces draw the draft until Save stores it or Discard drops it.
 */
import { createSignal } from "solid-js";
import { isQuotaWindow } from "../core/windows.js";
import { type BarShape, barParts } from "../view/format.js";
import type { RowSettings, Surface, SurfaceRows, WindowChoice } from "../view/select.js";
import type { ColorRole, Layout, StatusLevel } from "../view/text.js";

/**
 * Bump when the stored shape changes, and teach `readDisplaySettings` the old one. Settings of
 * another version are never reset: every value that still fits is kept.
 */
export const SETTINGS_VERSION = 1;

/** Named colors follow the user's OpenCode theme; "#rrggbb" stays fixed; "bar" = the row's level color. */
export type ColorName = "text" | "muted" | "accent" | "green" | "yellow" | "red" | "blue";
export type ColorChoice = ColorName | "bar" | `#${string}`;

export type DisplaySettings = RowSettings & {
  /** Only the colors you changed; every other color follows the OpenCode theme. */
  colors: Partial<Record<ColorRole, ColorChoice>>;
  /** Below `warningBelow` percent left a bar is "getting low"; below `lowBelow` "almost out". */
  thresholds: { warningBelow: number; lowBelow: number };
  layout: Layout;
  /**
   * width 0 = all the room OpenCode's footer leaves free, else at most that many columns.
   * detail "one" = v5's prompt bar: only the first provider, with a big bar. home = also at
   * the bottom of Home.
   */
  statusLine: {
    width: number;
    detail: StatusLevel | "auto" | "one";
    autoScrollSeconds: number;
    home: boolean;
  };
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
};

export type StoredDisplay = { version: number; settings: DisplaySettings };

/** The theme color each role gets unless you change it. */
export const THEME_COLORS: Record<ColorRole, ColorName | "bar"> = {
  good: "green",
  warning: "yellow",
  low: "red",
  empty: "muted",
  title: "text",
  provider: "text",
  account: "muted",
  label: "text",
  percent: "bar",
  reset: "muted",
  value: "muted",
  error: "red",
  statusName: "muted",
  separator: "muted",
  arrows: "accent",
};

export const COLOR_NAMES: readonly ColorName[] = [
  "text",
  "muted",
  "accent",
  "green",
  "yellow",
  "red",
  "blue",
];
const BAR_SHAPES: readonly BarShape[] = ["blocks", "shades", "line", "squares", "dots", "none"];
const STATUS_DETAILS: readonly DisplaySettings["statusLine"]["detail"][] = [
  "auto",
  "one",
  "full",
  "bar",
  "reset",
  "numbers",
];

const SURFACES: readonly Surface[] = ["sidebar", "collapsed", "statusLine", "toast"];

function defaultSurface(): SurfaceRows {
  return { enabled: true, hidden: [], providerOrder: [], rowOrder: {} };
}

export function defaultDisplaySettings(): DisplaySettings {
  return {
    labels: {},
    surfaces: {
      sidebar: defaultSurface(),
      collapsed: defaultSurface(),
      statusLine: defaultSurface(),
      toast: defaultSurface(),
    },
    window: {},
    colors: {},
    thresholds: { warningBelow: 50, lowBelow: 20 },
    layout: {
      bar: "blocks",
      barWidth: 8,
      indent: 1,
      labelWidth: 8,
      providerGap: 0,
      separator: " · ",
    },
    statusLine: { width: 0, detail: "auto", autoScrollSeconds: 0, home: false },
    sidebar: { sessionTokens: true },
    runsOut: { sidebar: false, collapsed: false, statusLine: false, toast: false },
    toast: {
      afterReply: "off",
      afterQuestion: false,
      afterCompaction: true,
      whenAllFail: true,
      resetNotice: "off",
      seconds: 9,
      sessionTokens: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `value` when it is a whole number in [min, max], else `fallback`. */
function wholeNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
    enabled: flag(stored.enabled, true),
    hidden: isStringList(stored.hidden) ? [...stored.hidden] : [],
    providerOrder: isStringList(stored.providerOrder) ? [...stored.providerOrder] : [],
    rowOrder: Object.fromEntries(
      Object.entries(recordOf(stored.rowOrder, isStringList)).map(([id, rows]) => [id, [...rows]]),
    ),
  };
}

/**
 * The settings in plugin storage, made whole: a missing or invalid value takes its default,
 * so a hand edit or an older or newer plugin never breaks a surface.
 */
export function readDisplaySettings(stored: unknown): DisplaySettings {
  const defaults = defaultDisplaySettings();
  const settings = isRecord(stored) && isRecord(stored.settings) ? stored.settings : {};
  const part = (key: string) =>
    (isRecord(settings[key]) ? settings[key] : {}) as Record<string, unknown>;
  const surfaces = part("surfaces");
  const thresholds = part("thresholds");
  const layout = part("layout");
  const statusLine = part("statusLine");
  const toast = part("toast");
  const lowBelow = wholeNumber(thresholds.lowBelow, 0, 100, defaults.thresholds.lowBelow);
  return {
    labels: recordOf(settings.labels, (item): item is string => typeof item === "string"),
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => [surface, readSurface(surfaces[surface])]),
    ) as Record<Surface, SurfaceRows>,
    window: recordOf(
      settings.window,
      (item): item is WindowChoice => item === "lowest" || isQuotaWindow(item),
    ),
    colors: recordOf(settings.colors, isColorChoice),
    thresholds: {
      warningBelow: Math.max(
        lowBelow,
        wholeNumber(thresholds.warningBelow, 0, 100, defaults.thresholds.warningBelow),
      ),
      lowBelow,
    },
    layout: {
      bar: oneOf(layout.bar, BAR_SHAPES, defaults.layout.bar),
      barWidth: wholeNumber(layout.barWidth, 1, 30, defaults.layout.barWidth),
      indent: wholeNumber(layout.indent, 0, 4, defaults.layout.indent),
      labelWidth: wholeNumber(layout.labelWidth, 3, 20, defaults.layout.labelWidth),
      providerGap: wholeNumber(layout.providerGap, 0, 2, defaults.layout.providerGap),
      separator:
        typeof layout.separator === "string" && layout.separator.length <= 5
          ? layout.separator
          : defaults.layout.separator,
    },
    statusLine: {
      width: wholeNumber(statusLine.width, 0, 1000, defaults.statusLine.width),
      detail: oneOf(statusLine.detail, STATUS_DETAILS, defaults.statusLine.detail),
      autoScrollSeconds: wholeNumber(
        statusLine.autoScrollSeconds,
        0,
        600,
        defaults.statusLine.autoScrollSeconds,
      ),
      home: flag(statusLine.home, defaults.statusLine.home),
    },
    sidebar: {
      sessionTokens: flag(part("sidebar").sessionTokens, defaults.sidebar.sessionTokens),
    },
    runsOut: Object.fromEntries(
      SURFACES.map((surface) => [surface, flag(part("runsOut")[surface], false)]),
    ) as Record<Surface, boolean>,
    toast: {
      afterReply: oneOf(toast.afterReply, ["off", "always", "low"], defaults.toast.afterReply),
      afterQuestion: flag(toast.afterQuestion, defaults.toast.afterQuestion),
      afterCompaction: flag(toast.afterCompaction, defaults.toast.afterCompaction),
      whenAllFail: flag(toast.whenAllFail, defaults.toast.whenAllFail),
      resetNotice: oneOf(toast.resetNotice, ["off", "weekly", "all"], defaults.toast.resetNotice),
      seconds: wholeNumber(toast.seconds, 1, 120, defaults.toast.seconds),
      sessionTokens: flag(toast.sessionTokens, defaults.toast.sessionTokens),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The Settings tabs: one line per setting, every tab from this table.

/** The quota window's Settings tabs that edit display settings. */
export type SettingsTab = "sidebar" | "collapsed" | "statusLine" | "toast" | "colors" | "layout";

export function isSurfaceTab(tab: SettingsTab): tab is Surface {
  return SURFACES.includes(tab as Surface);
}

/** What a setting line holds; undefined only for a color that follows the theme. */
export type FieldValue = string | number | boolean | undefined;

export type PresetName = "layout" | "toast";

/**
 * One setting line: ‹ › step through `values`; a color line also takes a typed "#rrggbb". Its
 * `path` in the display settings ("layout.barWidth") is also its id.
 */
export type Field = {
  path: string;
  tab: SettingsTab;
  /** A heading above the line, which starts a group. */
  group?: string;
  title: string;
  values: readonly FieldValue[];
  show: (value: FieldValue) => string;
  /** Short muted text after the value. */
  note?: string;
  /** The preset on top of the tab sets this line. */
  preset?: PresetName;
  color?: true;
};

/** A line on top of a tab that sets the lines marked with its name in one step. */
export type Preset = {
  tab: SettingsTab;
  title: string;
  /** What it sets, after "sets". */
  drives: string;
  /** The values of each choice, by path. */
  choices: Record<string, Record<string, FieldValue>>;
};

export const PRESETS: Record<PresetName, Preset> = {
  layout: {
    tab: "layout",
    title: "Layout preset",
    drives: "bar width and the 3 spacing lines",
    choices: {
      compact: {
        "layout.barWidth": 6,
        "layout.indent": 1,
        "layout.labelWidth": 6,
        "layout.providerGap": 0,
      },
      comfortable: {
        "layout.barWidth": 8,
        "layout.indent": 1,
        "layout.labelWidth": 8,
        "layout.providerGap": 0,
      },
      roomy: {
        "layout.barWidth": 10,
        "layout.indent": 2,
        "layout.labelWidth": 8,
        "layout.providerGap": 1,
      },
    },
  },
  toast: {
    tab: "toast",
    title: "When toasts show",
    drives: "the 5 lines under it",
    choices: {
      "only failures": {
        "toast.afterReply": "off",
        "toast.afterQuestion": false,
        "toast.afterCompaction": false,
        "toast.whenAllFail": true,
        "toast.resetNotice": "off",
      },
      normal: {
        "toast.afterReply": "off",
        "toast.afterQuestion": false,
        "toast.afterCompaction": true,
        "toast.whenAllFail": true,
        "toast.resetNotice": "off",
      },
      "when getting low": {
        "toast.afterReply": "low",
        "toast.afterQuestion": false,
        "toast.afterCompaction": true,
        "toast.whenAllFail": true,
        "toast.resetNotice": "weekly",
      },
      "every reply": {
        "toast.afterReply": "always",
        "toast.afterQuestion": true,
        "toast.afterCompaction": true,
        "toast.whenAllFail": true,
        "toast.resetNotice": "all",
      },
    },
  },
};

const onOff = (off: string, on: string) => (value: FieldValue) => (value ? on : off);
const SWITCH = [false, true] as const;
const THRESHOLDS = [10, 15, 20, 25, 30, 40, 50, 60];
const STATUS_DETAIL_TITLES: Record<DisplaySettings["statusLine"]["detail"], string> = {
  auto: "as much as fits",
  full: "bar, % and reset",
  bar: "bar and %",
  reset: "% and reset",
  numbers: "% only",
  one: "one provider, big bar",
};

/** One switch per place: the Limits tab always shows the pace. */
function runsOutField(surface: Surface, where: string): Field {
  return {
    path: `runsOut.${surface}`,
    tab: surface,
    title: "Runs out in …",
    values: SWITCH,
    show: onOff("off", where),
    note: "when a limit, used at your pace so far, runs out before its reset",
  };
}

/** Every colored thing, in its Colors group. */
const COLOR_LINES: ReadonlyArray<{ role: ColorRole; title: string; group?: string }> = [
  { role: "good", title: "Plenty left", group: "Bars" },
  { role: "warning", title: "Getting low" },
  { role: "low", title: "Almost out" },
  { role: "empty", title: "Used part of a bar" },
  { role: "title", title: "Panel title", group: "Names" },
  { role: "provider", title: "Provider names" },
  { role: "account", title: "Accounts (Pro, …)" },
  { role: "label", title: "Row labels" },
  { role: "percent", title: "Percent numbers", group: "Numbers and times" },
  { role: "reset", title: "Reset times" },
  { role: "value", title: "Balances, other text" },
  { role: "error", title: "Errors" },
  { role: "statusName", title: "Provider names", group: "Status line" },
  { role: "separator", title: "Separators" },
  { role: "arrows", title: "‹ +N › arrows" },
];

function colorTitle(choice: FieldValue): string {
  return choice === "bar" ? "bar color" : String(choice);
}

function colorField(line: (typeof COLOR_LINES)[number]): Field {
  // The bar colors themselves can't follow the bar color.
  const isLevel = line.role === "good" || line.role === "warning" || line.role === "low";
  return {
    path: `colors.${line.role}`,
    tab: "colors",
    ...(line.group ? { group: line.group } : {}),
    title: line.title,
    values: [undefined, ...COLOR_NAMES, ...(isLevel ? [] : ["bar"])],
    show: (value) =>
      value === undefined ? `${colorTitle(THEME_COLORS[line.role])} (theme)` : colorTitle(value),
    color: true,
  };
}

const COLOR_FIELDS = COLOR_LINES.map(colorField);

/** Every setting line of the Settings tabs, in the order they show. */
export const FIELDS: readonly Field[] = [
  {
    path: "sidebar.sessionTokens",
    tab: "sidebar",
    title: "Session tokens line",
    values: SWITCH,
    show: onOff("hidden", "shown"),
  },
  runsOutField("sidebar", "under the row"),
  runsOutField("collapsed", "under the provider"),
  {
    path: "statusLine.detail",
    tab: "statusLine",
    group: "What it shows",
    title: "Show",
    values: STATUS_DETAILS,
    show: (value) => STATUS_DETAIL_TITLES[value as DisplaySettings["statusLine"]["detail"]],
  },
  runsOutField("statusLine", "after the provider"),
  {
    path: "statusLine.width",
    tab: "statusLine",
    group: "Fine-tune",
    title: "Width",
    values: [0, 40, 60, 80],
    show: (value) => (value ? `up to ${value} columns` : "all the free room"),
  },
  {
    path: "statusLine.autoScrollSeconds",
    tab: "statusLine",
    title: "Scroll by itself",
    values: [0, 5, 10],
    show: (value) => (value ? `every ${value} s` : "off"),
  },
  {
    path: "statusLine.home",
    tab: "statusLine",
    title: "Also at the bottom of Home",
    values: SWITCH,
    show: onOff("off", "on"),
  },
  {
    path: "toast.afterReply",
    tab: "toast",
    group: "Fine-tune",
    title: "After each reply",
    values: ["off", "always", "low"],
    show: (value) => (value === "low" ? "only when getting low" : String(value)),
    preset: "toast",
  },
  {
    path: "toast.afterQuestion",
    tab: "toast",
    title: "After a question to you",
    values: SWITCH,
    show: onOff("off", "on"),
    preset: "toast",
  },
  {
    path: "toast.afterCompaction",
    tab: "toast",
    title: "After compaction",
    values: SWITCH,
    show: onOff("off", "on"),
    preset: "toast",
  },
  {
    path: "toast.whenAllFail",
    tab: "toast",
    title: "When every provider fails",
    values: SWITCH,
    show: onOff("off", "on"),
    preset: "toast",
  },
  {
    path: "toast.resetNotice",
    tab: "toast",
    title: "When a limit resets",
    values: ["off", "weekly", "all"],
    show: (value) => ({ weekly: "weekly limits", all: "every limit" })[String(value)] ?? "off",
    preset: "toast",
  },
  {
    path: "toast.seconds",
    tab: "toast",
    group: "Look",
    title: "Stays on screen",
    values: [5, 9, 15, 30],
    show: (value) => `${value} s`,
  },
  {
    path: "toast.sessionTokens",
    tab: "toast",
    title: "Session tokens line",
    values: SWITCH,
    show: onOff("hidden", "shown"),
  },
  runsOutField("toast", "after the row"),
  ...COLOR_FIELDS.slice(0, 4),
  {
    path: "thresholds.warningBelow",
    tab: "colors",
    title: "'Getting low' below",
    values: THRESHOLDS,
    show: (value) => `${value}% left`,
  },
  {
    path: "thresholds.lowBelow",
    tab: "colors",
    title: "'Almost out' below",
    values: THRESHOLDS,
    show: (value) => `${value}% left`,
  },
  ...COLOR_FIELDS.slice(4),
  {
    path: "layout.bar",
    tab: "layout",
    group: "Bars",
    title: "Bar shape",
    values: BAR_SHAPES,
    show: (value) =>
      value === "none" ? "no bars" : `${barParts(value as BarShape, 60, 5).join("")} ${value}`,
  },
  {
    path: "layout.barWidth",
    tab: "layout",
    title: "Bar width",
    values: [4, 6, 8, 10, 12],
    show: (value) => `${value} columns`,
    preset: "layout",
  },
  {
    path: "layout.indent",
    tab: "layout",
    group: "Spacing",
    title: "Row indent",
    values: [0, 1, 2, 3],
    show: (value) => (value === 1 ? "1 space" : `${value} spaces`),
    preset: "layout",
  },
  {
    path: "layout.labelWidth",
    tab: "layout",
    title: "Label width",
    values: [6, 8, 10, 12],
    show: (value) => `${value} letters`,
    preset: "layout",
  },
  {
    path: "layout.providerGap",
    tab: "layout",
    title: "Between providers",
    values: [0, 1],
    show: (value) => (value ? "1 empty line" : "nothing"),
    preset: "layout",
  },
  {
    path: "layout.separator",
    tab: "layout",
    group: "Status line",
    title: "Separator",
    values: [" · ", " | ", " / ", "  "],
    show: (value) => (String(value).trim() ? `"${String(value).trim()}"` : "spaces"),
  },
];

/** The value at a field's path, for example "layout.barWidth". */
export function valueAt(settings: DisplaySettings, path: string): FieldValue {
  let value: unknown = settings;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  return value as FieldValue;
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
  let parent = next as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(parent[key])) parent[key] = {};
    parent = parent[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return next;
}

/** The value `delta` steps from `current` in `values`, wrapping; an unknown one counts as the first. */
function stepIn<T>(values: readonly T[], current: T, delta: number): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + delta + values.length) % values.length] as T;
}

/** ‹ or ›: the field's previous or next value. */
export function cycleField(
  settings: DisplaySettings,
  field: Field,
  delta: number,
): DisplaySettings {
  const next = stepIn(field.values, valueAt(settings, field.path), delta);
  return setIn(settings, field.path.split("."), next);
}

/** A typed "#89b4fa" (the # is optional); nothing typed puts the theme's color back. */
export function typedColor(settings: DisplaySettings, field: Field, text: string): DisplaySettings {
  const hex = text.trim().replace(/^#/u, "").toLowerCase();
  if (hex && !/^[0-9a-f]{6}$/u.test(hex)) return settings;
  return setIn(settings, field.path.split("."), hex ? `#${hex}` : undefined);
}

/** The preset choice whose values all match the settings; undefined is "your own". */
export function presetChoice(settings: DisplaySettings, name: PresetName): string | undefined {
  return Object.entries(PRESETS[name].choices).find(([, values]) =>
    Object.entries(values).every(([path, value]) => valueAt(settings, path) === value),
  )?.[0];
}

/** ‹ or ›: the previous or next preset choice; from "your own", the first one. */
export function cyclePreset(
  settings: DisplaySettings,
  name: PresetName,
  delta: number,
): DisplaySettings {
  const choices = PRESETS[name].choices;
  const current = presetChoice(settings, name);
  const next =
    current === undefined ? Object.keys(choices)[0] : stepIn(Object.keys(choices), current, delta);
  return Object.entries(choices[next as string] ?? {}).reduce(
    (result, [path, value]) => setIn(result, path.split("."), value),
    settings,
  );
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
  const defaults = defaultDisplaySettings();
  let next = FIELDS.filter((field) => field.tab === tab).reduce(
    (result, field) => setIn(result, field.path.split("."), valueAt(defaults, field.path)),
    settings,
  );
  if (isSurfaceTab(tab)) next = setIn(next, ["surfaces", tab], defaultSurface());
  if (tab === "collapsed" || tab === "statusLine") next = setIn(next, ["window"], {});
  return next;
}

// ---------------------------------------------------------------------------------------------
// Plugin storage: the saved settings and the draft

/** What `context.storage.store` needs from the TUI context. */
export type DisplayStorage = {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>];
};

/** The display settings on screen: the saved ones, or the draft the Settings tabs edit. */
export type DisplayStore = {
  saved(): DisplaySettings;
  /** The draft while there is one, else the saved settings. The surfaces draw these. */
  shown(): DisplaySettings;
  /**
   * Changes the draft, made whole like stored settings. The first change starts it from the
   * saved settings.
   */
  edit(change: (settings: DisplaySettings) => DisplaySettings): void;
  /** True when the draft differs from the saved settings. */
  dirty(): boolean;
  /** Stores the draft (every open TUI updates), then drops it. */
  save(): Promise<void>;
  discard(): void;
};

/**
 * The saved settings come from the live plugin store, so a surface that reads them inside its
 * JSX updates when they change (an edit in another TUI or by hand). The store opens when
 * something first reads it, never during plugin setup.
 */
export function createDisplayStore(storage: DisplayStorage): DisplayStore {
  let store:
    | readonly [StoredDisplay, (mutation: (draft: StoredDisplay) => void) => Promise<void>]
    | undefined;
  const open = () => {
    store ??= storage.store<StoredDisplay>("settings", {
      initial: { version: SETTINGS_VERSION, settings: defaultDisplaySettings() },
    });
    return store;
  };
  const [draft, setDraft] = createSignal<DisplaySettings>();
  const saved = () => readDisplaySettings(open()[0]);
  return {
    saved,
    shown: () => draft() ?? saved(),
    edit: (change) => setDraft(readDisplaySettings({ settings: change(draft() ?? saved()) })),
    dirty: () => {
      const current = draft();
      return current !== undefined && JSON.stringify(current) !== JSON.stringify(saved());
    },
    async save() {
      const next = draft();
      if (!next) return;
      await open()[1]((value) => {
        value.version = SETTINGS_VERSION;
        value.settings = JSON.parse(JSON.stringify(next));
      });
      setDraft(undefined);
    },
    discard: () => setDraft(undefined),
  };
}
