import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaAgentTools } from "../src/agent-tools.js";
import { loadSettings, settingsPath } from "../src/settings/index.js";

let root: string;
let openCodeProviderIds: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-agent-tools-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("MY_GATEWAY_API_KEY", "");
  openCodeProviderIds = ["my-gateway", "openrouter"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected fetch");
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const GATEWAY = {
  id: "my-gateway-quota",
  providerId: "my-gateway",
  label: "My Gateway",
  mode: "remote-api",
  url: "https://gateway.example/v1/quota",
  format: "quota-v1",
  apiKeyEnv: "MY_GATEWAY_API_KEY",
};

const OTHER = {
  id: "other-quota",
  providerId: "openrouter",
  mode: "remote-api",
  url: "https://other.example/quota",
  format: "quota-v1",
};

const FILE_WITH_COMMENTS = `// my note
{
  "version": 6,
  // keep me
  "providers": { "custom": [${JSON.stringify(OTHER)}] }
}
`;

type Answer = {
  /** The raw JSON text the agent reads. */
  text: string;
  ok?: boolean;
  message?: string;
  issues?: Array<{ key: string; message: string }>;
  notes?: string[];
  settings?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Runs one tool the way OpenCode does and reads its JSON answer. */
async function call(name: string, input: unknown): Promise<Answer> {
  const tool = quotaAgentTools({ openCodeProviderIds: async () => openCodeProviderIds }).find(
    (item) => item.name === name,
  );
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const { content } = await tool.execute(input);
  return { ...JSON.parse(content), text: content };
}

function writeSettings(text: string): void {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), text);
}

function settingsText(): string {
  return readFileSync(settingsPath(), "utf8");
}

/** A key saved in the global opencode.json, as `provider.<id>.options.apiKey`. */
function saveOpenCodeKey(providerId: string, apiKey: string): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "opencode.json"),
    JSON.stringify({ provider: { [providerId]: { options: { apiKey } } } }),
  );
}

/** A 32-character lowercase hex token, the shape of many API keys. */
const HEX_TOKEN = "9f86d081884c7d659a2feaa0c55ad015";

const GATEWAY_WITHOUT_KEY_VARIABLE = Object.fromEntries(
  Object.entries(GATEWAY).filter(([field]) => field !== "apiKeyEnv"),
);

function answerWith(status: number, body: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const DAILY_QUOTA = {
  version: "quota-v1",
  entries: [
    {
      kind: "percent",
      name: "Daily",
      resultType: "quota",
      percentRemaining: 42,
      label: "Daily:",
      right: "58/100",
    },
  ],
};

describe("quota_settings_get", () => {
  it("lists each setting with its source and allowed values, and key variable names only", async () => {
    vi.stubEnv("MY_GATEWAY_API_KEY", "gateway-key-value-123");
    writeSettings(
      JSON.stringify({
        words: { percent: "used" },
        providers: { custom: [GATEWAY, OTHER], anthropic: { binaryPath: HEX_TOKEN } },
      }),
    );

    const result = await call("quota_settings_get", {});

    expect(result.file).toBe(settingsPath());
    expect(result.settings?.["words.percent"]).toEqual({
      value: "used",
      from: "file",
      allowed: 'one of: "left", "remaining", "bare", "used"',
    });
    expect(result.settings?.["words.reset"]).toMatchObject({ value: "exact", from: "default" });
    expect(result.apiKeys).toEqual([
      { provider: "my-gateway-quota", apiKeyEnv: "MY_GATEWAY_API_KEY", isSet: true },
      {
        provider: "other-quota",
        apiKeyEnv: null,
        readsFrom: `OpenCode's API key for provider "openrouter"`,
      },
    ]);
    expect(result.text).not.toContain("gateway-key-value-123");
    expect(result.settings?.["providers.anthropic.binaryPath"]).toMatchObject({
      value: "[redacted]",
    });
    expect(result.text).not.toContain(HEX_TOKEN);
  });
});

describe("quota_settings_set", () => {
  it("saves a patch into the settings file, keeps its comments and returns the diff", async () => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_settings_set", {
      patch: { checking: { minIntervalMs: 600_000 } },
    });

    expect(result).toMatchObject({
      ok: true,
      diff: [{ key: "checking.minIntervalMs", before: 300_000, after: 600_000 }],
      message: "Saved.",
    });
    expect(settingsText()).toContain("// keep me");
    expect((await loadSettings()).settings.checking.minIntervalMs).toBe(600_000);
    expect(existsSync(join(root, "config", "opencode.json"))).toBe(false);
  });

  it("never shows a key-like value in the diff", async () => {
    writeSettings(JSON.stringify({ providers: { anthropic: { binaryPath: HEX_TOKEN } } }));

    const result = await call("quota_settings_set", {
      patch: { providers: { anthropic: { binaryPath: null } } },
    });

    expect(result.diff).toEqual([
      { key: "providers.anthropic.binaryPath", before: "[redacted]", after: "claude" },
    ]);
    expect(result.text).not.toContain(HEX_TOKEN);
  });

  it.each([
    {
      name: "an unknown key, with the valid ones",
      patch: { checking: { minIntervalMz: 1 } },
      message: /^unknown setting; valid in checking: minIntervalMs,/,
    },
    {
      name: "an unknown group, with the ones agents may change",
      patch: { wordz: {} },
      message: /^unknown setting; agents may change: providers, checking, pricing$/,
    },
    {
      name: "a bad value",
      patch: { checking: { minIntervalMs: 0 } },
      message: /^expected a number/,
    },
    ...["words", "announcements", "export", "telemetry", "version"].map((group) => ({
      name: `the user's ${group}`,
      patch: { [group]: group === "version" ? 6 : { enabled: true } },
      message: new RegExp(`^the user changes ${group} in /quota → Customize`),
    })),
    {
      name: "a dotted key for custom providers",
      patch: { "providers.custom": [{ ...GATEWAY, label: "sk-proj-abcdefghijklmnopqrstuv" }] },
      message: /^use nested objects, not dotted keys/,
    },
    {
      name: "a dotted reset of custom providers",
      patch: { "providers.custom": null },
      message: /^use nested objects, not dotted keys/,
    },
    {
      name: "a nested dotted key",
      patch: { providers: { "cursor.plan": "pro" } },
      message: /^use nested objects, not dotted keys/,
    },
    {
      name: "a key-like value",
      patch: { providers: { anthropic: { binaryPath: "sk-ant-api03-abcdefghijklmnopqrstuv" } } },
      message: /^looks like a key/,
    },
    {
      name: "custom providers",
      patch: { providers: { custom: [] } },
      message: /quota_provider_add and quota_provider_remove/,
    },
    {
      name: "a reset of every provider setting",
      patch: { providers: null },
      message: /quota_provider_add and quota_provider_remove/,
    },
  ])("rejects $name and saves nothing", async ({ patch, message }) => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_settings_set", { patch });

    expect(result.ok).toBe(false);
    expect(result.issues?.[0]?.message).toMatch(message);
    expect(result.text).not.toMatch(/sk-proj|sk-ant/);
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
  });

  it("claims nothing applies live until the server reloads the file", () => {
    const tools = quotaAgentTools({ openCodeProviderIds: async () => [] });

    expect(tools.map((tool) => tool.description).join("\n")).not.toMatch(/live/i);
  });
});

describe("quota_provider_add", () => {
  it.each([
    { name: "a key field", definition: { ...GATEWAY, apiKey: "abc" }, key: "definition.apiKey" },
    {
      name: "a known key format",
      definition: { ...GATEWAY, label: "sk-or-v1-0123456789abcdef0123" },
      key: "definition.label",
    },
    {
      name: "a random token in the URL",
      definition: {
        ...GATEWAY,
        url: "https://gateway.example/v1/Zx9QmT4vLr8KpW2sNb7YhC3dFg6JkA1e/quota",
      },
      key: "definition.url",
    },
    {
      name: "a lowercase hex token",
      definition: { ...GATEWAY, label: HEX_TOKEN },
      key: "definition.label",
    },
    {
      name: "a key where the variable name belongs",
      definition: { ...GATEWAY, apiKeyEnv: "sk-proj-abcdefghijklmnop1234" },
      key: "definition.apiKeyEnv",
    },
  ])("refuses $name and saves nothing", async ({ definition, key }) => {
    const result = await call("quota_provider_add", { definition });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ key, message: expect.stringMatching(/secret.*apiKeyEnv/) }]);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("rejects an invalid definition with the validator's message", async () => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_provider_add", {
      definition: { ...GATEWAY, url: "http://gateway.example/quota" },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { key: "definition.url", message: "HTTPS is required except for loopback HTTP endpoints" },
    ]);
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
  });

  it.each([
    {
      name: "no key variable",
      definition: GATEWAY_WITHOUT_KEY_VARIABLE,
      issue: {
        key: "definition.apiKeyEnv",
        message: /^required .* dedicated environment variable/,
      },
    },
    {
      name: "a built-in provider's key variable",
      definition: { ...GATEWAY, apiKeyEnv: "OPENROUTER_API_KEY" },
      issue: { key: "definition.apiKeyEnv", message: /^OPENROUTER_API_KEY holds a built-in/ },
    },
    {
      name: "a providerId with a key saved in OpenCode",
      definition: GATEWAY,
      issue: { key: "definition.providerId", message: /^OpenCode has a key saved for provider/ },
    },
  ])("refuses $name: nothing is saved or sent", async ({ definition, issue }) => {
    writeSettings(FILE_WITH_COMMENTS);
    vi.stubEnv("OPENROUTER_API_KEY", "router-key-from-env");
    vi.stubEnv("MY_GATEWAY_API_KEY", "gateway-key");
    saveOpenCodeKey("my-gateway", "gateway-key-saved-in-opencode");
    const fetch = answerWith(200, DAILY_QUOTA);

    const result = await call("quota_provider_add", { definition });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { key: issue.key, message: expect.stringMatching(issue.message) },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
  });

  it("never returns the key, even when the endpoint echoes it", async () => {
    vi.stubEnv("MY_GATEWAY_API_KEY", "echomeplease42");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        const key = init.headers.Authorization.replace("Bearer ", "");
        const body = {
          version: "quota-v1",
          entries: [
            { kind: "percent", name: `Echo ${key}`, resultType: "quota", percentRemaining: 50 },
          ],
        };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await call("quota_provider_add", { definition: GATEWAY });

    expect(result.test).toMatchObject({ ok: true, rows: [{ percentRemaining: 50 }] });
    expect(result.text).not.toContain("echomeplease42");
  });

  it("adds a provider, tests it once, and replaces it by id while keeping the others", async () => {
    writeSettings(FILE_WITH_COMMENTS);
    vi.stubEnv("MY_GATEWAY_API_KEY", "gateway-key");
    const fetch = answerWith(200, DAILY_QUOTA);

    const added = await call("quota_provider_add", { definition: GATEWAY });

    expect(added).toMatchObject({
      ok: true,
      added: "my-gateway-quota",
      message: "Saved and tested.",
    });
    expect(added.test).toMatchObject({
      ok: true,
      rows: [{ id: "quota-providers.custom.my_gateway_quota.daily", percentRemaining: 42 }],
    });
    expect(added.notes).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      GATEWAY.url,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gateway-key" }),
      }),
    );

    const replaced = await call("quota_provider_add", {
      definition: { ...GATEWAY, label: "Gateway Two" },
    });

    expect(replaced).toMatchObject({ ok: true, replaced: "my-gateway-quota" });
    const custom = (await loadSettings()).settings.providers.custom;
    expect(custom.map((item) => [item.id, item.label])).toEqual([
      ["other-quota", "other-quota"],
      ["my-gateway-quota", "Gateway Two"],
    ]);
    expect(settingsText()).toContain("// keep me");
  });

  it("keeps a definition whose test fails and says what to fix", async () => {
    openCodeProviderIds = ["openrouter"];

    const result = await call("quota_provider_add", { definition: GATEWAY });

    expect(result.ok).toBe(true);
    expect(result.test).toEqual({
      ok: false,
      error: expect.stringMatching(/^No API key: MY_GATEWAY_API_KEY is not set/),
    });
    expect(result.notes).toEqual([expect.stringMatching(/OpenCode has no provider "my-gateway"/)]);
    expect(result.message).toMatch(/call quota_provider_add again with the same id/);
    expect((await loadSettings()).settings.providers.custom.map((item) => item.id)).toEqual([
      "my-gateway-quota",
    ]);
  });
});

describe("quota_provider_test and quota_provider_remove", () => {
  it.each([
    "quota_provider_test",
    "quota_provider_remove",
  ])("%s names the known ids for an unknown one", async (name) => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call(name, { id: "nope" });

    expect(result).toMatchObject({
      ok: false,
      message: 'No custom provider has the id "nope".',
      ids: ["other-quota"],
    });
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
  });

  it("tests a saved provider and returns the fetch error", async () => {
    writeSettings(JSON.stringify({ providers: { custom: [GATEWAY] } }));
    vi.stubEnv("MY_GATEWAY_API_KEY", "gateway-key");
    answerWith(401, { error: "unauthorized" });

    const result = await call("quota_provider_test", { id: "my-gateway-quota" });

    expect(result).toMatchObject({ id: "my-gateway-quota", ok: false, error: "HTTP 401" });
  });

  it("does not send a key saved in OpenCode for a hand-added provider", async () => {
    writeSettings(FILE_WITH_COMMENTS);
    saveOpenCodeKey("openrouter", "router-key-saved-in-opencode");
    const fetch = answerWith(200, DAILY_QUOTA);

    const result = await call("quota_provider_test", { id: "other-quota" });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Not tested: /) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes one provider and keeps the others and the comments", async () => {
    writeSettings(
      FILE_WITH_COMMENTS.replace(
        `${JSON.stringify(OTHER)}`,
        `${JSON.stringify(OTHER)}, ${JSON.stringify(GATEWAY)}`,
      ),
    );

    const result = await call("quota_provider_remove", { id: "my-gateway-quota" });

    expect(result).toMatchObject({
      ok: true,
      removed: "my-gateway-quota",
      remaining: ["other-quota"],
      message: "Removed.",
    });
    expect((await loadSettings()).settings.providers.custom.map((item) => item.id)).toEqual([
      "other-quota",
    ]);
    expect(settingsText()).toContain("// keep me");
  });
});
