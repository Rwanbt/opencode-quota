/**
 * A lock file next to a file that several OpenCode processes change: it holds its owner's pid
 * and a random token. Only one process at a time creates it; a lock whose owner is gone is taken
 * over in one atomic rename, and a live owner is never robbed. The settings file and the notice
 * read state use it, so a read, change and write never interleaves with another one.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_FILE_MODE = 0o600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "";

/** What a lock file of this process holds: our pid and a token of our own. */
export function lockOwnerText(token: string): string {
  return JSON.stringify({ pid: process.pid, token });
}

/** Creates `path` holding `text`; false when it already exists. */
export async function createExclusive(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: "wx", mode: LOCK_FILE_MODE });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

type LockFile = { text: string; mtimeMs: number };

async function readLock(path: string): Promise<LockFile | undefined> {
  const stats = await lstat(path).catch(() => undefined);
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
 * Takes over an abandoned lock in one atomic step, a rename: only one waiter's rename finds it.
 * A lock renamed that is not the one seen abandoned (another waiter just took it) goes back.
 */
export async function claimAbandoned(lock: string, token: string): Promise<void> {
  const seen = await readLock(lock);
  if (!seen || !isAbandoned(seen)) return;
  const claimed = `${lock}.stale-${token}`;
  const lost = await rename(lock, claimed).catch(() => true);
  if (lost) return; // Another waiter renamed it first.
  const got = await readLock(claimed);
  if (got && (got.text !== seen.text || got.mtimeMs !== seen.mtimeMs)) {
    await createExclusive(lock, got.text);
  }
  await rm(claimed, { force: true });
}

/** Removes the lock only while it is still ours. */
export async function releaseLock(lock: string, mine: string): Promise<void> {
  if ((await readFile(lock, "utf8").catch(() => "")) === mine) await rm(lock, { force: true });
}

/**
 * Runs `work` while holding the lock file `lock`, making its folder (mode 700) first. After
 * `waitMs` without the lock it fails with `busyMessage`.
 */
export async function withFileLock<T>(
  lock: string,
  work: () => Promise<T>,
  options: { waitMs: number; busyMessage: string },
): Promise<T> {
  const token = randomUUID();
  const mine = lockOwnerText(token);
  const start = Date.now();
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    if (await createExclusive(lock, mine)) {
      try {
        return await work();
      } finally {
        await releaseLock(lock, mine);
      }
    }
    await claimAbandoned(lock, token);
    if (Date.now() - start > options.waitMs) throw new Error(options.busyMessage);
    await sleep(20);
  }
}
