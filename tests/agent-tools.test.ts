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
      JSON.stringify({ words: { percent: "used" }, providers: { custom: [GATEWAY, OTHER] } }),
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
  });
});

describe("quota_settings_set", () => {
  it("saves a patch into the settings file, keeps its comments and returns the diff", async () => {
    writeSettings(FILE_WITH_COMMENTS);

    const result = await call("quota_settings_set", { patch: { words: { percent: "used" } } });

    expect(result).toMatchObject({
      ok: true,
      diff: [{ key: "words.percent", before: "left", after: "used" }],
    });
    expect(result.message).toMatch(/apply live/);
    expect(settingsText()).toContain("// keep me");
    expect((await loadSettings()).settings.words.percent).toBe("used");
    expect(existsSync(join(root, "config", "opencode.json"))).toBe(false);
  });

  it.each([
    {
      name: "an unknown key, with the valid ones",
      patch: { words: { percnt: "used" } },
      message: /^unknown setting; valid in words: percent, reset,/,
    },
    { name: "a bad value", patch: { words: { percent: "huge" } }, message: /^expected one of/ },
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
    expect(settingsText()).toBe(FILE_WITH_COMMENTS);
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

  it("adds a provider, tests it once, and replaces it by id while keeping the others", async () => {
    writeSettings(FILE_WITH_COMMENTS);
    vi.stubEnv("MY_GATEWAY_API_KEY", "gateway-key");
    const fetch = answerWith(200, DAILY_QUOTA);

    const added = await call("quota_provider_add", { definition: GATEWAY });

    expect(added).toMatchObject({ ok: true, added: "my-gateway-quota" });
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
    });
    expect((await loadSettings()).settings.providers.custom.map((item) => item.id)).toEqual([
      "other-quota",
    ]);
    expect(settingsText()).toContain("// keep me");
  });
});
