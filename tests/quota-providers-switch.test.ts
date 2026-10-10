import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaProviderContext } from "../src/lib/entries.js";
import { bindCredentialSource } from "../src/lib/opencode-auth.js";
import {
  customQuotaProviderDefinitions,
  describeQuotaProviderRequest,
  type QuotaProviderDefinition,
  type RemoteApiQuotaProviderDefinition,
  validateQuotaProviders,
} from "../src/lib/quota-providers.js";
import { fetchRemoteQuotaProvider } from "../src/lib/quota-providers-remote.js";
import { createRuntimeProviderIdResolver } from "../src/lib/runtime-provider-ids.js";
import { quotaProvidersProvider } from "../src/providers/quota-providers.js";

let root: string;
let unbindCredentials: (() => void) | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota.providers.switch."));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});

afterEach(async () => {
  unbindCredentials?.();
  unbindCredentials = undefined;
  await rm(root, { recursive: true, force: true });
});

const ON = {
  id: "on-gateway",
  mode: "remote-api",
  url: "https://on.example/quota",
  format: "quota-v1",
  apiKeyEnv: "ON_GATEWAY_KEY",
} as const;

const OFF = {
  id: "off-gateway",
  mode: "remote-api",
  url: "https://off.example/v1/quota",
  format: "quota-v1",
  apiKeyEnv: "OFF_GATEWAY_KEY",
  enabled: false,
} as const;

const OFF_LOCAL = {
  id: "off-local",
  mode: "local-estimate",
  windows: [{ id: "daily", type: "utc-day", requestLimit: 100 }],
  enabled: false,
} as const;

function definitions(list: unknown[]): QuotaProviderDefinition[] {
  const result = validateQuotaProviders(list);
  if (!result.value) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function context(quotaProviders: QuotaProviderDefinition[]): QuotaProviderContext {
  const client = {
    config: {
      providers: async () => ({
        data: { providers: quotaProviders.map((definition) => ({ id: definition.providerId })) },
      }),
      get: async () => ({ data: {} }),
    },
  };
  return {
    client,
    resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
    config: {
      anthropicBinaryPath: "claude",
      cursorPlan: "none",
      opencodeGoWindows: ["rolling", "weekly", "monthly"],
      enabledProviders: "auto",
      quotaProviders,
    },
  };
}

describe("the enabled field of a custom provider", () => {
  it("is on when missing, so a hand-written provider runs", () => {
    const [hand] = definitions([ON]);

    expect(hand).not.toHaveProperty("enabled");
    expect(customQuotaProviderDefinitions([hand])).toEqual([hand]);
  });

  it("keeps false, and a switched-off provider does not run", () => {
    const list = definitions([ON, OFF, OFF_LOCAL]);

    expect(list.map((definition) => definition.enabled)).toEqual([undefined, false, false]);
    expect(customQuotaProviderDefinitions(list).map((definition) => definition.id)).toEqual([
      "on-gateway",
    ]);
  });

  it("accepts only true or false", () => {
    expect(validateQuotaProviders([{ ...ON, enabled: "no" }]).issues).toEqual([
      { key: "quotaProviders[0].enabled", message: "expected true or false" },
    ]);
  });

  it("is described by scheme, host, path and key source, never the key", () => {
    vi.stubEnv("OFF_GATEWAY_KEY", "off-key-value");
    const [off, local] = definitions([{ ...OFF, providerId: "vendor" }, OFF_LOCAL]);

    expect(describeQuotaProviderRequest(off)).toEqual({
      url: "https://off.example/v1/quota",
      key: `environment variable OFF_GATEWAY_KEY, else OpenCode's API key for provider "vendor"`,
      insecure: false,
    });
    expect(describeQuotaProviderRequest({ ...off, apiKeyEnv: undefined })?.key).toBe(
      `OpenCode's API key for provider "vendor"`,
    );
    expect(describeQuotaProviderRequest(local)).toBeNull();
  });

  it.each([
    { url: "http://localhost:8080/quota", insecure: false },
    { url: "http://127.0.0.1/quota", insecure: false },
    { url: "http://[::1]:9000/quota", insecure: false },
    { url: "http://127.0.0.2/quota", insecure: true },
    { url: "http://quota.localhost/quota", insecure: true },
  ])("flags plain HTTP to any host but this computer's own: $url", ({ url, insecure }) => {
    const [definition] = definitions([{ ...ON, url }]);

    expect(describeQuotaProviderRequest(definition)).toMatchObject({ url, insecure });
  });
});

describe("the fetch of a switched-off custom provider", () => {
  it("sends no request and no key, even when called directly", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const [off] = definitions([OFF]);

    const result = await fetchRemoteQuotaProvider(off as RemoteApiQuotaProviderDefinition, "key");

    expect(result).toEqual({ success: false, error: "Provider is switched off" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a switched-off custom provider in the plugin", () => {
  it("makes no request and reads no key, while a switched-on one is fetched", async () => {
    const realEnv = process.env;
    const variableReads: string[] = [];
    const loginReads: string[][] = [];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: "quota-v1", entries: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ON_GATEWAY_KEY", "on-key");
    vi.stubEnv("OFF_GATEWAY_KEY", "off-key");
    unbindCredentials = bindCredentialSource({
      kind: "sqlite",
      async readRows({ integrationIds }) {
        loginReads.push([...integrationIds]);
        return [];
      },
    });
    const ctx = context(definitions([ON, OFF, OFF_LOCAL]));
    process.env = new Proxy(realEnv, {
      get(target, name) {
        if (typeof name === "string") variableReads.push(name);
        return Reflect.get(target, name);
      },
    });

    let result: Awaited<ReturnType<typeof quotaProvidersProvider.fetch>>;
    try {
      result = await quotaProvidersProvider.fetch(ctx);
    } finally {
      process.env = realEnv;
    }

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(ON.url, expect.anything());
    expect(variableReads).toContain("ON_GATEWAY_KEY");
    expect(variableReads).not.toContain("OFF_GATEWAY_KEY");
    expect(loginReads.flat()).not.toContain("off-gateway");
    expect(result.diagnostics?.map((diagnostic) => diagnostic.sourceId)).toEqual(["on-gateway"]);
    // A local estimate that ran would have written its state file.
    expect(existsSync(join(root, "state", "opencode", "opencode-quota", "quota-providers"))).toBe(
      false,
    );
  });
});
