/**
 * The server settings file, `<config>/opencode-quota/settings.jsonc` (global only). Load it
 * (defaults for what is missing or wrong), save a patch into it (comments kept), watch it for
 * edits, and convert the v5 settings into it once.
 */
import { type FSWatcher, mkdirSync, unwatchFile, watch, watchFile } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import {
  assertSameConfigWriteTarget,
  NEW_CONFIG_DIRECTORY_MODE,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "../lib/config-write-target.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import { findUnreadV5Files, planV5Conversion, type V5Conversion } from "./convert.js";
import {
  checkSetting,
  defaultSettings,
  diffSettings,
  flattenSettings,
  isSettingsGroup,
  NODE_WALKER,
  PLAIN_WALKER,
  type Settings,
  type SettingsIssue,
  settingsFrom,
} from "./schema.js";

export function settingsPath(): string {
  return join(getOpencodeRuntimeDirs().configDir, "opencode-quota", "settings.jsonc");
}

export type LoadedSettings = {
  path: string;
  /** False while settings.jsonc does not exist. */
  exists: boolean;
  settings: Settings;
  issues: SettingsIssue[];
  /** The keys the user set (in the file, or in the v5 file converted in memory); the rest are defaults. */
  fromFile: string[];
  /** Only while settings.jsonc is missing: the v5 settings, converted in memory. */
  conversion?: V5Conversion;
  /** v5 settings files that exist but are not read. */
  notRead: string[];
};

export type SettingsChange = { key: string; before: unknown; after: unknown };
export type SaveResult = { ok: boolean; issues: SettingsIssue[]; diff: SettingsChange[] };
export type SettingsWatch = { close(): void };

const NEW_FILE_HEADER = [
  "OpenCode Quota server settings. Every key is optional; a missing one uses its default.",
  "Edit it by hand or ask your agent; OpenCode Quota keeps your comments when it saves.",
];

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function parseSettingsTree(text: string): {
  root: ReturnType<typeof parseTree>;
  errors: ParseError[];
} {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  return { root, errors };
}

/** The settings a file text sets; what does not parse or check takes its default. */
function readSettingsText(text: string): Pick<LoadedSettings, "settings" | "issues" | "fromFile"> {
  const { root, errors } = parseSettingsTree(text);
  const issues = errors.map((error) => ({
    key: "$file",
    message: `syntax error on line ${lineOf(text, error.offset)}: ${printParseErrorCode(error.error)}`,
  }));
  if (root?.type !== "object") {
    issues.push({ key: "$file", message: "expected one JSON object; using the defaults" });
    return { settings: defaultSettings(), issues, fromFile: [] };
  }
  const flat = flattenSettings(NODE_WALKER, root);
  const read = settingsFrom(flat.assignments);
  return {
    settings: read.settings,
    issues: [...issues, ...flat.issues, ...read.issues],
    fromFile: read.fromFile,
  };
}

/**
 * The settings now. Without settings.jsonc: the v5 settings converted in memory when there are
 * any (this never writes; `convertV5` does), else the defaults.
 */
export async function loadSettings(options: { projectDir?: string } = {}): Promise<LoadedSettings> {
  const path = settingsPath();
  const { configDir } = getOpencodeRuntimeDirs();
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return {
        path,
        exists: true,
        settings: defaultSettings(),
        issues: [
          {
            key: "$file",
            message: `cannot read it (${errorCode(error) || errorMessage(error)}); using the defaults`,
          },
        ],
        fromFile: [],
        notRead: await findUnreadV5Files(configDir, { includeGlobal: true, ...options }),
      };
    }
  }
  if (text !== undefined) {
    return {
      path,
      exists: true,
      ...readSettingsText(text),
      notRead: await findUnreadV5Files(configDir, { includeGlobal: true, ...options }),
    };
  }
  const conversion = await planV5Conversion(configDir);
  const notRead = await findUnreadV5Files(configDir, { includeGlobal: false, ...options });
  if (!conversion) {
    return { path, exists: false, settings: defaultSettings(), issues: [], fromFile: [], notRead };
  }
  return {
    path,
    exists: false,
    settings: conversion.settings,
    issues: [],
    fromFile: conversion.fromFile,
    conversion,
    notRead,
  };
}

type Edit = { path: string[]; value: unknown };

/** `value: undefined` removes the key, so it takes its default. */
function applySettingsEdits(text: string, edits: readonly Edit[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let updated = text;
  for (const edit of edits) {
    try {
      const changes = modify(updated, edit.path, edit.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol },
      });
      updated = applyEdits(updated, changes);
    } catch (error) {
      throw new Error(
        `cannot set ${edit.path.join(".")} (${errorMessage(error)}); fix the file first`,
      );
    }
  }
  return updated;
}

function newFileText(header: readonly string[], values: Record<string, unknown>): string {
  const start = `${header.map((line) => `// ${line}`).join("\n")}\n{\n  "version": 6\n}\n`;
  const edits = Object.entries(values)
    .filter(([key]) => key !== "version")
    .map(([key, value]) => ({ path: key.split("."), value }));
  return applySettingsEdits(start, edits);
}

function convertedFileText(conversion: V5Conversion): string {
  const date = new Date().toISOString().slice(0, 10);
  return newFileText(
    [
      `OpenCode Quota server settings, converted on ${date} from:`,
      ...conversion.sources.map((source) => `  ${source}`),
      "The old file was left in place; OpenCode Quota no longer reads it.",
      "Looks (sidebar, status line, toasts) are not in this file; OpenCode keeps them.",
    ],
    conversion.values,
  );
}

/** Checks a patch and turns it into file edits; null resets a key or a whole group. */
function planEdits(patch: unknown): { edits: Edit[]; issues: SettingsIssue[] } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { edits: [], issues: [{ key: "$patch", message: "expected an object of settings" }] };
  }
  const flat = flattenSettings(PLAIN_WALKER, patch);
  const issues = [...flat.issues];
  const edits: Edit[] = [];
  for (const { key, value } of flat.assignments) {
    if (value === null) {
      edits.push({ path: key.split("."), value: undefined });
    } else if (isSettingsGroup(key)) {
      issues.push({ key, message: "expected an object, or null to reset the whole group" });
    } else {
      const checked = checkSetting(key, value);
      if (checked.issues.length > 0) issues.push(...checked.issues);
      else edits.push({ path: key.split("."), value });
    }
  }
  return { edits, issues };
}

/**
 * Merges a patch into settings.jsonc (JSON merge patch: objects merge, null resets). Every key
 * is checked first: one unknown key or bad value and nothing is saved. Comments and the rest
 * of the file stay; the write keeps a symlinked file's link and makes a new file 0600.
 */
export async function saveSettings(patch: unknown): Promise<SaveResult> {
  const planned = planEdits(patch);
  if (planned.issues.length > 0) return { ok: false, issues: planned.issues, diff: [] };
  const path = settingsPath();
  const failed = (message: string): SaveResult => ({
    ok: false,
    issues: [{ key: "$file", message }],
    diff: [],
  });
  try {
    const target = await resolveConfigWriteTarget(path);
    const original = target.terminalExisted ? await readFile(target.writePath, "utf8") : undefined;
    if (original !== undefined) {
      const firstError = parseSettingsTree(original).errors[0];
      if (firstError) {
        const line = lineOf(original, firstError.offset);
        return failed(
          `${path} has a syntax error on line ${line}; fix it first, nothing was saved`,
        );
      }
    }
    let base = original;
    if (base === undefined) {
      const conversion = await planV5Conversion(getOpencodeRuntimeDirs().configDir);
      base = conversion ? convertedFileText(conversion) : newFileText(NEW_FILE_HEADER, {});
    }
    const updated = applySettingsEdits(base, planned.edits);
    const diff = diffSettings(readSettingsText(base).settings, readSettingsText(updated).settings);
    if (updated === original) return { ok: true, issues: [], diff };

    const current = await resolveConfigWriteTarget(path);
    assertSameConfigWriteTarget(target, current);
    const currentText = current.terminalExisted
      ? await readFile(current.writePath, "utf8")
      : undefined;
    if (currentText !== original) {
      return failed(`${path} changed while saving; nothing was saved, try again`);
    }
    await writeResolvedConfigText(current, updated);
    return { ok: true, issues: [], diff };
  } catch (error) {
    return failed(`could not save ${path}: ${errorMessage(error)}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the v5 global settings into settings.jsonc once, when settings.jsonc is missing and a
 * v5 file exists. Returns undefined when there is nothing to convert. When an old file does not
 * parse (maybe mid-edit) or the folder is read-only, nothing is written: the result says why,
 * and `loadSettings` keeps converting in memory.
 */
export async function convertV5(): Promise<V5Conversion | undefined> {
  const path = settingsPath();
  if (await pathExists(path)) return undefined;
  const conversion = await planV5Conversion(getOpencodeRuntimeDirs().configDir);
  if (!conversion) return undefined;
  if (conversion.malformed) {
    return {
      ...conversion,
      notWrittenReason:
        "an old settings file does not parse; converted in memory until it is fixed",
    };
  }
  try {
    const target = await resolveConfigWriteTarget(path);
    // Another OpenCode process converted first.
    if (target.terminalExisted) return undefined;
    await writeResolvedConfigText(target, convertedFileText(conversion));
    return { ...conversion, written: true };
  } catch (error) {
    return { ...conversion, notWrittenReason: `could not write ${path}: ${errorMessage(error)}` };
  }
}

/** How often the file is also checked by its stats, in case a folder event never comes. */
const POLL_INTERVAL_MS = 2_000;

/**
 * Calls `onChange` with the new settings after the file (or, while it is missing, a v5 file)
 * changes: debounced, once per change, also when the file is replaced atomically. A folder
 * watch reacts at once; a slow stat poll of the file catches what the folder watch misses
 * (a busy macOS FSEvents, network drives, edits to a symlinked file's target). The first load
 * happens before this resolves, so only later changes count.
 */
export async function watchSettings(
  onChange: (loaded: LoadedSettings) => void,
  options: { projectDir?: string; debounceMs?: number } = {},
): Promise<SettingsWatch> {
  const path = settingsPath();
  const debounceMs = options.debounceMs ?? 200;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let lastSeen = "";
  let queue: Promise<void> = Promise.resolve();

  const reload = (notify: boolean) => {
    queue = queue
      .then(async () => {
        const loaded = await loadSettings({ projectDir: options.projectDir });
        const seen = JSON.stringify([loaded.exists, loaded.settings, loaded.issues]);
        if (seen === lastSeen) return;
        lastSeen = seen;
        if (notify && !closed) onChange(loaded);
      })
      .catch(() => {
        // A failed read is retried on the next change.
      });
    return queue;
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void reload(true), debounceMs);
  };

  try {
    mkdirSync(dirname(path), { recursive: true, mode: NEW_CONFIG_DIRECTORY_MODE });
  } catch {
    // A read-only config folder: watch what exists.
  }
  let folderWatch: FSWatcher | undefined;
  try {
    folderWatch = watch(dirname(path), { persistent: false }, schedule);
    folderWatch.on("error", () => {});
  } catch {
    // A missing or unreadable folder: the stat poll still sees the file appear.
  }
  watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, schedule);
  await reload(false);

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      folderWatch?.close();
      unwatchFile(path, schedule);
    },
  };
}
