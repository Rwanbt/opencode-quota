/**
 * The TUI's display settings: what the sidebar, status line, toasts and `/quota` show and how
 * they look.
 * They live only in OpenCode's plugin storage (`context.storage.store("settings")`), which
 * OpenCode saves atomically, keeps across restarts and syncs to every open TUI. The words
 * (percent style, reset style, …) are the server's and come with the snapshot.
 */
import { isQuotaWindow } from "../core/windows.js";
import type { DisplayImport } from "../settings/index.js";
import type { BarShape } from "../view/format.js";
import type { RowSettings, Surface, SurfaceRows, WindowChoice } from "../view/select.js";
import type { ColorRole, Layout, StatusLevel } from "../view/text.js";

/** Bump when the stored shape changes, and teach `readDisplaySettings` the old one. */
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
   * detail "one" = v5's prompt bar: only the first provider, with a big bar. home = at the
   * bottom of Home, whether or not it shows in sessions (`surfaces.statusLine.enabled`).
   */
  statusLine: {
    width: number;
    detail: StatusLevel | "auto" | "one";
    autoScrollSeconds: number;
    home: boolean;
  };
  sidebar: { sessionTokens: boolean };
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

const COLOR_NAMES: readonly ColorName[] = [
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
    toast: {
      afterReply: "off",
      afterQuestion: false,
      afterCompaction: true,
      whenAllFail: true,
      resetNotice: "off",
      seconds: 9,
      sessionTokens: true,
    },
    quickLook: "dialog",
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
    hidden: isStringList(stored.hidden) ? stored.hidden : [],
    providerOrder: isStringList(stored.providerOrder) ? stored.providerOrder : [],
    rowOrder: recordOf(stored.rowOrder, isStringList),
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
      (Object.keys(defaults.surfaces) as Surface[]).map((surface) => [
        surface,
        readSurface(surfaces[surface]),
      ]),
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
    toast: {
      afterReply: oneOf(toast.afterReply, ["off", "always", "low"], defaults.toast.afterReply),
      afterQuestion: flag(toast.afterQuestion, defaults.toast.afterQuestion),
      afterCompaction: flag(toast.afterCompaction, defaults.toast.afterCompaction),
      whenAllFail: flag(toast.whenAllFail, defaults.toast.whenAllFail),
      resetNotice: oneOf(toast.resetNotice, ["off", "weekly", "all"], defaults.toast.resetNotice),
      seconds: wholeNumber(toast.seconds, 1, 120, defaults.toast.seconds),
      sessionTokens: flag(toast.sessionTokens, defaults.toast.sessionTokens),
    },
    quickLook: oneOf(settings.quickLook, QUICK_LOOK_FORMS, defaults.quickLook),
  };
}

/** What `context.storage.store` needs from the TUI context. */
export type DisplayStorage = {
  store<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [Value, (mutation: (draft: Value) => void) => Promise<void>];
};

/**
 * The saved display settings, read from plugin storage. The function reads the live store,
 * so a surface that calls it inside its JSX updates when the settings change (an edit in
 * another TUI or by hand).
 */
export function loadDisplaySettings(storage: DisplayStorage): () => DisplaySettings {
  const [stored] = storage.store<StoredDisplay>("settings", { initial: NOTHING_SAVED });
  return () => readDisplaySettings(stored);
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
