import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext, QuotaToastEntry } from "../src/lib/entries.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";
import { createRuntimeProviderIdResolver } from "../src/lib/runtime-provider-ids.js";

const runtimeMocks = vi.hoisted(() => ({
  root: "",
  resolveQuotaProviderApiKey: vi.fn(),
  fetchRemoteQuotaProvider: vi.fn(),
  collectLocalQuotaProviderEstimate: vi.fn(),
  inspectLocalQuotaProviderState: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${runtimeMocks.root}/data`,
    configDir: `${runtimeMocks.root}/config`,
    cacheDir: `${runtimeMocks.root}/cache`,
    stateDir: `${runtimeMocks.root}/state`,
  }),
}));

vi.mock("../src/lib/quota-providers-remote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-providers-remote.js")>();
  return {
    ...actual,
    resolveQuotaProviderApiKey: runtimeMocks.resolveQuotaProviderApiKey,
    fetchRemoteQuotaProvider: runtimeMocks.fetchRemoteQuotaProvider,
  };
});

vi.mock("../src/lib/quota-providers-local.js", () => ({
  collectLocalQuotaProviderEstimate: runtimeMocks.collectLocalQuotaProviderEstimate,
  inspectLocalQuotaProviderState: runtimeMocks.inspectLocalQuotaProviderState,
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(
    async (params: { providerId: string; principal: { value: string } }) =>
      `opaque:${params.providerId}:${params.principal.value}`,
  ),
  composeResolvedAuthIdentities: vi.fn(
    async (params: { providerId: string; identities: readonly string[] }) =>
      `opaque:${params.providerId}:${params.identities.join("|")}`,
  ),
}));

import { __resetQuotaStateForTests, fetchQuotaProviderResult } from "../src/lib/quota-state.js";
import { quotaProvidersProvider } from "../src/providers/quota-providers.js";
import { getProviders } from "../src/providers/registry.js";

function remote(
  id: string,
  providerId = id,
  modelIds?: string[],
): RemoteApiQuotaProviderDefinition {
  return {
    id,
    providerId,
    label: id,
    mode: "remote-api",
    url: `https://${id}.example/accounting`,
    format: "quota-v1",
    ...(modelIds ? { modelIds } : {}),
  };
}

function local(id: string, label = id): QuotaProviderDefinition {
  return {
    id,
    providerId: id,
    label,
    mode: "local-estimate",
    windows: [{ id: "daily", label: "Daily", type: "utc-day", requestLimit: 10 }],
  };
}

function accounting(resultType: QuotaToastEntry["accounting"]["resultType"]) {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "user_configured",
    authority: "provider_reported",
  } as const;
}

function percentEntry(name: string, percentRemaining = 50): QuotaToastEntry {
  return { accounting: accounting("quota"), name, percentRemaining };
}

function valueEntry(name: string, value: string): QuotaToastEntry {
  return { accounting: accounting("balance"), kind: "value", name, value };
}

function context(
  definitions: QuotaProviderDefinition[],
  availableProviderIds: string[],
  overrides: Partial<QuotaProviderContext["config"]> = {},
): QuotaProviderContext {
  const client = {
    config: {
      providers: async () => ({
        data: { providers: availableProviderIds.map((id) => ({ id })) },
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
      quotaProviders: definitions,
      ...overrides,
    },
  };
}

describe("quota-providers aggregate provider", () => {
  beforeEach(() => {
    runtimeMocks.root = mkdtempSync(join(tmpdir(), "opencode-quota-provider-cache-"));
    __resetQuotaStateForTests();
    runtimeMocks.resolveQuotaProviderApiKey.mockReset().mockResolvedValue({
      key: "secret",
      source: "opencode.db",
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    });
    runtimeMocks.fetchRemoteQuotaProvider.mockReset().mockResolvedValue({
      success: true,
      entries: [],
    });
    runtimeMocks.collectLocalQuotaProviderEstimate.mockReset().mockResolvedValue({
      entries: [],
      state: { version: 1, definitionId: "local", providerId: "local", updatedAt: 1, messages: [] },
      unpricedMessageCount: 0,
    });
    runtimeMocks.inspectLocalQuotaProviderState.mockReset().mockResolvedValue({
      path: "/state/local.json",
      exists: true,
      health: "healthy",
      version: 1,
      lastUpdatedAt: 1,
    });
  });

  afterEach(() => {
    rmSync(runtimeMocks.root, { recursive: true, force: true });
  });

  const alibabaTuning: QuotaProviderDefinition = {
    id: "alibaba-coding-plan",
    providerId: "alibaba-coding-plan",
    label: "alibaba-coding-plan",
    mode: "local-estimate",
    windows: (
      [
        ["five-hour", 300, 1200],
        ["weekly", 10080, 9000],
        ["monthly", 43200, 18000],
      ] as const
    ).map(([id, durationMinutes, requestLimit]) => ({
      id,
      label: id,
      type: "rolling",
      durationMinutes,
      requestLimit,
    })),
  };

  it.each([
    ["no runtime match", [remote("stable", "provider-one", ["model-a"])], ["unrelated"], {}, []],
    [
      "an exact runtime match",
      [remote("stable", "provider-one", ["model-a"])],
      ["provider-one"],
      {},
      ["stable"],
    ],
    [
      "a session provider that disagrees with the model prefix",
      [remote("stable", "provider-one", ["model-a"])],
      ["provider-one"],
      {
        onlyCurrentModel: true,
        currentModel: "provider-one/model-a",
        currentProviderID: "provider-two",
      },
      [],
    ],
    [
      "project providers as read-only matching inputs",
      [
        remote("stable-one", "project-provider", ["model-a"]),
        remote("stable-two", "other-provider"),
      ],
      ["project-provider"],
      {},
      ["stable-one"],
    ],
    [
      "the current model of a project provider",
      [
        remote("stable-one", "project-provider", ["model-a"]),
        remote("stable-two", "other-provider"),
      ],
      ["project-provider"],
      { onlyCurrentModel: true, currentProviderID: "project-provider", currentModel: "model-a" },
      ["stable-one"],
    ],
    [
      "a slash-containing model id when the provider is supplied",
      [remote("openrouter-usage", "openrouter", ["openai/gpt-4o"])],
      ["openrouter"],
      { onlyCurrentModel: true, currentProviderID: "openrouter", currentModel: "openai/gpt-4o" },
      ["openrouter-usage"],
    ],
    [
      "maintained Alibaba tuning, which is skipped",
      [alibabaTuning, remote("custom")],
      ["alibaba-coding-plan", "custom"],
      {},
      ["custom"],
    ],
  ] as const)("selects definitions for %s", async (_name, definitions, ids, overrides, expected) => {
    const ctx = context([...definitions], [...ids], overrides);
    await expect(quotaProvidersProvider.isAvailable(ctx)).resolves.toBe(expected.length > 0);
    const result = await quotaProvidersProvider.fetch(ctx);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.sourceId) ?? []).toEqual(expected);
  });

  it("treats a slash-containing current model as opaque when matching the session", () => {
    expect(
      quotaProvidersProvider.matchesCurrentModel?.("openai/gpt-4o", {
        enabledProviders: "auto",
        currentProviderID: "openrouter",
        quotaProviders: [remote("openrouter-usage", "openrouter", ["openai/gpt-4o"])],
      }),
    ).toBe(true);
  });

  it("fails closed when the runtime provider catalog cannot be read", async () => {
    const brokenCatalog = context([remote("stable", "provider-one")], ["provider-one"]);
    brokenCatalog.client.config.providers = async () => {
      throw new Error("catalog unavailable");
    };
    await expect(quotaProvidersProvider.fetch(brokenCatalog)).resolves.toEqual({
      attempted: true,
      entries: [],
      errors: [
        {
          label: "Quota providers",
          message: "Failed to read exact runtime provider identities",
        },
      ],
    });
  });

  it("runs selected definitions in config order even when completion order differs", async () => {
    const definitions = [remote("first"), remote("second")];
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(
      async (definition: RemoteApiQuotaProviderDefinition) => {
        if (definition.id === "first") await new Promise((resolve) => setTimeout(resolve, 10));
        return { success: true, entries: [percentEntry(definition.id)] };
      },
    );

    const result = await quotaProvidersProvider.fetch(context(definitions, ["first", "second"]));
    expect(result.entries.map((entry) => entry.name)).toEqual(["first", "second"]);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.sourceId)).toEqual([
      "first",
      "second",
    ]);
    expect(result.statusDetails).toBeUndefined();
  });

  it("isolates the production nested remote cache by the winning credential", async () => {
    const definition = remote("accounted", "provider-one");
    const ctx = context([definition], ["provider-one"], { providerCacheTtlMs: 60_000 });
    const provider = getProviders().find((candidate) => candidate.id === "quota-providers");
    if (!provider) throw new Error("Expected aggregate provider");

    let credential = "account-one";
    runtimeMocks.resolveQuotaProviderApiKey.mockImplementation(async () => ({
      key: credential,
      source: "opencode.db",
      checkedPaths: [],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    }));
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(async (_definition, key) => ({
      success: true,
      entries: [
        key === "account-one" ? percentEntry("Account one", 70) : percentEntry("Account two", 30),
      ],
    }));

    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    const cached = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    credential = "account-two";
    const second = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });

    expect(first.entries[0]?.name).toBe("Account one");
    expect(cached.entries[0]?.name).toBe("Account one");
    expect(second.entries[0]?.name).toBe("Account two");
    expect(runtimeMocks.fetchRemoteQuotaProvider).toHaveBeenCalledTimes(2);
  });

  it("refreshes mixed local data while retaining remote definition caching", async () => {
    runtimeMocks.fetchRemoteQuotaProvider.mockResolvedValue({
      success: true,
      entries: [valueEntry("Remote", "$5.00")],
    });
    let localCall = 0;
    runtimeMocks.collectLocalQuotaProviderEstimate.mockImplementation(async () => {
      localCall += 1;
      return {
        entries: [percentEntry("Local", 100 - localCall)],
        state: {
          version: 1,
          definitionId: "mixed-local",
          providerId: "mixed-local",
          updatedAt: localCall,
          messages: [],
        },
        unpricedMessageCount: 0,
      };
    });
    const ctx = context(
      [remote("mixed-remote"), local("mixed-local", "Mixed Local")],
      ["mixed-remote", "mixed-local"],
      { providerCacheTtlMs: 0 },
    );

    const first = await quotaProvidersProvider.fetch(ctx);
    ctx.config.providerCacheTtlMs = 60_000;
    const second = await quotaProvidersProvider.fetch(ctx);

    expect(runtimeMocks.fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.collectLocalQuotaProviderEstimate).toHaveBeenCalledTimes(2);
    expect(first.entries.map((entry) => entry.name)).toEqual(["Remote", "Local"]);
    expect(second.entries.find((entry) => entry.name === "Local")?.percentRemaining).toBe(98);
  });

  it("preserves successful entries when another definition fails", async () => {
    runtimeMocks.fetchRemoteQuotaProvider.mockImplementation(
      async (definition: RemoteApiQuotaProviderDefinition) =>
        definition.id === "bad"
          ? { success: false, error: "HTTP 503" }
          : { success: true, entries: [valueEntry("good", "$5.00")] },
    );

    const result = await quotaProvidersProvider.fetch(
      context([remote("good"), remote("bad")], ["good", "bad"]),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.errors).toEqual([{ label: "bad", message: "HTTP 503" }]);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.outcome)).toEqual([
      "success",
      "http_error",
    ]);
  });

  it.each([
    ["HTTP 503", { outcome: "http_error", httpStatus: 503 }],
    ["Redirect rejected", { outcome: "redirect_error" }],
    ["Request timeout after 5s", { outcome: "timeout" }],
    ["Response exceeded 262144 bytes", { outcome: "body_too_large" }],
    ["Expected a JSON response", { outcome: "invalid_content_type" }],
    ["Invalid JSON response", { outcome: "invalid_json" }],
    ["Invalid quota-v1 response", { outcome: "invalid_response" }],
    ["Failed to read accounting data", { outcome: "network_error" }],
  ])("classifies the remote error %j in diagnostics", async (error, expected) => {
    runtimeMocks.fetchRemoteQuotaProvider.mockResolvedValue({ success: false, error });
    const result = await quotaProvidersProvider.fetch(context([remote("bad")], ["bad"]));
    expect(result.errors).toEqual([{ label: "bad", message: error }]);
    expect(result.diagnostics?.[0]).toMatchObject({ attempted: true, entryCount: 0, ...expected });
  });

  it("reports a missing API key without calling the endpoint", async () => {
    runtimeMocks.resolveQuotaProviderApiKey.mockResolvedValue({
      source: null,
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: [],
    });
    const result = await quotaProvidersProvider.fetch(context([remote("keyless")], ["keyless"]));
    expect(result.errors).toEqual([{ label: "keyless", message: "API key not configured" }]);
    expect(result.diagnostics?.[0]).toMatchObject({
      attempted: false,
      credentialSource: null,
      outcome: "missing_credential",
      checkedPaths: ["/trusted/opencode.json"],
    });
    expect(runtimeMocks.fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("propagates json-v1 row errors as partial output while keeping source diagnostics successful", async () => {
    const definition: RemoteApiQuotaProviderDefinition = {
      ...remote("json-partial", "json-provider"),
      label: "JSON Partial",
      format: "json-v1",
      adapter: {
        mappings: [
          {
            resultType: "usage",
            name: "Usage",
            metric: { type: "value", valueType: "used", value: { path: ["used"] } },
          },
        ],
      },
    };
    runtimeMocks.fetchRemoteQuotaProvider.mockResolvedValue({
      success: true,
      entries: [valueEntry("JSON Partial Usage", "0")],
      rowErrors: ["adapter.mappings[0].metric.value was null at row 1"],
    });

    const result = await quotaProvidersProvider.fetch(context([definition], ["json-provider"]));

    expect(result.entries[0]?.accounting.sourceId).toBe("json-partial");
    expect(result.errors).toEqual([
      {
        label: "JSON Partial",
        message: "adapter.mappings[0].metric.value was null at row 1",
      },
    ]);
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "json-partial",
      format: "json-v1",
      outcome: "success",
      entryCount: 1,
    });
  });

  it.each([
    ["opencode.db", "opencode_db"],
    ["opencode.json", "global_opencode_json"],
    ["opencode.jsonc", "global_opencode_jsonc"],
    ["env", "explicit_env"],
  ])("reports stable diagnostic identity for a %s key without secret values", async (source, credentialSource) => {
    runtimeMocks.resolveQuotaProviderApiKey.mockResolvedValue({
      key: "secret",
      source,
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    });
    const result = await quotaProvidersProvider.fetch(
      context([remote("stable", "runtime-provider")], ["runtime-provider"]),
    );
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "stable",
      providerId: "runtime-provider",
      mode: "remote-api",
      format: "quota-v1",
      credentialSource,
      checkedPaths: ["/trusted/opencode.json"],
      credentialDatabasePaths: ["/trusted/opencode.db"],
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret");
  });

  it("returns a local-state error without blocking other definitions", async () => {
    runtimeMocks.collectLocalQuotaProviderEstimate.mockRejectedValue(new Error("disk"));

    const result = await quotaProvidersProvider.fetch(
      context([local("local", "Local")], ["local"]),
    );
    expect(result.errors).toEqual([
      { label: "Local", message: "Failed to update local accounting state" },
    ]);
    expect(result.diagnostics?.[0]).toMatchObject({
      sourceId: "local",
      outcome: "local_state_error",
      statePath: "/state/local.json",
    });
  });
});
