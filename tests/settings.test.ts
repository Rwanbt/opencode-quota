import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  type LoadedSettings,
  loadSettings,
  saveSettings,
  settingsPath,
  watchSettings,
} from "../src/settings/index.js";
import { VALID_QUOTA_PROVIDER_INPUTS, VALID_QUOTA_PROVIDERS } from "./fixtures/quota-providers.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-settings-"));
  configDir = join(root, "config");
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeSettings(text: string): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** `{ "a": { "b": value } }` for the key "a.b". */
function nested(key: string, value: unknown): unknown {
  return key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value);
}

function valueAt(settings: object, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], settings);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > 5_000) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("settingsPath", () => {
  it.each([
    {
      name: "OPENCODE_CONFIG_DIR wins",
      env: { OPENCODE_CONFIG_DIR: "a", XDG_CONFIG_HOME: "b" },
      expected: ["a", "opencode-quota", "settings.jsonc"],
    },
    {
      name: "else XDG_CONFIG_HOME/opencode, never ~/.config",
      env: { OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "b" },
      expected: ["b", "opencode", "opencode-quota", "settings.jsonc"],
    },
  ])("$name", ({ env, expected }) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value ? join(root, value) : "");
    }
    expect(settingsPath()).toBe(join(root, ...expected));
  });
});

describe("loadSettings", () => {
  it("uses the defaults when the file is missing and writes nothing", async () => {
    const loaded = await loadSettings();

    expect(loaded).toMatchObject({ exists: false, issues: [], fromFile: [], notRead: [] });
    expect(loaded.settings).toEqual(defaultSettings());
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("reads comments and trailing commas, and knows which keys the file set", async () => {
    writeSettings(`// my settings
{
  "version": 6,
  /* words */ "words": { "percent": "used", "reset": "short", },
  "checking": { "requestTimeoutMs": 9000 },
  "providers": { "enabled": ["nano-gpt", "quota-providers"], "cursor": { "includedApiUsd": 20 } },
}
`);

    const loaded = await loadSettings();

    expect(loaded.issues).toEqual([]);
    expect(loaded.settings.words).toMatchObject({ percent: "used", reset: "short" });
    expect(loaded.settings.providers.enabled).toEqual(["nanogpt", "custom"]);
    expect(loaded.settings.providers.cursor.includedApiUsd).toBe(20);
    // Providers with a longer own timeout use it unless the user set one.
    expect(loaded.fromFile).toContain("checking.requestTimeoutMs");
    expect(loaded.fromFile).not.toContain("checking.minIntervalMs");
  });

  it.each([
    ["words.percent", "huge"],
    ["checking.minIntervalMs", 0],
    ["providers.cursor.billingCycleStartDay", 29],
    ["words.resetDecimals", 1.5],
    ["announcements.home", "yes"],
    ["providers.anthropic.binaryPath", "  "],
    ["providers.enabled", ["nope"]],
    ["version", 7],
  ])("an invalid %s keeps its default and is reported", async (key, value) => {
    writeSettings(JSON.stringify(nested(key, value)));

    const loaded = await loadSettings();

    expect(valueAt(loaded.settings, key)).toEqual(valueAt(defaultSettings(), key));
    expect(loaded.issues.map((issue) => issue.key)).toEqual([key]);
    expect(loaded.fromFile).not.toContain(key);
  });

  it("never lets a bad later value replace a good one", async () => {
    writeSettings('{ "words": { "percent": "used", "percent": "huge" } }');

    const loaded = await loadSettings();

    expect(loaded.settings.words.percent).toBe("used");
    expect(loaded.issues).toEqual([
      { key: "words.percent", message: 'expected one of: "left", "remaining", "bare", "used"' },
    ]);
  });

  it("keeps the known provider ids and names the unknown ones", async () => {
    writeSettings('{ "providers": { "enabled": ["copilot", "nope"] } }');

    const loaded = await loadSettings();

    expect(loaded.settings.providers.enabled).toEqual(["copilot"]);
    expect(loaded.issues[0]?.message).toMatch(/^unknown provider id\(s\): nope; valid: .*copilot/);
  });

  it("reports unknown keys with the valid ones, and a group that is not an object", async () => {
    writeSettings('{ "wordz": {}, "words": { "percnt": "used" }, "checking": 5 }');

    const loaded = await loadSettings();

    expect(loaded.issues).toEqual([
      {
        key: "wordz",
        message:
          "unknown setting; valid: version, providers, checking, words, pricing, announcements, export, telemetry",
      },
      {
        key: "words.percnt",
        message:
          "unknown setting; valid in words: percent, reset, resetDecimals, detail, runsOut, onlyCurrentModel, sessionTokens",
      },
      { key: "checking", message: "expected an object" },
    ]);
    expect(loaded.settings).toEqual(defaultSettings());
  });

  it("loads valid custom providers and reports a bad one under providers.custom", async () => {
    writeSettings(JSON.stringify({ providers: { custom: VALID_QUOTA_PROVIDER_INPUTS } }));
    expect((await loadSettings()).settings.providers.custom).toEqual(VALID_QUOTA_PROVIDERS);

    writeSettings(JSON.stringify({ providers: { custom: [{ id: "x", mode: "remote-api" }] } }));
    const loaded = await loadSettings();
    expect(loaded.settings.providers.custom).toEqual([]);
    expect(loaded.issues.length).toBeGreaterThan(0);
    expect(loaded.issues.every((issue) => issue.key.startsWith("providers.custom["))).toBe(true);
  });

  it("names the line of a syntax error and still uses what parses", async () => {
    writeSettings('{\n  "words": { "percent": "used" }\n  "checking": {}\n}\n');

    const loaded = await loadSettings();

    expect(loaded.settings.words.percent).toBe("used");
    expect(loaded.issues).toEqual([
      { key: "$file", message: "syntax error on line 3: CommaExpected" },
    ]);
  });
});

describe("saveSettings", () => {
  it("merges a patch, keeps comments and the other keys, and returns what changed", async () => {
    const path = writeSettings(
      '// my note\n{\n  "version": 6,\n  // keep me\n  "words": { "percent": "used" }\n}\n',
    );

    const result = await saveSettings({
      words: { reset: "short" },
      checking: { minIntervalMs: 60_000 },
    });

    expect(result).toEqual({
      ok: true,
      issues: [],
      diff: [
        { key: "checking.minIntervalMs", before: 300_000, after: 60_000 },
        { key: "words.reset", before: "exact", after: "short" },
      ],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("// my note");
    expect(text).toContain("// keep me");
    const loaded = await loadSettings();
    expect(loaded.settings.words).toMatchObject({ percent: "used", reset: "short" });
    expect(loaded.issues).toEqual([]);
  });

  it("resets a key to its default with null", async () => {
    const path = writeSettings('{ "words": { "percent": "used", "reset": "short" } }');

    const result = await saveSettings({ words: { percent: null } });

    expect(result.diff).toEqual([{ key: "words.percent", before: "used", after: "left" }]);
    expect(readFileSync(path, "utf8")).not.toContain("percent");
    expect((await loadSettings()).settings.words.reset).toBe("short");
  });

  it("creates a new file with a header comment, mode 0600", async () => {
    const result = await saveSettings({ words: { percent: "bare" } });

    expect(result.ok).toBe(true);
    const text = readFileSync(settingsPath(), "utf8");
    expect(text).toMatch(/^\/\/ OpenCode Quota server settings\./);
    expect(text).toContain('"version": 6');
    expect((await loadSettings()).settings.words.percent).toBe("bare");
    if (process.platform !== "win32") {
      expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    { name: "an unknown key", patch: { wordz: { percent: "used" } }, message: /valid: version/ },
    { name: "a bad value", patch: { words: { percent: "huge" } }, message: /expected one of/ },
    { name: "an unknown provider", patch: { providers: { enabled: ["nope"] } }, message: /nope/ },
    { name: "a group set to a value", patch: { words: "short" }, message: /expected an object/ },
    { name: "a patch that is not an object", patch: "words", message: /expected an object/ },
  ])("rejects $name and writes nothing", async ({ patch, message }) => {
    const path = writeSettings('{ "words": { "reset": "short" } }');

    const result = await saveSettings(patch);

    expect(result.ok).toBe(false);
    expect(result.diff).toEqual([]);
    expect(result.issues.map((issue) => issue.message).join("\n")).toMatch(message);
    expect(readFileSync(path, "utf8")).toBe('{ "words": { "reset": "short" } }');
  });

  it("refuses to edit a file with a syntax error", async () => {
    const path = writeSettings('{ "words": { "percent": "used" ');

    const result = await saveSettings({ words: { reset: "short" } });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/syntax error on line 1; fix it first/);
    expect(readFileSync(path, "utf8")).toBe('{ "words": { "percent": "used" ');
  });

  it.skipIf(process.platform === "win32")(
    "writes through a symlinked file and keeps the link",
    async () => {
      const target = join(root, "dotfiles", "quota.jsonc");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '{\n  // from my dotfiles\n  "version": 6\n}\n');
      mkdirSync(dirname(settingsPath()), { recursive: true });
      symlinkSync(target, settingsPath());

      const result = await saveSettings({ words: { reset: "short" } });

      expect(result.ok).toBe(true);
      expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toContain("// from my dotfiles");
      expect(readFileSync(target, "utf8")).toContain('"reset": "short"');
    },
  );
});

describe("watchSettings", () => {
  it("calls back once for an edit and once for an atomic replace", async () => {
    const path = writeSettings('{ "words": { "percent": "used" } }');
    const seen: LoadedSettings[] = [];
    const watch = await watchSettings((loaded) => seen.push(loaded), { debounceMs: 50 });
    try {
      writeFileSync(path, '{ "words": { "percent": "bare" } }');
      await waitFor(() => seen.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(seen.map((loaded) => loaded.settings.words.percent)).toEqual(["bare"]);

      writeFileSync(`${path}.tmp`, '{ "words": { "percent": "remaining" } }');
      renameSync(`${path}.tmp`, path);
      await waitFor(() => seen.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(seen.map((loaded) => loaded.settings.words.percent)).toEqual(["bare", "remaining"]);
    } finally {
      watch.close();
    }
  });
});
