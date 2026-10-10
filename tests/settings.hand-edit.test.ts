import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, settingsPath } from "../src/settings/index.js";

/** Runs once, while a save writes: after it read the file and before it renames over it. */
const during = vi.hoisted(() => ({ write: undefined as (() => void) | undefined }));

vi.mock("../src/lib/atomic-json.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/atomic-json.js")>();
  return {
    ...real,
    writeTextAtomic: async (...args: Parameters<typeof real.writeTextAtomic>) => {
      const write = during.write;
      during.write = undefined;
      write?.();
      return real.writeTextAtomic(...args);
    },
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-settings-hand-edit-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
});

afterEach(async () => {
  during.write = undefined;
  await rm(root, { recursive: true, force: true });
});

it("keeps a hand edit made while a save writes, and saves on top of it", async () => {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "words": { "percent": "used" } }');
  during.write = () =>
    writeFileSync(path, '{ "words": { "percent": "used", "detail": "detailed" } }');

  const result = await saveSettings({ words: { reset: "short" } });

  expect(result.ok).toBe(true);
  expect(during.write).toBeUndefined();
  expect((await loadSettings()).settings.words).toMatchObject({
    percent: "used",
    detail: "detailed",
    reset: "short",
  });
  expect(readFileSync(path, "utf8")).toContain('"detail": "detailed"');
});
