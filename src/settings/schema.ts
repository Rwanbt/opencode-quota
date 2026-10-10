/**
 * The server settings: one table of rules with their defaults. The Settings type, the defaults,
 * reading, saving and the agent tools all come from it, so a value is valid in one place exactly
 * when it is valid in the others.
 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Node } from "jsonc-parser";
import { getNodeValue } from "jsonc-parser";
import { normalizeQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import {
  describeQuotaProviderRequest,
  isMaintainedQuotaProviderTuning,
  type QuotaProviderDefinition,
  validateQuotaProviders,
} from "../lib/quota-providers.js";

type NumberBounds = { min?: number; above?: number; max?: number };
export type SettingRule = (
  | { kind: "boolean" }
  | { kind: "choice"; values: readonly string[] }
  /** `above` is an exclusive lower bound, `min` and `max` inclusive ones. */
  | ({ kind: "number"; integer: boolean; nullable?: boolean } & NumberBounds)
  /** An absolute or `~/` path without `..`; also "" or a command name when allowed. */
  | { kind: "path"; allowEmpty?: boolean; allowCommand?: boolean }
  | { kind: "providers" | "customProviders" }
) & {
  default: unknown;
  /** Only the file sets it (by hand or by an agent): `saveSettings` needs `allowFileOnly`. */
  fileOnly?: boolean;
};

const bool = (value: boolean) => ({ kind: "boolean", default: value }) as const;
const choice = <const V extends readonly string[]>(values: V, value: V[number]) =>
  ({ kind: "choice", values, default: value }) as const;
const above0 = (value: number) =>
  ({ kind: "number", integer: false, above: 0, default: value }) as const;
const whole = (min: number, max?: number) => ({ kind: "number", integer: true, min, max }) as const;
const USD = { kind: "number", integer: false, above: 0, nullable: true, default: null } as const;

/** Every setting by its dotted key with its default, in the order a new file lists them. */
export const SETTINGS_SCHEMA = {
  version: { ...whole(6, 6), default: 6 },
  /** "auto" = every provider quota finds; a list = only these (`custom` = the custom providers). */
  "providers.enabled": { kind: "providers", default: "auto" },
  "providers.custom": { kind: "customProviders", default: [], fileOnly: true },
  /** The Claude CLI quota runs for Claude limits. */
  "providers.anthropic.binaryPath": {
    kind: "path",
    allowCommand: true,
    default: "claude",
    fileOnly: true,
  },
  "providers.cursor.plan": choice(["none", "pro", "pro-plus", "ultra"], "none"),
  "providers.cursor.includedApiUsd": USD,
  "providers.cursor.billingCycleStartDay": { ...whole(1, 28), nullable: true, default: null },
  "providers.opencode.monthlyLimitUsd": USD,
  "checking.minIntervalMs": above0(300_000),
  "checking.requestTimeoutMs": above0(5_000),
  "checking.waitForQuotaReset": bool(true),
  /** The words every client uses: "58% left", "58% remaining", "58%", or "42% used". */
  "words.percent": choice(["left", "remaining", "bare", "used"], "left"),
  /** "2h 14m", "2h14m", "2h", or "2.2h" (with `resetDecimals`). */
  "words.reset": choice(["exact", "compact", "short", "decimal"], "exact"),
  "words.resetDecimals": { ...whole(0, 4), default: 1 },
  /** "detailed" also shows supplementary rows. */
  "words.detail": choice(["summary", "detailed"], "summary"),
  "words.runsOut": bool(false),
  /** Show only the providers serving the session's current model. */
  "words.onlyCurrentModel": bool(false),
  /** Session tokens of this session, or with its subagents. */
  "words.sessionTokens": choice(["current", "tree"], "current"),
  "pricing.source": choice(["auto", "bundled", "runtime"], "auto"),
  "pricing.autoRefreshDays": { ...whole(1), default: 7 },
  /** Maintainer notices; `home` shows their count on Home, once a day or every time. */
  "announcements.enabled": bool(true),
  "announcements.home": bool(true),
  "announcements.homeFrequency": choice(["daily", "always"], "daily"),
  "export.enabled": bool(false),
  /** "" = `$XDG_CACHE_HOME/opencode/quota-export.json`. */
  "export.path": { kind: "path", allowEmpty: true, default: "", fileOnly: true },
  "telemetry.enabled": bool(false),
} as const satisfies Record<string, SettingRule>;

const RULES: Readonly<Record<string, SettingRule>> = SETTINGS_SCHEMA;

type KindValue = {
  boolean: boolean;
  number: number;
  path: string;
  providers: "auto" | string[];
  customProviders: QuotaProviderDefinition[];
};
type ValueOf<R> = R extends { values: readonly (infer V)[] }
  ? V
  : R extends { nullable: true }
    ? number | null
    : R extends { kind: infer K extends keyof KindValue }
      ? KindValue[K]
      : never;
type Head<K> = K extends `${infer Group}.${string}` ? Group : K;
type Under<T, Group extends string> = {
  [K in keyof T as K extends `${Group}.${infer Rest}` ? Rest : never]: T[K];
};
/** `{ "a.b": X }` as `{ a: { b: X } }`. */
type Nest<T> = {
  [K in keyof T as Head<K>]: K extends `${infer Group}.${string}` ? Nest<Under<T, Group>> : T[K];
};
type Schema = typeof SETTINGS_SCHEMA;
export type Settings = Nest<{ -readonly [K in keyof Schema]: ValueOf<Schema[K]> }>;
type Patch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Patch<T[K]> | null }
    : T;
/** A JSON merge patch of the settings: objects merge, null resets a key or a whole group. */
export type SettingsPatch = Patch<Settings>;
export type PercentStyle = Settings["words"]["percent"];
export type ResetStyle = Settings["words"]["reset"];
export type CursorPlan = Settings["providers"]["cursor"]["plan"];

export function defaultSettings(): Settings {
  const settings = {};
  for (const [key, rule] of Object.entries(RULES)) {
    setPath(settings, key, structuredClone(rule.default));
  }
  return settings as Settings;
}

/** Every key that holds other settings, e.g. "providers" and "providers.cursor". */
const GROUPS: ReadonlySet<string> = new Set(
  Object.keys(RULES).flatMap((key) => {
    const parts = key.split(".");
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("."));
  }),
);

export function isSettingsGroup(key: string): boolean {
  return GROUPS.has(key);
}

/** Whether `key` is a file-only setting or a group that holds one. */
export function isFileOnly(key: string): boolean {
  return Object.entries(RULES).some(
    ([name, rule]) => rule.fileOnly === true && (name === key || name.startsWith(`${key}.`)),
  );
}

/** The names directly inside `group` ("" = the top level), in file order. */
export function keysUnder(group: string): string[] {
  const prefix = group ? `${group}.` : "";
  const names = Object.keys(RULES)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length).split(".")[0]);
  return [...new Set(names)];
}

/** Provider ids `providers.enabled` accepts; v5's `quota-providers` is called `custom` now. */
export const PROVIDER_IDS: readonly string[] = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) =>
  id === "quota-providers" ? "custom" : id,
);

/** A provider id or one of its aliases ("nano-gpt", "quota-providers") as `providers.enabled` keeps it. */
export function canonicalProviderId(id: string): string | undefined {
  const normalized = normalizeQuotaProviderId(id);
  const canonical = normalized === "quota-providers" ? "custom" : normalized;
  return PROVIDER_IDS.includes(canonical) ? canonical : undefined;
}

/** What a rule accepts, in words, for issue messages and the agent tools. */
export function describeRule(rule: SettingRule): string {
  switch (rule.kind) {
    case "boolean":
      return "true or false";
    case "choice":
      return `one of: ${rule.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "number": {
      const kind = rule.integer ? "a whole number" : "a number";
      const bounds =
        rule.min !== undefined && rule.max !== undefined
          ? rule.min === rule.max
            ? ` equal to ${rule.min}`
            : ` from ${rule.min} to ${rule.max}`
          : rule.above !== undefined
            ? ` above ${rule.above}`
            : rule.min !== undefined
              ? ` of at least ${rule.min}`
              : "";
      return `${rule.nullable ? "null or " : ""}${kind}${bounds}`;
    }
    case "path": {
      const or = rule.allowEmpty ? '"" or ' : rule.allowCommand ? "a command name or " : "";
      return `${or}an absolute or ~/ path without ".."`;
    }
    case "providers":
      return `"auto" or a list of: ${PROVIDER_IDS.join(", ")}`;
    case "customProviders":
      return "a list of custom provider definitions";
  }
}

export type SettingsIssue = { key: string; message: string };

/** A checked value: `value` to use when present, and what was wrong with it. */
export type CheckedSetting = { value?: unknown; issues: SettingsIssue[] };

function checkNumber(rule: Extract<SettingRule, { kind: "number" }>, value: unknown): boolean {
  if (value === null) return rule.nullable === true;
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.min === undefined || value >= rule.min) &&
    (rule.above === undefined || value > rule.above) &&
    (rule.max === undefined || value <= rule.max)
  );
}

/** An absolute or `~/` path with no `..` part, so it never depends on a working folder. */
function isSafePath(path: string): boolean {
  return (isAbsolute(path) || /^~[\\/]/u.test(path)) && !path.split(/[\\/]/u).includes("..");
}

function checkProviders(key: string, value: unknown): CheckedSetting {
  if (value === "auto") return { value, issues: [] };
  if (!Array.isArray(value)) {
    return { issues: [{ key, message: `expected ${describeRule(RULES[key])}` }] };
  }
  const known: string[] = [];
  const unknown: string[] = [];
  value.forEach((item, index) => {
    const id = typeof item === "string" ? canonicalProviderId(item) : undefined;
    // Anything but a string is named by its position, so no name inside it is repeated.
    if (id) known.push(id);
    else unknown.push(typeof item === "string" ? item : `item ${index + 1}`);
  });
  if (unknown.length === 0) return { value: [...new Set(known)], issues: [] };
  const message = `unknown provider id(s): ${unknown.join(", ")}; valid: ${PROVIDER_IDS.join(", ")}`;
  const issues = [{ key, message }];
  // Keep the ids that are right; a list of only wrong ids falls back to "auto".
  return known.length > 0 ? { value: [...new Set(known)], issues } : { issues };
}

function checkCustomProviders(key: string, value: unknown): CheckedSetting {
  const result = validateQuotaProviders(value);
  if (result.value) return { value: result.value, issues: [] };
  return {
    issues: result.issues.map((issue) => ({
      key: issue.key.replace(/^quotaProviders/u, key),
      message: issue.message,
    })),
  };
}

/** Checks one value against its rule; `key` must be in SETTINGS_SCHEMA. */
export function checkSetting(key: string, value: unknown): CheckedSetting {
  const rule = Object.hasOwn(RULES, key) ? RULES[key] : undefined;
  if (!rule) return { issues: [{ key, message: "unknown setting" }] };
  const invalid = { issues: [{ key, message: `expected ${describeRule(rule)}` }] };
  switch (rule.kind) {
    case "boolean":
      return typeof value === "boolean" ? { value, issues: [] } : invalid;
    case "choice":
      return typeof value === "string" && rule.values.includes(value)
        ? { value, issues: [] }
        : invalid;
    case "number":
      return checkNumber(rule, value) ? { value, issues: [] } : invalid;
    case "path": {
      if (typeof value !== "string") return invalid;
      const path = value.trim();
      const isCommand = rule.allowCommand === true && /^\w[\w.-]*$/u.test(path);
      const valid = path === "" ? rule.allowEmpty === true : isCommand || isSafePath(path);
      return valid ? { value: path, issues: [] } : invalid;
    }
    case "providers":
      return checkProviders(key, value);
    case "customProviders":
      return checkCustomProviders(key, value);
  }
}

/** The issue key for the top level of a file or patch, which has no settings key of its own. */
const TOP_LEVEL_KEY = "$top";

/** A name at `position` (from 1) in `group` ("" for the top level) that is not a setting. */
function unknownKeyIssue(group: string, position: number): SettingsIssue {
  const where = group ? ` in ${group}` : "";
  return {
    key: group || TOP_LEVEL_KEY,
    message: `unknown setting (key ${position}); valid${where}: ${keysUnder(group).join(", ")}`,
  };
}

/** One `key: value` a file or a patch sets, in the order it sets them. */
export type Assignment = { key: string; value: unknown };

/** How to walk a value: plain JSON values, or jsonc-parser nodes (which keep duplicate keys). */
type Walker<T> = {
  entries(value: T): Array<[string, T]> | undefined;
  leaf(value: T): unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PLAIN_WALKER: Walker<unknown> = {
  entries: (value) => (isRecord(value) ? Object.entries(value) : undefined),
  leaf: (value) => value,
};

export const NODE_WALKER: Walker<Node> = {
  entries: (node) => {
    if (node.type !== "object") return undefined;
    const pairs: Array<[string, Node]> = [];
    for (const property of node.children ?? []) {
      const [name, value] = property.children ?? [];
      // A half-written property; the parse error already says where it is.
      if (name?.type === "string" && value) pairs.push([String(name.value), value]);
    }
    return pairs;
  },
  leaf: getNodeValue,
};

/** A file sets a key twice: reading uses the last valid value, saving refuses. */
export const DUPLICATE_KEY = "duplicate key; the last valid value is used";
/** A name with a dot ("words.percent") is not read (settings nest), and saving refuses it. */
export const DOTTED_KEY = "a key with a dot is not read";

/**
 * The settings an object sets, as dotted keys in order. Unknown, duplicate and dotted keys
 * become issues; a group set to something other than an object becomes an assignment of the group
 * key, so the caller decides (an issue when reading, a reset when a patch says null). An issue
 * names a settings key, or the position of a name that is not one: a name that is not a setting
 * is never repeated, so a secret typed as a key name stays out of every message.
 */
export function flattenSettings<T>(
  walker: Walker<T>,
  value: T,
  prefix = "",
): { assignments: Assignment[]; issues: SettingsIssue[] } {
  const assignments: Assignment[] = [];
  const issues: SettingsIssue[] = [];
  const names = new Set<string>();
  for (const [index, [name, child]] of (walker.entries(value) ?? []).entries()) {
    const key = prefix ? `${prefix}.${name}` : name;
    const isSetting = Object.hasOwn(RULES, key) || GROUPS.has(key);
    if (isSetting && names.has(name)) issues.push({ key, message: DUPLICATE_KEY });
    names.add(name);
    if (name.includes(".")) {
      issues.push({
        key: prefix || TOP_LEVEL_KEY,
        message: `${DOTTED_KEY} (key ${index + 1}); nest it instead`,
      });
    } else if (Object.hasOwn(RULES, key)) {
      assignments.push({ key, value: walker.leaf(child) });
    } else if (GROUPS.has(key) && walker.entries(child)) {
      const nested = flattenSettings(walker, child, key);
      assignments.push(...nested.assignments);
      issues.push(...nested.issues);
    } else if (GROUPS.has(key)) {
      assignments.push({ key, value: walker.leaf(child) });
    } else {
      issues.push(unknownKeyIssue(prefix, index + 1));
    }
  }
  return { assignments, issues };
}

export function getSetting(settings: Settings, key: string): unknown {
  let value: unknown = settings;
  for (const part of key.split(".")) value = isRecord(value) ? value[part] : undefined;
  return value;
}

/** Sets a dotted key in a nested object, making the groups on the way. */
export function setPath(target: object, key: string, value: unknown): void {
  const parts = key.split(".");
  let group = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    group[part] ??= {};
    group = group[part] as Record<string, unknown>;
  }
  group[parts[parts.length - 1]] = value;
}

/**
 * The defaults with every valid assignment applied in order. An invalid value is reported and
 * changes nothing, so a bad value later in the file never replaces a good one before it.
 */
export function settingsFrom(assignments: readonly Assignment[]): {
  settings: Settings;
  issues: SettingsIssue[];
  fromFile: string[];
} {
  const settings = defaultSettings();
  const issues: SettingsIssue[] = [];
  const fromFile = new Set<string>();
  for (const { key, value } of assignments) {
    if (GROUPS.has(key)) {
      issues.push({ key, message: "expected an object" });
      continue;
    }
    const checked = checkSetting(key, value);
    issues.push(...checked.issues);
    if (checked.value === undefined) continue;
    setPath(settings, key, checked.value);
    fromFile.add(key);
  }
  return { settings, issues, fromFile: [...fromFile] };
}

/** Every setting whose value differs between `before` and `after`. */
export function diffSettings(
  before: Settings,
  after: Settings,
): Array<{ key: string; before: unknown; after: unknown }> {
  return Object.keys(RULES)
    .map((key) => ({ key, before: getSetting(before, key), after: getSetting(after, key) }))
    .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
}

/** A custom provider as the quota window's Providers tab shows it, with its on/off switch. */
export type CustomProviderSwitch = {
  id: string;
  label: string;
  enabled: boolean;
  /** Where it sends its key, and which key; null for a local estimate, which sends nothing. */
  request: ReturnType<typeof describeQuotaProviderRequest>;
  /** `customProviderFingerprint`: switching it on sends it back, so it is this definition. */
  fingerprint: string;
};

/** Why a custom provider is not switched on: its definition is not the one the user saw. */
export const CHANGED_SINCE_REVIEW = "changed since you reviewed it; look again";

/**
 * A hash of what the user checks before switching a custom provider on (`request`) and of the
 * fields that decide where its request goes and which key it reads.
 */
export function customProviderFingerprint(definition: QuotaProviderDefinition): string {
  const { mode, providerId } = definition;
  const sent =
    definition.mode === "remote-api" ? [definition.url, definition.apiKeyEnv ?? null] : [];
  const seen = [describeQuotaProviderRequest(definition), mode, providerId, ...sent];
  return createHash("sha256").update(JSON.stringify(seen)).digest("hex");
}

/** The settings a client shows and may change, for the quota window's Words and Providers tabs. */
export type ClientSettings = {
  /** Every setting but `version` and the file-only ones, by dotted key ("words.percent"). */
  values: Record<string, unknown>;
  /** The ids `providers.enabled` takes, with their names. */
  providers: Array<{ id: string; label: string }>;
  /** The custom providers in settings.jsonc, without the maintained tunings. */
  custom: CustomProviderSwitch[];
};

export function clientSettings(settings: Settings): ClientSettings {
  const values = Object.fromEntries(
    Object.keys(RULES)
      .filter((key) => key !== "version" && !isFileOnly(key))
      .map((key) => [key, getSetting(settings, key)]),
  );
  const providers = PROVIDER_IDS.map((id) => ({
    id,
    label:
      id === "custom"
        ? "Custom providers"
        : QUOTA_PROVIDER_CATALOG[id as keyof typeof QUOTA_PROVIDER_CATALOG].label,
  }));
  const custom = settings.providers.custom
    .filter((definition) => !isMaintainedQuotaProviderTuning(definition))
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      enabled: definition.enabled !== false,
      request: describeQuotaProviderRequest(definition),
      fingerprint: customProviderFingerprint(definition),
    }));
  return { values, providers, custom };
}
