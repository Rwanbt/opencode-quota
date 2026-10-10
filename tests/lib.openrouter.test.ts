import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasOpenRouterApiKeyConfigured,
  queryOpenRouterQuota,
  resolveOpenRouterApiKey,
  resolveOpenRouterAuthIdentity,
} from "../src/lib/openrouter.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthResolution,
  resolveQuotaProviderApiKey,
} from "../src/lib/quota-providers-remote.js";
import { deriveResolvedAuthIdentity } from "../src/lib/resolved-auth-identity.js";

vi.mock("../src/lib/quota-providers-remote.js", () => ({
  fetchRemoteQuotaProvider: vi.fn(),
  resolveQuotaProviderApiKey: vi.fn(),
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(async () => `rai1_${"a".repeat(43)}`),
}));

const OPENROUTER_KEY_SOURCE = {
  id: "openrouter",
  providerId: "openrouter",
  label: "OpenRouter",
  mode: "remote-api",
  url: "https://openrouter.ai/api/v1/key",
  apiKeyEnv: "OPENROUTER_API_KEY",
  format: "openrouter-key-v1",
} as const;

const SECRET_CANARY = "openrouter-secret-canary";

function resolvedAuth(
  overrides: Partial<QuotaProviderAuthResolution> = {},
): QuotaProviderAuthResolution {
  return {
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter quota", () => {
  it("derives cache identity from the winning trusted key without exposing it", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValueOnce(
      resolvedAuth({ key: SECRET_CANARY, source: "env" }),
    );

    const identity = await resolveOpenRouterAuthIdentity();

    expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECRET_CANARY },
    });
    expect(identity).not.toContain(SECRET_CANARY);
  });

  it("uses the standard OpenRouter credential sources and key endpoint", async () => {
    await resolveOpenRouterApiKey();

    expect(resolveQuotaProviderApiKey).toHaveBeenCalledWith(OPENROUTER_KEY_SOURCE);
  });

  it("queries with the passed resolution and does not look up credentials again", async () => {
    const resolved = resolvedAuth({
      key: SECRET_CANARY,
      source: "opencode.db",
      checkedPaths: ["source:opencode.db"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValueOnce({ success: true, rows: [] });

    await queryOpenRouterQuota({ requestTimeoutMs: 1234, resolved });

    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledWith(
      OPENROUTER_KEY_SOURCE,
      SECRET_CANARY,
      1234,
    );
  });

  it("does not make a request when the passed resolution has no key", async () => {
    const resolved = resolvedAuth({
      source: null,
      checkedPaths: ["env:OPENROUTER_API_KEY", "/tmp/opencode.json"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });

    await expect(queryOpenRouterQuota({ resolved })).resolves.toBeNull();
    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("does not make a request when no trusted key exists", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(resolvedAuth());

    await expect(hasOpenRouterApiKeyConfigured()).resolves.toBe(false);
    await expect(resolveOpenRouterApiKey()).resolves.toEqual(resolvedAuth());
    expect(fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("returns the safe remote error unchanged", async () => {
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({ success: false, error: "HTTP 401" });

    const result = await queryOpenRouterQuota({
      resolved: resolvedAuth({ key: SECRET_CANARY, source: "env" }),
    });
    expect(result).toEqual({ success: false, error: "HTTP 401" });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });
});
