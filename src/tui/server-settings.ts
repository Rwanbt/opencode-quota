/**
 * The server settings the quota window's Words and Providers tabs edit. They live in the
 * server's settings.jsonc, because Web, Desktop and the CLI print quota too: the window reads
 * them with the `settings` RPC and saves its changes with `saveSettings`, which also switches
 * custom providers on or off. `SERVER_FIELDS` is the table of their plain lines; its `initial`
 * values are the server's defaults.
 */
import { createSignal } from "solid-js";
import type { QuotaSnapshot, Words } from "../core/types.js";
import type {
  QuotaRpcSaveSettingsInput,
  QuotaRpcSaveSettingsOutput,
  QuotaRpcSettingsOutput,
} from "../rpc.js";
import { DEFAULT_WORDS, formatDuration, percentText } from "../view/format.js";
import { stepIn } from "./display.js";

export type ServerTab = "words" | "providers";
export type ServerValue = string | number | boolean | null;
type Show = (value: ServerValue) => string;

/** A value you type instead of stepping through `values` (e, or a double-click). */
type TypedValue = {
  placeholder: string;
  /** The value of the typed text: null for nothing typed, undefined when it is not one. */
  parse: (text: string) => ServerValue | undefined;
};

/** One line of the Words or Providers tab: ‹ › step through `values`, or you type the value. */
export type ServerField = {
  /** Its dotted key in settings.jsonc, also its line id. */
  key: string;
  tab: ServerTab;
  title: string;
  initial: ServerValue;
  values: readonly ServerValue[];
  show: Show;
  group?: string;
  note?: string;
  /** The Wording line on top of the Words tab sets it. */
  preset?: true;
  typed?: TypedValue;
  /** Shown nested under this provider's tick, while it is ticked. */
  provider?: string;
};

const MINUTE_MS = 60_000;
/** A reset 2h 14m away and one 5d 3h 20m away, as each reset style writes them. */
const RESET_EXAMPLES_MS = [134 * MINUTE_MS, 7_400 * MINUTE_MS];

function field(
  key: string,
  title: string,
  initial: ServerValue,
  values: readonly ServerValue[],
  show: Show,
  options: Pick<ServerField, "group" | "note" | "preset" | "provider"> = {},
): ServerField {
  const tab = key.startsWith("words.") ? "words" : "providers";
  return { key, tab, title, initial, values, show, ...options };
}

const named =
  (names: Record<string, string>): Show =>
  (value) =>
    names[String(value)] ?? String(value);

/** Text without a leading "$" as a number that `valid` accepts; nothing typed is null. */
function typedNumber(placeholder: string, valid: (value: number) => boolean): TypedValue {
  return {
    placeholder,
    parse: (text) => {
      const trimmed = text.trim().replace(/^\$/u, "");
      if (!trimmed) return null;
      const value = Number(trimmed);
      return Number.isFinite(value) && valid(value) ? value : undefined;
    },
  };
}

/** A value typed in dollars; nothing typed puts it back to `unset`. */
function usdField(key: string, title: string, unset: string, provider: string): ServerField {
  const show: Show = (value) => (typeof value === "number" ? `$${value} a month` : unset);
  const typed = typedNumber("a dollar amount", (value) => value > 0);
  return { ...field(key, title, null, [], show, { provider }), typed };
}

const percentStyle: Show = (value) =>
  percentText({ ...DEFAULT_WORDS, percent: value as Words["percent"] }, 58, true);
const resetStyle: Show = (value) =>
  RESET_EXAMPLES_MS.map((ms) => formatDuration(ms, value as Words["reset"], 1)).join(" · ");
const decimals: Show = (value) =>
  `${value} (${formatDuration(RESET_EXAMPLES_MS[0] as number, "decimal", Number(value))})`;
const minutes: Show = (value) => `every ${Number(value) / MINUTE_MS} min`;
const seconds: Show = (value) => `after ${Number(value) / 1_000} s`;
const days: Show = (value) => (value === 1 ? "every day" : `every ${value} days`);
const onOff = named({ false: "off", true: "on" });

/** Every plain line of the Words and Providers tabs, in the order they show. */
export const SERVER_FIELDS: readonly ServerField[] = [
  field("words.percent", "Percent", "left", ["left", "remaining", "bare", "used"], percentStyle, {
    group: "Numbers",
    preset: true,
  }),
  field(
    "words.reset",
    "Reset times",
    "exact",
    ["exact", "compact", "short", "decimal"],
    resetStyle,
    {
      preset: true,
    },
  ),
  field("words.resetDecimals", "Decimals", 1, [0, 1, 2], decimals, {
    note: "for the decimal reset times",
  }),
  field(
    "words.detail",
    "Extra rows",
    "summary",
    ["summary", "detailed"],
    named({ summary: "main rows only", detailed: "all rows" }),
    { group: "What shows" },
  ),
  field(
    "words.onlyCurrentModel",
    "Providers shown",
    false,
    [false, true],
    named({ false: "all", true: "current model's only" }),
  ),
  field(
    "words.sessionTokens",
    "Session tokens count",
    "current",
    ["current", "tree"],
    named({ current: "this session", tree: "with subagents" }),
  ),
  field("words.runsOut", "Runs out in …", false, [false, true], onOff, {
    group: "Web, Desktop and CLI text",
    note: "the sidebar, status line and toasts have their own switch",
  }),
  field(
    "providers.cursor.plan",
    "Plan",
    "none",
    ["none", "pro", "pro-plus", "ultra"],
    named({ none: "none" }),
    { provider: "cursor" },
  ),
  usdField("providers.cursor.includedApiUsd", "Included API budget", "from the plan", "cursor"),
  {
    ...field(
      "providers.cursor.billingCycleStartDay",
      "Billing day",
      null,
      [],
      (value) => (typeof value === "number" ? `day ${value}` : "calendar month"),
      { provider: "cursor" },
    ),
    typed: typedNumber(
      "a day 1-28",
      (value) => Number.isInteger(value) && value >= 1 && value <= 28,
    ),
  },
  usdField("providers.opencode.monthlyLimitUsd", "Monthly budget", "not set", "opencode"),
  field(
    "checking.minIntervalMs",
    "Check for new numbers",
    300_000,
    [1, 2, 5, 10, 15, 30].map((count) => count * MINUTE_MS),
    minutes,
    { group: "Checking" },
  ),
  field(
    "checking.requestTimeoutMs",
    "Slow provider: give up",
    5_000,
    [5_000, 8_000, 12_000, 20_000, 30_000],
    seconds,
  ),
  field(
    "checking.waitForQuotaReset",
    "A model hits its limit",
    true,
    [false, true],
    named({ false: "retry like normal", true: "wait for the reset" }),
  ),
  field(
    "pricing.source",
    "Prices from",
    "auto",
    ["auto", "bundled", "runtime"],
    named({ auto: "newest list", bundled: "built-in list only", runtime: "downloaded list only" }),
    { group: "Token prices" },
  ),
  field("pricing.autoRefreshDays", "Download new prices", 7, [1, 7, 30], days),
  field("export.enabled", "Quota file (JSON)", false, [false, true], onOff, {
    group: "For other tools",
    note: "for status bars and scripts; the opencode-quota CLI works either way",
  }),
  field("telemetry.enabled", "OpenTelemetry metrics", false, [false, true], onOff),
];

/** `providers.enabled`: "auto" checks every provider quota finds, a list only those. */
export const PROVIDERS_KEY = "providers.enabled";
type Enabled = "auto" | string[];

/** The Wording line on top of the Words tab: each choice sets the two lines marked `preset`. */
export const WORDING: Readonly<Record<string, Readonly<Record<string, ServerValue>>>> = {
  normal: { "words.percent": "left", "words.reset": "exact" },
  short: { "words.percent": "bare", "words.reset": "compact" },
  "spelled out": { "words.percent": "remaining", "words.reset": "exact" },
};

/** The Wording choice whose values all match; undefined is "your own". */
export function wordingChoice(value: (key: string) => unknown): string | undefined {
  return Object.entries(WORDING).find(([, values]) =>
    Object.entries(values).every(([key, wanted]) => value(key) === wanted),
  )?.[0];
}

/** ‹ or ›: the values of the previous or next Wording choice; from "your own", the first one. */
export function steppedWording(
  value: (key: string) => unknown,
  delta: number,
): Readonly<Record<string, ServerValue>> {
  const names = Object.keys(WORDING);
  const current = wordingChoice(value);
  const next = current === undefined ? names[0] : stepIn(names, current, delta);
  return WORDING[next as string] ?? {};
}

/** The snapshot's provider ids as `providers.enabled` names them: custom providers are "custom". */
export function foundProviderIds(snapshot: QuotaSnapshot | undefined): string[] {
  return (snapshot?.providers ?? []).map(({ providerId }) =>
    providerId === "quota-providers" ? "custom" : providerId,
  );
}

/** "auto" ticks every provider quota found; a list ticks the ones it names. */
export function isTicked(enabled: Enabled, id: string, found: readonly string[]): boolean {
  return enabled === "auto" ? found.includes(id) : enabled.includes(id);
}

/** The list after ticking `id` on or off; from "auto", the ones it found are the start. */
export function withTick(
  enabled: Enabled,
  ids: readonly string[],
  found: readonly string[],
  id: string,
  on: boolean,
): string[] {
  return ids.filter((other) => (other === id ? on : isTicked(enabled, other, found)));
}

/** Changes by dotted key as the JSON merge patch `saveSettings` takes. */
export function settingsPatch(changes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split(".");
    let group = patch;
    for (const part of parts.slice(0, -1)) {
      group[part] ??= {};
      group = group[part] as Record<string, unknown>;
    }
    group[parts[parts.length - 1] as string] = value;
  }
  return patch;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `current` without the entries `sent` still holds unchanged: what was saved is no change now. */
function withoutSent<T>(
  current: Readonly<Record<string, T>>,
  sent: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(current).filter(([key, value]) => !(key in sent && same(sent[key], value))),
  );
}

/** One entry of `record` set to `value`, or removed when `value` is the saved one. */
function changed<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
  saved: unknown,
): Record<string, T> {
  const next = { ...record };
  if (same(value, saved)) delete next[key];
  else next[key] = value;
  return next;
}

export type ServerSettingsRpc = {
  settings(): Promise<QuotaRpcSettingsOutput>;
  saveSettings(input: QuotaRpcSaveSettingsInput): Promise<QuotaRpcSaveSettingsOutput>;
};

export type ServerSettings = ReturnType<typeof createServerSettings>;

/** The saved server settings, and this window's changes and custom provider switches on top. */
export function createServerSettings(rpc: ServerSettingsRpc) {
  const [saved, setSaved] = createSignal<QuotaRpcSettingsOutput>();
  const [changes, setChanges] = createSignal<Readonly<Record<string, unknown>>>({});
  const [switches, setSwitches] = createSignal<Readonly<Record<string, boolean>>>({});
  const savedValue = (key: string) => saved()?.values[key];
  const savedOn = (id: string) => saved()?.custom.find((entry) => entry.id === id)?.enabled;
  const dirty = () => Object.keys(changes()).length + Object.keys(switches()).length > 0;
  return {
    /** Undefined until the first `load` answers. */
    saved,
    value: (key: string): unknown =>
      Object.hasOwn(changes(), key) ? changes()[key] : savedValue(key),
    set(key: string, value: unknown): void {
      setChanges((current) => changed(current, key, value, savedValue(key)));
    },
    customOn: (id: string): boolean => switches()[id] ?? savedOn(id) ?? false,
    switchCustom(id: string, on: boolean): void {
      setSwitches((current) => changed(current, id, on, savedOn(id)));
    },
    dirty,
    /** The words this window changed, for the surfaces to show while you edit. */
    draftWords(): Partial<Words> {
      return Object.fromEntries(
        Object.entries(changes())
          .filter(([key]) => key.startsWith("words."))
          .map(([key, value]) => [key.slice("words.".length), value]),
      );
    },
    async load(): Promise<void> {
      setSaved(await rpc.settings());
    },
    /**
     * Sends the changes and switches in one save; nothing is saved when the server refuses any
     * of them, and the error says why. Changes made while it saves stay unsaved.
     */
    async save(): Promise<void> {
      if (!dirty()) return;
      const sentChanges = changes();
      const sentSwitches = switches();
      const result = await rpc.saveSettings({
        patch: settingsPatch(sentChanges),
        ...(Object.keys(sentSwitches).length > 0 ? { customEnabled: sentSwitches } : {}),
      });
      if (!result.ok) {
        throw new Error(result.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
      }
      setSaved(await rpc.settings());
      setChanges((current) => withoutSent(current, sentChanges));
      setSwitches((current) => withoutSent(current, sentSwitches));
    },
    discard(): void {
      setChanges({});
      setSwitches({});
    },
  };
}
