import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeIntegration } from "./helpers/fake-integration.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFile: vi.fn(),
  readAuthFile: vi.fn(),
  readAuthFileCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(homedir(), ".local", "share", "opencode"),
    configDir: join(homedir(), ".config", "opencode"),
    cacheDir: join(homedir(), ".cache", "opencode"),
    stateDir: join(homedir(), ".local", "state", "opencode"),
  }),
}));
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: mocks.existsSync,
}));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  readFile: mocks.readFile,
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  getCredentialDatabasePaths: () => ["/tmp/opencode.db"],
  readAuthFile: mocks.readAuthFile,
  readAuthFileCached: mocks.readAuthFileCached,
}));

import {
  getAlibabaCodingPlanAuthDiagnostics,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuth,
  resolveAlibabaCodingPlanAuthCached,
} from "../src/lib/alibaba-auth.js";
import {
  API_KEY_LOGIN_VENDORS,
  API_KEY_VENDORS,
  type ApiKeyLoginSpec,
  type ApiKeySpec,
  getApiKeyDiagnostics,
  getApiKeyLoginDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
  hasApiKey,
  parseApiKeyLogin,
  resolveApiKey,
  resolveApiKeyLogin,
} from "../src/lib/api-key-resolver.js";
import {
  resolveKimiCnAuth,
  resolveKimiCnAuthWithDiagnosticsCached,
  resolveKimiGlobalAuth,
  resolveKimiGlobalAuthWithDiagnosticsCached,
} from "../src/lib/kimi-auth.js";
import {
  getMiniMaxChinaAuthDiagnostics,
  resolveMiniMaxAuthCached,
  resolveMiniMaxChinaAuth,
  resolveMiniMaxChinaAuthCached,
} from "../src/lib/minimax-auth.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const TRUSTED = {
  jsonc: join(CONFIG_DIR, "opencode.jsonc"),
  json: join(CONFIG_DIR, "opencode.json"),
};
const WORKSPACE = [join(process.cwd(), "opencode.json"), join(process.cwd(), "opencode.jsonc")];
const DB_PATHS = ["/tmp/opencode.db"];

const SIMPLE_VENDORS = Object.entries(API_KEY_VENDORS) as Array<[string, ApiKeySpec]>;
const LOGIN_VENDORS = Object.entries(API_KEY_LOGIN_VENDORS) as Array<[string, ApiKeyLoginSpec]>;
const ALL_ENV_VARS = [...SIMPLE_VENDORS, ...LOGIN_VENDORS].flatMap(([, spec]) => spec.envVars);

/** Only these files exist; any other read fails like a missing file. */
function mockConfigFiles(files: Record<string, string>): void {
  mocks.existsSync.mockImplementation((path: string) => Object.hasOwn(files, path));
  mocks.readFile.mockImplementation(async (path: string) => {
    if (!Object.hasOwn(files, path)) throw new Error(`Unexpected read: ${path}`);
    return files[path];
  });
}

function legacyConfig(providers: Record<string, string>): string {
  return JSON.stringify({
    provider: Object.fromEntries(
      Object.entries(providers).map(([id, apiKey]) => [id, { options: { apiKey } }]),
    ),
  });
}

function expectedLoginRead(spec: ApiKeyLoginSpec, maxAgeMs: number) {
  return {
    maxAgeMs,
    integrationIds: spec.authKeys,
    ...(spec.keyLoginsOnly ? { methods: ["key"] } : {}),
  };
}

function unsupportedTypeError(spec: ApiKeyLoginSpec, type: string): string {
  return spec.unsupportedTypeError ?? `Unsupported ${spec.displayName} auth type: "${type}"`;
}

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const name of [...ALL_ENV_VARS, "NOT_ALLOWED", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    delete process.env[name];
  }
  mockConfigFiles({});
  mocks.readAuthFile.mockReset().mockResolvedValue(null);
  mocks.readAuthFileCached.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  process.env = originalEnv;
});

describe("API key vendors (env, then trusted config, then usable stored key)", () => {
  it.each(SIMPLE_VENDORS)("%s: an env key wins and skips the stored logins", async (_id, spec) => {
    const envVar = spec.envVars[0];
    process.env[envVar] = " env-key ";
    mockConfigFiles({ [TRUSTED.json]: legacyConfig({ [spec.providerKeys[0]]: "config-key" }) });

    await expect(resolveApiKey(spec)).resolves.toEqual({ key: "env-key", source: `env:${envVar}` });
    await expect(getApiKeyDiagnostics(spec)).resolves.toEqual({
      configured: true,
      source: `env:${envVar}`,
      checkedPaths: [`env:${envVar}`, TRUSTED.json],
      credentialDatabasePaths: DB_PATHS,
    });
    expect(mocks.readAuthFile).not.toHaveBeenCalled();
  });

  it.each(
    SIMPLE_VENDORS,
  )("%s: reads every provider alias from trusted config", async (_id, spec) => {
    mockConfigFiles({ [TRUSTED.json]: legacyConfig({ [spec.providerKeys[0]]: "json-key" }) });
    await expect(resolveApiKey(spec)).resolves.toEqual({
      key: "json-key",
      source: "opencode.json",
    });

    mockConfigFiles({
      [TRUSTED.jsonc]: legacyConfig({ [spec.providerKeys.at(-1)!]: "jsonc-key" }),
    });
    await expect(resolveApiKey(spec)).resolves.toEqual({
      key: "jsonc-key",
      source: "opencode.jsonc",
    });
    expect(mocks.readAuthFile).not.toHaveBeenCalled();
  });

  it.each(SIMPLE_VENDORS)("%s: falls back to a usable stored API key only", async (_id, spec) => {
    const authKey = spec.providerKeys.at(-1)!;
    mocks.readAuthFile.mockResolvedValue({ [authKey]: { type: "api", key: " auth-key " } });
    await expect(resolveApiKey(spec)).resolves.toEqual({ key: "auth-key", source: "opencode.db" });
    expect(mocks.readAuthFile).toHaveBeenLastCalledWith({ integrationIds: spec.providerKeys });

    mocks.readAuthFile.mockResolvedValue({ [authKey]: { type: "oauth", key: "oauth-key" } });
    await expect(hasApiKey(spec)).resolves.toBe(false);

    mocks.readAuthFile.mockResolvedValue({ [authKey]: { type: "api", resolveError: "x" } });
    await expect(getApiKeyDiagnostics(spec)).resolves.toEqual({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
  });

  it.each(
    SIMPLE_VENDORS,
  )("%s: ignores unapproved env templates and workspace config", async (_id, spec) => {
    process.env.NOT_ALLOWED = "secret";
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ [spec.providerKeys[0]]: "{env:NOT_ALLOWED}" }),
    });
    await expect(resolveApiKey(spec)).resolves.toBeNull();

    const workspaceConfig = legacyConfig({ [spec.providerKeys[0]]: "workspace-key" });
    mockConfigFiles(Object.fromEntries(WORKSPACE.map((path) => [path, workspaceConfig])));
    await expect(getApiKeyDiagnostics(spec)).resolves.toEqual({
      configured: false,
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
  });

  it("keeps NanoGPT env var order", async () => {
    process.env.NANOGPT_API_KEY = "first-key";
    process.env.NANO_GPT_API_KEY = "second-key";
    await expect(resolveApiKey(API_KEY_VENDORS.nanogpt)).resolves.toEqual({
      key: "first-key",
      source: "env:NANOGPT_API_KEY",
    });

    delete process.env.NANOGPT_API_KEY;
    await expect(resolveApiKey(API_KEY_VENDORS.nanogpt)).resolves.toEqual({
      key: "second-key",
      source: "env:NANO_GPT_API_KEY",
    });
  });
});

describe("trusted config parsing", () => {
  const spec = API_KEY_VENDORS.deepseek;

  it("lists only the global jsonc and json files", () => {
    expect(getGlobalOpencodeConfigCandidatePaths()).toEqual([
      { path: TRUSTED.jsonc, isJsonc: true },
      { path: TRUSTED.json, isJsonc: false },
    ]);
  });

  it("prefers opencode.jsonc and stops reading once it has a key", async () => {
    mockConfigFiles({
      [TRUSTED.jsonc]:
        '{ // preferred\n "provider": { "deepseek": { "options": { "apiKey": "jsonc-key" } } },\n}',
      [TRUSTED.json]: legacyConfig({ deepseek: "json-key" }),
    });
    await expect(resolveApiKey(spec)).resolves.toEqual({
      key: "jsonc-key",
      source: "opencode.jsonc",
    });
    expect(mocks.readFile.mock.calls.map((call) => call[0])).toEqual([TRUSTED.jsonc]);
  });

  it.each([
    [
      "native settings",
      { providers: { deepseek: { settings: { apiKey: " native-key " } } } },
      "native-key",
    ],
    [
      "native settings over legacy options",
      {
        provider: { deepseek: { options: { apiKey: "legacy-key" } } },
        providers: { deepseek: { settings: { apiKey: "native-key" } } },
      },
      "native-key",
    ],
    [
      "a native entry without settings hides legacy options",
      {
        provider: { deepseek: { options: { apiKey: "legacy-key" } } },
        providers: { deepseek: { name: "DeepSeek" } },
      },
      null,
    ],
    [
      "legacy options",
      { provider: { deepseek: { options: { apiKey: "legacy-key" } } } },
      "legacy-key",
    ],
  ])("reads %s", async (_label, config, expected) => {
    mockConfigFiles({ [TRUSTED.json]: JSON.stringify(config) });
    const result = await resolveApiKey(spec);
    expect(result?.key ?? null).toBe(expected);
  });

  it("resolves a template naming the vendor's own second env var", async () => {
    // A vendor's own env var wins before config is read, so use a vendor whose
    // first env var is unset and whose template names its second one.
    process.env.ZAI_CODING_PLAN_API_KEY = "templated-key";
    mockConfigFiles({
      [TRUSTED.json]: legacyConfig({ zai: "{env:ZAI_CODING_PLAN_API_KEY}" }),
    });
    await expect(resolveApiKeyLogin(API_KEY_LOGIN_VENDORS.zai)).resolves.toEqual({
      state: "configured",
      apiKey: "templated-key",
    });
  });
});

describe("API key login vendors (a broken stored login is reported, not skipped)", () => {
  it.each(LOGIN_VENDORS)("%s: parses stored logins exactly", (_id, spec) => {
    const withEntry = (entry: unknown) => ({ [spec.authKeys[0]]: entry });

    expect(parseApiKeyLogin(spec, null)).toEqual({ state: "none" });
    expect(parseApiKeyLogin(spec, {})).toEqual({ state: "none" });
    expect(parseApiKeyLogin(spec, withEntry("bad-shape"))).toEqual({
      state: "invalid",
      error: `${spec.displayName} auth entry has invalid shape`,
    });
    expect(parseApiKeyLogin(spec, withEntry({ type: { bad: true }, key: "k" }))).toEqual({
      state: "invalid",
      error: `${spec.displayName} auth entry present but type is missing or invalid`,
    });
    expect(parseApiKeyLogin(spec, withEntry({ type: "oauth", key: "k" }))).toEqual({
      state: "invalid",
      error: unsupportedTypeError(spec, "oauth"),
    });
    expect(parseApiKeyLogin(spec, withEntry({ type: "api", key: " " }))).toEqual({
      state: "invalid",
      error: `${spec.displayName} auth entry present but key is empty`,
    });
    expect(
      parseApiKeyLogin(spec, withEntry({ type: "api", resolveError: "resolve_empty: no value" })),
    ).toEqual({
      state: "invalid",
      error: "OpenCode could not read this login: resolve_empty: no value",
    });
    for (const authKey of spec.authKeys) {
      expect(
        parseApiKeyLogin(spec, { [authKey]: { type: "api", key: ` ${authKey}-key ` } }),
      ).toEqual({
        state: "configured",
        apiKey: `${authKey}-key`,
      });
    }
    if (spec.authKeys.length > 1) {
      expect(
        parseApiKeyLogin(spec, {
          [spec.authKeys[0]]: { type: "oauth", key: "ignored" },
          [spec.authKeys[1]]: { type: "api", key: "later-key" },
        }),
      ).toEqual({ state: "invalid", error: unsupportedTypeError(spec, "oauth") });
    }
  });

  it("sanitizes, bounds, and falls back in the unsupported-type error", () => {
    const spec = API_KEY_LOGIN_VENDORS.zai;
    const withType = (type: string) => ({ "zai-coding-plan": { type } });
    expect(parseApiKeyLogin(spec, withType("\u001b[31moauth\nretry\u001b[0m"))).toEqual({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "oauth retry"',
    });
    expect(parseApiKeyLogin(spec, withType("\u001b[31m"))).toEqual({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "unknown"',
    });
    expect(parseApiKeyLogin(spec, withType("x".repeat(130)))).toEqual({
      state: "invalid",
      error: `Unsupported Z.ai auth type: "${"x".repeat(120)}"`,
    });
  });

  it("uses a fixed OpenCode Go unsupported-type error that never echoes the login", async () => {
    const secret = "distinctive-go-secret";
    mocks.readAuthFileCached.mockResolvedValue({ "opencode-go": { type: secret, key: secret } });
    const diagnostics = await getApiKeyLoginDiagnostics(API_KEY_LOGIN_VENDORS["opencode-go"]);
    expect(diagnostics).toMatchObject({
      state: "invalid",
      error: "OpenCode Go auth entry has unsupported type",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it.each(
    LOGIN_VENDORS,
  )("%s: env keys win in order and skip the stored logins", async (_id, spec) => {
    for (const name of spec.envVars) process.env[name] = `${name}-value`;
    mocks.readAuthFileCached.mockResolvedValue({ [spec.authKeys[0]]: { type: "oauth" } });
    await expect(resolveApiKeyLogin(spec)).resolves.toEqual({
      state: "configured",
      apiKey: `${spec.envVars[0]}-value`,
    });
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();

    const lastEnvVar = spec.envVars.at(-1)!;
    for (const name of spec.envVars.slice(0, -1)) delete process.env[name];
    await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
      state: "configured",
      source: `env:${lastEnvVar}`,
      checkedPaths: [`env:${lastEnvVar}`],
      credentialDatabasePaths: DB_PATHS,
    });
  });

  it.each(
    LOGIN_VENDORS,
  )("%s: trusted config aliases win over a broken stored login", async (_id, spec) => {
    mocks.readAuthFileCached.mockResolvedValue({ [spec.authKeys[0]]: { type: "oauth" } });
    mockConfigFiles({
      [TRUSTED.jsonc]: legacyConfig({
        [spec.providerKeys[0]]: "{env:NOT_ALLOWED}",
        [spec.providerKeys.at(-1)!]: "alias-key",
      }),
    });
    await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
      state: "configured",
      source: "opencode.jsonc",
      checkedPaths: [TRUSTED.jsonc],
      credentialDatabasePaths: DB_PATHS,
    });
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();

    mockConfigFiles(
      Object.fromEntries(
        WORKSPACE.map((path) => [path, legacyConfig({ [spec.providerKeys[0]]: "k" })]),
      ),
    );
    mocks.readAuthFileCached.mockResolvedValue(null);
    await expect(getApiKeyLoginDiagnostics(spec)).resolves.toEqual({
      state: "none",
      source: null,
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
  });

  it.each(
    LOGIN_VENDORS,
  )("%s: reads cached stored logins with the vendor's ids", async (_id, spec) => {
    mocks.readAuthFileCached.mockResolvedValue({
      [spec.authKeys[0]]: { type: "api", key: "auth-key" },
    });
    await expect(resolveApiKeyLogin(spec)).resolves.toEqual({
      state: "configured",
      apiKey: "auth-key",
    });
    expect(mocks.readAuthFileCached).toHaveBeenLastCalledWith(expectedLoginRead(spec, 5_000));

    mocks.readAuthFileCached.mockResolvedValue({ [spec.authKeys[0]]: { type: "oauth" } });
    await expect(getApiKeyLoginDiagnostics(spec, { maxAgeMs: -1 })).resolves.toEqual({
      state: "invalid",
      source: "opencode.db",
      error: unsupportedTypeError(spec, "oauth"),
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
    expect(mocks.readAuthFileCached).toHaveBeenLastCalledWith(expectedLoginRead(spec, 0));
  });
});

describe("per-vendor differences", () => {
  it("binds each Kimi region to its endpoint and gives the legacy aliases to CN", async () => {
    const legacy = { kimi: { type: "api", key: "legacy-cn" } };
    expect(resolveKimiCnAuth(legacy)).toEqual({
      state: "configured",
      apiKey: "legacy-cn",
      endpoint: "cn",
    });
    expect(resolveKimiGlobalAuth(legacy)).toEqual({ state: "none" });

    process.env.KIMI_GLOBAL_API_KEY = "global-env";
    mocks.readAuthFileCached.mockResolvedValue({
      "kimi-code-plan-cn": { type: "api", key: "cn-db" },
    });
    const global = await resolveKimiGlobalAuthWithDiagnosticsCached();
    const cn = await resolveKimiCnAuthWithDiagnosticsCached();
    expect(global.auth).toEqual({ state: "configured", apiKey: "global-env", endpoint: "global" });
    expect(global.diagnostics).toMatchObject({
      source: "env:KIMI_GLOBAL_API_KEY",
      endpoint: "global",
    });
    expect(cn.auth).toEqual({ state: "configured", apiKey: "cn-db", endpoint: "cn" });
    expect(cn.diagnostics).toMatchObject({ source: "opencode.db", endpoint: "cn" });
  });

  it("keeps the MiniMax China key away from the international plan", async () => {
    process.env.MINIMAX_CHINA_CODING_PLAN_API_KEY = "china-key";
    await expect(resolveMiniMaxAuthCached()).resolves.toEqual({ state: "none" });
    await expect(resolveMiniMaxChinaAuthCached()).resolves.toEqual({
      state: "configured",
      apiKey: "china-key",
      endpoint: "china",
    });
    await expect(getMiniMaxChinaAuthDiagnostics()).resolves.toMatchObject({
      state: "configured",
      source: "env:MINIMAX_CHINA_CODING_PLAN_API_KEY",
      endpoint: "china",
    });
    expect(
      resolveMiniMaxChinaAuth({ "minimax-cn-coding-plan": { type: "api", key: "db-key" } }),
    ).toEqual({
      state: "configured",
      apiKey: "db-key",
      endpoint: "china",
    });
  });

  it.each([
    [{}, "lite"],
    [{ tier: "PRO" }, "pro"],
    [{ planTier: "professional" }, "pro"],
    [{ plan_tier: "lite" }, "lite"],
    [{ subscriptionTier: " pro " }, "pro"],
  ])("reads the Alibaba plan tier from %j", (tierFields, tier) => {
    expect(
      resolveAlibabaCodingPlanAuth({ alibaba: { type: "api", key: "k", ...tierFields } } as never),
    ).toEqual({
      state: "configured",
      apiKey: "k",
      tier,
    });
  });

  it.each([
    [
      { type: "api", key: "k", tier: "max" },
      { state: "invalid", error: "Unsupported Alibaba Coding Plan tier: max", rawTier: "max" },
    ],
    [
      { type: "api", access: "token" },
      { state: "invalid", error: "Alibaba Coding Plan auth entry present but key is empty" },
    ],
  ])("reports the unusable Alibaba login %j", (entry, expected) => {
    expect(resolveAlibabaCodingPlanAuth({ alibaba: entry } as never)).toEqual(expected);
  });

  it("uses the fallback Alibaba tier for env keys and reports a bad stored tier", async () => {
    process.env.ALIBABA_API_KEY = "env-key";
    await expect(resolveAlibabaCodingPlanAuthCached({ fallbackTier: "pro" })).resolves.toEqual({
      state: "configured",
      apiKey: "env-key",
      tier: "pro",
    });
    expect(mocks.readAuthFileCached).not.toHaveBeenCalled();

    delete process.env.ALIBABA_API_KEY;
    mocks.readAuthFileCached.mockResolvedValue({ alibaba: { type: "api", key: "k", tier: "max" } });
    await expect(getAlibabaCodingPlanAuthDiagnostics()).resolves.toEqual({
      state: "invalid",
      source: "opencode.db",
      error: "Unsupported Alibaba Coding Plan tier: max",
      rawTier: "max",
      checkedPaths: [],
      credentialDatabasePaths: DB_PATHS,
    });
    expect(isAlibabaModelId("Alibaba-CN/qwen3-coder-plus")).toBe(true);
    expect(isAlibabaModelId("openai/gpt-5")).toBe(false);
  });

  it("never resolves the OpenCode Console sign-in while looking for an OpenCode Go key", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/opencode-auth.js")>(
      "../src/lib/opencode-auth.js",
    );
    const consoleSignIn = {
      integrationId: "opencode",
      id: "cred_console",
      label: "default",
      registered: true,
      method: "oauth" as const,
      value: { type: "oauth", methodID: "device", access: "a", refresh: "r", expires: 0 },
    };
    const workspaceKey = {
      integrationId: "opencode",
      id: "cred_workspace",
      label: "default",
      registered: true,
      method: "key" as const,
      value: { type: "key", key: "workspace-key" },
    };
    mocks.readAuthFileCached.mockImplementation(actual.readAuthFileCached);
    const spec = API_KEY_LOGIN_VENDORS["opencode-go"];
    async function withLogins(
      credentials: Parameters<typeof createFakeIntegration>[0],
      check: (integration: ReturnType<typeof createFakeIntegration>) => Promise<void>,
    ) {
      const integration = createFakeIntegration(credentials);
      const unbind = actual.bindCredentialSource(
        actual.createIntegrationCredentialSource(integration as never),
      );
      try {
        await check(integration);
      } finally {
        unbind();
        actual.notifyCredentialsChanged();
      }
    }

    await withLogins([consoleSignIn, workspaceKey], async (signedIn) => {
      await expect(resolveApiKeyLogin(spec, { maxAgeMs: 0 })).resolves.toEqual({ state: "none" });
      expect(signedIn.connection.active.mock.calls).toEqual([["opencode-go"], ["opencode"]]);
      expect(signedIn.connection.resolve).not.toHaveBeenCalled();
    });
    await withLogins([workspaceKey], async () => {
      await expect(resolveApiKeyLogin(spec, { maxAgeMs: 0 })).resolves.toEqual({
        state: "configured",
        apiKey: "workspace-key",
      });
    });
  });
});
