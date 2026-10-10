/**
 * The server settings file, `<config>/opencode-quota/settings.jsonc` (global only). Load it
 * (defaults for what is missing or wrong), save a patch into it (comments kept), watch it for
 * edits, and convert the v5 settings into it once.
 */
import { randomUUID } from "node:crypto";
import { type FSWatcher, type Stats, unwatchFile, watch, watchFile } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyEdits, modify, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";
import { writeTextAtomic } from "../lib/atomic-json.js";
import {
  assertSameConfigWriteTarget,
  type ConfigWriteTargetSnapshot,
  NEW_CONFIG_DIRECTORY_MODE,
  NEW_CONFIG_FILE_MODE,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "../lib/config-write-target.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import {
  type DisplayImport,
  findUnreadV5Files,
  planV5Conversion,
  type V5Conversion,
} from "./convert.js";
import {
  checkSetting,
  DOTTED_KEY,
  DUPLICATE_KEY,
  defaultSettings,
  diffSettings,
  flattenSettings,
  isFileOnly,
  isSettingsGroup,
  NODE_WALKER,
  PLAIN_WALKER,
  type Settings,
  type SettingsIssue,
  type SettingsPatch,
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

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "";
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/** The settings a file text sets; what does not parse or check takes its default. */
function readSettingsText(text: string): Pick<LoadedSettings, "settings" | "issues" | "fromFile"> {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
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
  return { ...read, issues: [...issues, ...flat.issues, ...read.issues] };
}

/**
 * The settings now. Without settings.jsonc: the v5 settings converted in memory when there are
 * any (this never writes; `convertV5` does), else the defaults.
 */
export async function loadSettings(options: { projectDir?: string } = {}): Promise<LoadedSettings> {
  const path = settingsPath();
  const { configDir } = getOpencodeRuntimeDirs();
  let read: Pick<LoadedSettings, "settings" | "issues" | "fromFile"> | undefined;
  try {
    read = readSettingsText(await readFile(path, "utf8"));
  } catch (error) {
    const reason = errorCode(error) || errorMessage(error);
    const issue = { key: "$file", message: `cannot read it (${reason}); using the defaults` };
    if (reason !== "ENOENT") read = { settings: defaultSettings(), issues: [issue], fromFile: [] };
  }
  if (read) {
    const notRead = await findUnreadV5Files(configDir, { includeGlobal: true, ...options });
    return { path, exists: true, ...read, notRead };
  }
  const conversion = await planV5Conversion(configDir);
  const notRead = await findUnreadV5Files(configDir, { includeGlobal: false, ...options });
  if (!conversion) {
    return { path, exists: false, settings: defaultSettings(), issues: [], fromFile: [], notRead };
  }
  const { settings, fromFile } = conversion;
  return { path, exists: false, settings, issues: [], fromFile, conversion, notRead };
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

function newFileText(header = NEW_FILE_HEADER, values: Record<string, unknown> = {}): string {
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
      ...conversion.notes,
      "The old file was left in place; OpenCode Quota no longer reads it.",
      "Looks (sidebar, status line, toasts) are not in this file; OpenCode keeps them.",
    ],
    conversion.values,
  );
}

/**
 * Checks a patch and turns it into file edits; null resets a key or a whole group. File-only
 * keys (and groups holding one) need `allowFileOnly`.
 */
function planEdits(
  patch: unknown,
  allowFileOnly: boolean,
): { edits: Edit[]; issues: SettingsIssue[] } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { edits: [], issues: [{ key: "$patch", message: "expected an object of settings" }] };
  }
  const flat = flattenSettings(PLAIN_WALKER, patch);
  const issues = [...flat.issues];
  const edits: Edit[] = [];
  for (const { key, value } of flat.assignments) {
    if (!allowFileOnly && isFileOnly(key)) {
      issues.push({ key, message: "file-only; edit settings.jsonc by hand or ask your agent" });
    } else if (value === null) {
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

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lock sits next to the file a save writes: a symlink's real target, else settings.jsonc. */
async function settingsLockPath(path: string): Promise<string> {
  const real = await realpath(path).catch(async () => {
    await mkdir(dirname(path), { recursive: true, mode: NEW_CONFIG_DIRECTORY_MODE });
    return join(await realpath(dirname(path)), basename(path));
  });
  return `${real}.lock`;
}

/** Creates `path` holding `text`; false when it already exists. */
async function createExclusive(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: "wx", mode: NEW_CONFIG_FILE_MODE });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

type LockFile = { text: string; mtimeMs: number };

async function readLock(path: string): Promise<LockFile | undefined> {
  const stats = await stat(path).catch(() => undefined);
  return stats && { text: await readFile(path, "utf8").catch(() => ""), mtimeMs: stats.mtimeMs };
}

/** Its owner is gone: the process it names died, or it names none and is older than 10 s. */
function isAbandoned(lock: LockFile): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(lock.text) as { pid?: unknown }).pid;
  } catch {
    // Empty or unreadable: only its age tells.
  }
  if (!(typeof pid === "number" && Number.isInteger(pid) && pid > 0)) {
    return Date.now() - lock.mtimeMs > LOCK_STALE_MS;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

/**
 * Removes an abandoned lock. One waiter at a time (a short-lived guard file), and only while it
 * is still the abandoned one, so a lock another waiter just took is never removed.
 */
async function removeAbandoned(lock: string): Promise<void> {
  const seen = await readLock(lock);
  if (!seen || !isAbandoned(seen)) return;
  const guard = `${lock}.takeover`;
  const guardAge = Date.now() - ((await readLock(guard))?.mtimeMs ?? Date.now());
  if (guardAge > LOCK_STALE_MS) await rm(guard, { force: true }); // left by a crash
  if (!(await createExclusive(guard, ""))) return;
  try {
    const now = await readLock(lock);
    if (now?.text === seen.text && now.mtimeMs === seen.mtimeMs) await rm(lock, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

/** Removes the lock only while it is still ours. */
async function releaseLock(lock: string, mine: string): Promise<void> {
  if ((await readFile(lock, "utf8").catch(() => "")) === mine) await rm(lock, { force: true });
}

/**
 * Runs `work` holding the settings lock (a file with our pid and a token), so saves, the
 * conversion and the display import never interleave. A live owner is never robbed: after
 * LOCK_WAIT_MS this fails as busy.
 */
async function withSettingsLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const mine = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const start = Date.now();
  for (;;) {
    const lock = await settingsLockPath(path);
    if (await createExclusive(lock, mine)) {
      // A link moved while we waited: this lock no longer guards the file a save writes.
      if ((await settingsLockPath(path)) === lock) {
        try {
          return await work();
        } finally {
          await releaseLock(lock, mine);
        }
      }
      await releaseLock(lock, mine);
    } else {
      await removeAbandoned(lock);
    }
    if (Date.now() - start > LOCK_WAIT_MS) {
      throw new Error(`the settings file is busy: another save holds ${lock}; try again`);
    }
    await sleep(20);
  }
}

function displayImportPath(): string {
  return join(getOpencodeRuntimeDirs().stateDir, "opencode-quota", "display-import.json");
}

/** The v5 looks a conversion found, with the id `acknowledgeDisplayImport` takes. */
export type PendingDisplayImport = { id: string; display: DisplayImport };

/** Keeps the v5 looks under a new id until the TUI acknowledges it (the caller holds the lock). */
async function keepDisplayImport(display: DisplayImport): Promise<void> {
  if (Object.keys(display).length === 0) return;
  const pending: PendingDisplayImport = { id: randomUUID(), display };
  await writeTextAtomic(displayImportPath(), `${JSON.stringify(pending, null, 2)}\n`, {
    policy: "configuration",
    directoryMode: NEW_CONFIG_DIRECTORY_MODE,
    fileMode: NEW_CONFIG_FILE_MODE,
  });
}

/** The v5 looks the TUI has not acknowledged yet. */
export async function pendingDisplayImport(): Promise<PendingDisplayImport | undefined> {
  try {
    return JSON.parse(await readFile(displayImportPath(), "utf8")) as PendingDisplayImport;
  } catch {
    return undefined;
  }
}

/** The TUI applied the looks with this id: forget them, but never a newer import. */
export async function acknowledgeDisplayImport(id: string): Promise<void> {
  await withSettingsLock(settingsPath(), async () => {
    if ((await pendingDisplayImport())?.id === id) await rm(displayImportPath(), { force: true });
  });
}

type SettingsEdit = (current: Settings) => SettingsPatch | undefined;

/**
 * Merges a patch into settings.jsonc (JSON merge patch: objects merge, null resets). One unknown
 * key or bad value and nothing is saved. Comments stay; a symlink keeps its link; the file is 0600.
 */
export async function saveSettings(
  patch: unknown,
  options: { allowFileOnly?: boolean } = {},
): Promise<SaveResult> {
  return editSettings(() => patch as SettingsPatch, options);
}

/**
 * Like `saveSettings`, with the patch built from the settings it saves over: read, `edit`, check
 * and write all hold the lock, so an edit made from the current value never loses a concurrent
 * one. `edit` returns undefined to change nothing.
 */
export async function editSettings(
  edit: SettingsEdit,
  options: { allowFileOnly?: boolean } = {},
): Promise<SaveResult> {
  const path = settingsPath();
  try {
    return await withSettingsLock(path, () =>
      editLocked(path, edit, options.allowFileOnly === true),
    );
  } catch (error) {
    return failedSave(`could not save ${path}: ${errorMessage(error)}`);
  }
}

function failedSave(message: string): SaveResult {
  return { ok: false, issues: [{ key: "$file", message }], diff: [] };
}

function readTarget(target: ConfigWriteTargetSnapshot): Promise<string | undefined> {
  return target.terminalExisted ? readFile(target.writePath, "utf8") : Promise.resolve(undefined);
}

async function editLocked(path: string, edit: SettingsEdit, allowFileOnly: boolean) {
  const target = await resolveConfigWriteTarget(path);
  const original = await readTarget(target);
  // A syntax error, or a key set twice or with a dot (an edit would change another one).
  const blocking = readSettingsText(original ?? "{}").issues.find(
    (issue) => issue.key === "$file" || [DUPLICATE_KEY, DOTTED_KEY].includes(issue.message),
  );
  if (blocking) {
    const where = blocking.key === "$file" ? "" : `${blocking.key}: `;
    const problem = `${where}${blocking.message.split(";")[0]}`;
    return failedSave(`${path}: ${problem}; fix it first, nothing was saved`);
  }
  // Without settings.jsonc the v5 settings are converted first; what could not be is reported.
  const { configDir } = getOpencodeRuntimeDirs();
  const conversion = original === undefined ? await planV5Conversion(configDir) : undefined;
  const base =
    original ?? (conversion?.sources.length ? convertedFileText(conversion) : newFileText());
  const before = readSettingsText(base).settings;
  const patch = edit(structuredClone(before));
  if (patch === undefined) return { ok: true, issues: [], diff: [] };
  const planned = planEdits(patch, allowFileOnly);
  if (planned.issues.length > 0) return { ok: false, issues: planned.issues, diff: [] };
  const updated = applySettingsEdits(base, planned.edits);
  const diff = diffSettings(before, readSettingsText(updated).settings);
  const issues = (conversion?.notes ?? []).map((message) => ({ key: "$conversion", message }));
  if (updated === original) return { ok: true, issues, diff };

  const latest = await resolveConfigWriteTarget(path);
  assertSameConfigWriteTarget(target, latest);
  if ((await readTarget(latest)) !== original) {
    return failedSave(`${path} changed while saving; nothing was saved, try again`);
  }
  if (conversion) await keepDisplayImport(conversion.displayImport);
  await writeResolvedConfigText(latest, updated);
  await chmod(latest.writePath, NEW_CONFIG_FILE_MODE);
  return { ok: true, issues, diff };
}

/**
 * Writes the v5 global settings into a missing settings.jsonc once (undefined: nothing to do).
 * While an old file does not parse (maybe mid-edit) or the folder is read-only, nothing is
 * written: the result says why, and `loadSettings` keeps converting in memory.
 */
export async function convertV5(): Promise<V5Conversion | undefined> {
  const path = settingsPath();
  if (await lstat(path).catch(() => undefined)) return undefined;
  const conversion = await planV5Conversion(getOpencodeRuntimeDirs().configDir);
  if (!conversion) return undefined;
  const malformed = "an old settings file does not parse; converted in memory until it is fixed";
  if (conversion.malformed) return { ...conversion, notWrittenReason: malformed };
  try {
    return await withSettingsLock(path, async () => {
      const target = await resolveConfigWriteTarget(path);
      // Another OpenCode process converted first.
      if (target.terminalExisted) return undefined;
      await keepDisplayImport(conversion.displayImport);
      await writeResolvedConfigText(target, convertedFileText(conversion));
      await chmod(target.writePath, NEW_CONFIG_FILE_MODE);
      return { ...conversion, written: true };
    });
  } catch (error) {
    return { ...conversion, notWrittenReason: `could not write ${path}: ${errorMessage(error)}` };
  }
}

const POLL_INTERVAL_MS = 2_000;

/**
 * Calls `onChange` once per change of settings.jsonc (v5 files are not watched), debounced, also
 * for an atomic replace. A folder watch reacts at once; a stat poll catches what it misses (busy
 * FSEvents, network drives, a symlink's target). Only changes after this resolves count.
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

  // Only settings.jsonc (or its target, when a link points into this folder), never a v5 file.
  const names = new Set([basename(path), basename(await realpath(path).catch(() => path))]);
  const reload = (notify: boolean) => {
    queue = queue
      .then(async () => {
        if (closed) return;
        const loaded = await loadSettings({ projectDir: options.projectDir });
        const { exists, settings, issues, fromFile, conversion } = loaded;
        const seen = JSON.stringify([exists, settings, issues, fromFile, conversion]);
        if (seen === lastSeen) return;
        lastSeen = seen;
        if (notify && !closed) onChange(loaded);
      })
      .catch(() => {}); // A failed read is retried on the next change.
    return queue;
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void reload(true), debounceMs);
  };
  // A poll also reports a missing file once, and an access time change; neither is an edit.
  const onStat = (now: Stats, before: Stats) => {
    if (now.mtimeMs !== before.mtimeMs || now.ino !== before.ino) schedule();
  };

  // In a read-only config folder, watch what exists.
  await mkdir(dirname(path), { recursive: true, mode: NEW_CONFIG_DIRECTORY_MODE }).catch(() => {});
  let folderWatch: FSWatcher | undefined;
  try {
    folderWatch = watch(dirname(path), { persistent: false }, (_, name) => {
      if (!name || names.has(name)) schedule();
    });
    folderWatch.on("error", () => {});
  } catch {
    // A missing or unreadable folder: the stat poll still sees the file appear.
  }
  watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, onStat);
  await reload(false);

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      folderWatch?.close();
      unwatchFile(path, onStat);
    },
  };
}
