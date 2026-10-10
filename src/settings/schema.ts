/**
 * The server settings: their shape, their defaults, and one table of rules. Reading the file,
 * saving a patch and the agent tools all check values against the same table, so a value is
 * valid in one place exactly when it is valid in the others.
 */
import type { Node } from "jsonc-parser";
import { getNodeValue } from "jsonc-parser";
import { normalizeQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import { type QuotaProviderDefinition, validateQuotaProviders } from "../lib/quota-providers.js";

/** "58% left", "58% remaining", "58%", or "42% used". */
export type PercentStyle = "left" | "remaining" | "bare" | "used";
/** How a time until a reset reads: "2h 14m", "2h14m", "2h", or "2.2h". */
export type ResetStyle = "exact" | "compact" | "short" | "decimal";
export type CursorPlan = "none" | "pro" | "pro-plus" | "ultra";

export type Settings = {
  version: 6;
  providers: {
    /** "auto" = every provider quota finds; a list = only these (`custom` = the custom providers). */
    enabled: "auto" | string[];
    /** Custom providers (file only: an agent or a person edits them). */
    custom: QuotaProviderDefinition[];
    /** The Claude CLI quota runs for Claude limits (file only). */
    anthropic: { binaryPath: string };
    cursor: {
      plan: CursorPlan;
      includedApiUsd: number | null;
      billingCycleStartDay: number | null;
    };
    opencode: { monthlyLimitUsd: number | null };
  };
  checking: { minIntervalMs: number; requestTimeoutMs: number; waitForQuotaReset: boolean };
  /** The words every client uses (TUI, Web, Desktop, CLI). */
  words: {
    percent: PercentStyle;
    reset: ResetStyle;
    /** Decimals of the "decimal" reset style. */
    resetDecimals: number;
    /** "detailed" also shows supplementary rows. */
    detail: "summary" | "detailed";
    runsOut: boolean;
    /** Show only the providers serving the session's current model. */
    onlyCurrentModel: boolean;
    /** Session tokens of this session, or with its subagents. */
    sessionTokens: "current" | "tree";
  };
  pricing: { source: "auto" | "bundled" | "runtime"; autoRefreshDays: number };
  /** Maintainer notices; `home` shows their count on Home, once a day or every time. */
  announcements: { enabled: boolean; home: boolean; homeFrequency: "daily" | "always" };
  /** `path` is file only; "" = `$XDG_CACHE_HOME/opencode/quota-export.json`. */
  export: { enabled: boolean; path: string };
  telemetry: { enabled: boolean };
};

export function defaultSettings(): Settings {
  return {
    version: 6,
    providers: {
      enabled: "auto",
      custom: [],
      anthropic: { binaryPath: "claude" },
      cursor: { plan: "none", includedApiUsd: null, billingCycleStartDay: null },
      opencode: { monthlyLimitUsd: null },
    },
    checking: { minIntervalMs: 300_000, requestTimeoutMs: 5_000, waitForQuotaReset: true },
    words: {
      percent: "left",
      reset: "exact",
      resetDecimals: 1,
      detail: "summary",
      runsOut: false,
      onlyCurrentModel: false,
      sessionTokens: "current",
    },
    pricing: { source: "auto", autoRefreshDays: 7 },
    announcements: { enabled: true, home: true, homeFrequency: "daily" },
    export: { enabled: false, path: "" },
    telemetry: { enabled: false },
  };
}

export type SettingRule =
  | { kind: "boolean" }
  | { kind: "choice"; values: readonly string[] }
  /** `above` is an exclusive lower bound, `min` and `max` inclusive ones. */
  | {
      kind: "number";
      integer: boolean;
      min?: number;
      above?: number;
      max?: number;
      nullable?: boolean;
    }
  | { kind: "text"; allowEmpty: boolean }
  | { kind: "providers" }
  | { kind: "customProviders" };

const BOOLEAN: SettingRule = { kind: "boolean" };
const ABOVE_ZERO: SettingRule = { kind: "number", integer: false, above: 0 };
const OPTIONAL_ABOVE_ZERO: SettingRule = {
  kind: "number",
  integer: false,
  above: 0,
  nullable: true,
};

function choice(...values: string[]): SettingRule {
  return { kind: "choice", values };
}

/** Every setting by its dotted key, in the order a new file lists them. */
export const SETTINGS_SCHEMA: Readonly<Record<string, SettingRule>> = {
  version: { kind: "number", integer: true, min: 6, max: 6 },
  "providers.enabled": { kind: "providers" },
  "providers.custom": { kind: "customProviders" },
  "providers.anthropic.binaryPath": { kind: "text", allowEmpty: false },
  "providers.cursor.plan": choice("none", "pro", "pro-plus", "ultra"),
  "providers.cursor.includedApiUsd": OPTIONAL_ABOVE_ZERO,
  "providers.cursor.billingCycleStartDay": {
    kind: "number",
    integer: true,
    min: 1,
    max: 28,
    nullable: true,
  },
  "providers.opencode.monthlyLimitUsd": OPTIONAL_ABOVE_ZERO,
  "checking.minIntervalMs": ABOVE_ZERO,
  "checking.requestTimeoutMs": ABOVE_ZERO,
  "checking.waitForQuotaReset": BOOLEAN,
  "words.percent": choice("left", "remaining", "bare", "used"),
  "words.reset": choice("exact", "compact", "short", "decimal"),
  "words.resetDecimals": { kind: "number", integer: true, min: 0, max: 4 },
  "words.detail": choice("summary", "detailed"),
  "words.runsOut": BOOLEAN,
  "words.onlyCurrentModel": BOOLEAN,
  "words.sessionTokens": choice("current", "tree"),
  "pricing.source": choice("auto", "bundled", "runtime"),
  "pricing.autoRefreshDays": { kind: "number", integer: true, min: 1 },
  "announcements.enabled": BOOLEAN,
  "announcements.home": BOOLEAN,
  "announcements.homeFrequency": choice("daily", "always"),
  "export.enabled": BOOLEAN,
  "export.path": { kind: "text", allowEmpty: true },
  "telemetry.enabled": BOOLEAN,
};

/** Every key that holds other settings, e.g. "providers" and "providers.cursor". */
const GROUPS: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SCHEMA).flatMap((key) => {
    const parts = key.split(".");
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("."));
  }),
);

export function isSettingsGroup(key: string): boolean {
  return GROUPS.has(key);
}

/** The names directly inside `group` ("" = the top level), in file order. */
export function keysUnder(group: string): string[] {
  const prefix = group ? `${group}.` : "";
  const names = Object.keys(SETTINGS_SCHEMA)
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
    case "text":
      return rule.allowEmpty ? "a text" : "a non-empty text";
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

function checkProviders(key: string, value: unknown): CheckedSetting {
  if (value === "auto") return { value, issues: [] };
  if (!Array.isArray(value)) {
    return { issues: [{ key, message: `expected ${describeRule({ kind: "providers" })}` }] };
  }
  const known: string[] = [];
  const unknown: string[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? canonicalProviderId(item) : undefined;
    if (id) known.push(id);
    else unknown.push(typeof item === "string" ? item : JSON.stringify(item));
  }
  if (unknown.length === 0) return { value: [...new Set(known)], issues: [] };
  const issues = [
    {
      key,
      message: `unknown provider id(s): ${unknown.join(", ")}; valid: ${PROVIDER_IDS.join(", ")}`,
    },
  ];
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
  const rule = Object.hasOwn(SETTINGS_SCHEMA, key) ? SETTINGS_SCHEMA[key] : undefined;
  if (!rule) return { issues: [unknownKeyIssue(key)] };
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
    case "text": {
      if (typeof value !== "string") return invalid;
      if (rule.allowEmpty) return { value, issues: [] };
      const trimmed = value.trim();
      return trimmed ? { value: trimmed, issues: [] } : invalid;
    }
    case "providers":
      return checkProviders(key, value);
    case "customProviders":
      return checkCustomProviders(key, value);
  }
}

export function unknownKeyIssue(key: string): SettingsIssue {
  const group = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "";
  const where = group ? ` in ${group}` : "";
  return { key, message: `unknown setting; valid${where}: ${keysUnder(group).join(", ")}` };
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

/**
 * The settings an object sets, as dotted keys in order. Unknown keys become issues; a group
 * set to something other than an object becomes an assignment of the group key, so the
 * caller decides (an issue when reading, a reset when a patch says null).
 */
export function flattenSettings<T>(
  walker: Walker<T>,
  value: T,
  prefix = "",
): { assignments: Assignment[]; issues: SettingsIssue[] } {
  const assignments: Assignment[] = [];
  const issues: SettingsIssue[] = [];
  for (const [name, child] of walker.entries(value) ?? []) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (Object.hasOwn(SETTINGS_SCHEMA, key)) {
      assignments.push({ key, value: walker.leaf(child) });
    } else if (GROUPS.has(key) && walker.entries(child)) {
      const nested = flattenSettings(walker, child, key);
      assignments.push(...nested.assignments);
      issues.push(...nested.issues);
    } else if (GROUPS.has(key)) {
      assignments.push({ key, value: walker.leaf(child) });
    } else {
      issues.push(unknownKeyIssue(key));
    }
  }
  return { assignments, issues };
}

export function getSetting(settings: Settings, key: string): unknown {
  let value: unknown = settings;
  for (const part of key.split(".")) value = isRecord(value) ? value[part] : undefined;
  return value;
}

function setSetting(settings: Settings, key: string, value: unknown): void {
  const parts = key.split(".");
  const name = parts[parts.length - 1];
  let group = settings as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) group = group[part] as Record<string, unknown>;
  group[name] = value;
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
    setSetting(settings, key, checked.value);
    fromFile.add(key);
  }
  return { settings, issues, fromFile: [...fromFile] };
}

/** Every setting whose value differs between `before` and `after`. */
export function diffSettings(
  before: Settings,
  after: Settings,
): Array<{ key: string; before: unknown; after: unknown }> {
  return Object.keys(SETTINGS_SCHEMA)
    .map((key) => ({ key, before: getSetting(before, key), after: getSetting(after, key) }))
    .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
}
