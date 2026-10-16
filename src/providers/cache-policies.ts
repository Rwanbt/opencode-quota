import { resolveAlibabaCodingPlanAuthCached } from "../lib/alibaba-auth.js";
import { anthropicLoginsIdentity } from "../lib/anthropic.js";
import { readAnthropicLogins } from "../lib/anthropic-auth.js";
import {
  API_KEY_LOGIN_VENDORS,
  API_KEY_VENDORS,
  type ApiKeyLoginSpec,
  resolveApiKey,
  resolveApiKeyLogin,
} from "../lib/api-key-resolver.js";
import { copilotLoginsIdentity, readCopilotLogins } from "../lib/copilot.js";
import type { QuotaProviderCachePolicy } from "../lib/entries.js";
import { AGY_FLAVOR } from "../lib/google-agy.js";
import { GEMINI_CLI_FLAVOR } from "../lib/google-gemini-cli.js";
import { googleLoginsIdentity, readGoogleLogins } from "../lib/google-oauth-quota.js";
import {
  DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
  resolveMimoConfigCached,
} from "../lib/mimo-config.js";
import { openaiLoginsIdentity, readOpenAILogins } from "../lib/openai.js";
import { consoleBaseUrl, resolveOpenCodeConsoleAuth } from "../lib/opencode-console-auth.js";
import { resolveOpenRouterAuthIdentity } from "../lib/openrouter.js";
import type { CanonicalQuotaProviderId } from "../lib/provider-registration.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../lib/quota-providers.js";
import { resolveQuotaProviderApiKey } from "../lib/quota-providers-remote.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
import { readXaiLogins, xaiLoginsIdentity } from "../lib/xai.js";

const UNCACHED = { kind: "uncached" } as const satisfies QuotaProviderCachePolicy;

type ResolvedCredential = {
  credential: string;
  principalKind?: "stable-id" | "credential";
  qualifiers?: readonly string[];
};

function resolvedCredentialPolicy(
  providerId: CanonicalQuotaProviderId,
  resolve: () => Promise<ResolvedCredential | null>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    async resolveIdentity() {
      const resolved = await resolve();
      if (!resolved) return null;
      return deriveResolvedAuthIdentity({
        providerId,
        principal: {
          kind: resolved.principalKind ?? "credential",
          value: resolved.credential,
        },
        qualifiers: resolved.qualifiers,
      });
    },
  };
}

function apiKeyPolicy(providerId: keyof typeof API_KEY_VENDORS): QuotaProviderCachePolicy {
  return resolvedCredentialPolicy(providerId, async () => {
    const resolved = await resolveApiKey(API_KEY_VENDORS[providerId]);
    return resolved ? { credential: resolved.key } : null;
  });
}

function apiKeyLoginPolicy(providerId: "zai" | "zhipu" | "opencode-go"): QuotaProviderCachePolicy {
  return resolvedCredentialPolicy(providerId, async () => {
    const resolved = await resolveApiKeyLogin(API_KEY_LOGIN_VENDORS[providerId]);
    return resolved.state === "configured" ? { credential: resolved.apiKey } : null;
  });
}

/** A key bound to one regional endpoint; the endpoint is part of the identity. */
function regionalKeyPolicy(
  providerId: CanonicalQuotaProviderId,
  spec: ApiKeyLoginSpec,
  endpoint: string,
): QuotaProviderCachePolicy {
  return resolvedCredentialPolicy(providerId, async () => {
    const resolved = await resolveApiKeyLogin(spec);
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [endpoint] }
      : null;
  });
}

async function resolveQuotaProviderDefinitionAuthIdentity(
  definition: QuotaProviderDefinition,
): Promise<ResolvedAuthIdentity | null> {
  if (definition.mode === "local-estimate") {
    return deriveResolvedAuthIdentity({
      providerId: `quota-providers:${definition.id}`,
      principal: { kind: "stable-id", value: "local-estimate" },
    });
  }

  const resolved = await resolveQuotaProviderApiKey(definition as RemoteApiQuotaProviderDefinition);
  return deriveResolvedAuthIdentity({
    providerId: `quota-providers:${definition.id}`,
    principal: resolved.key
      ? { kind: "credential", value: resolved.key }
      : { kind: "stable-id", value: "missing-credential" },
    qualifiers: [definition.providerId],
  });
}

const quotaProvidersCachePolicy: QuotaProviderCachePolicy = {
  kind: "resolved-auth",
  async resolveIdentity(_ctx, cacheContext) {
    const definitions = cacheContext.runtimeEligibleQuotaProviders;
    if (!definitions || definitions.length === 0) return null;

    const identities = await Promise.all(
      definitions.map(resolveQuotaProviderDefinitionAuthIdentity),
    );
    if (identities.some((identity) => identity === null)) return null;

    return composeResolvedAuthIdentities({
      providerId: "quota-providers",
      identities: identities as ResolvedAuthIdentity[],
    });
  },
};

export const PROVIDER_CACHE_POLICIES = {
  anthropic: {
    kind: "resolved-auth",
    resolveIdentity: async (ctx) =>
      anthropicLoginsIdentity(await readAnthropicLogins(), {
        binaryPath: ctx.config.anthropicBinaryPath,
      }),
  },
  copilot: {
    kind: "resolved-auth",
    resolveIdentity: async () => copilotLoginsIdentity(await readCopilotLogins()),
  },
  openai: {
    kind: "resolved-auth",
    resolveIdentity: async () => openaiLoginsIdentity(await readOpenAILogins()),
  },
  openrouter: {
    kind: "resolved-auth",
    resolveIdentity: () => resolveOpenRouterAuthIdentity(),
  },
  cursor: UNCACHED,
  "alibaba-token-plan": UNCACHED,
  "alibaba-coding-plan": resolvedCredentialPolicy("alibaba-coding-plan", async () => {
    const resolved = await resolveAlibabaCodingPlanAuthCached();
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.tier] }
      : null;
  }),
  "google-gemini-cli": {
    kind: "resolved-auth",
    resolveIdentity: async () =>
      googleLoginsIdentity(GEMINI_CLI_FLAVOR, await readGoogleLogins(GEMINI_CLI_FLAVOR)),
  },
  "google-agy": {
    kind: "resolved-auth",
    resolveIdentity: async () =>
      googleLoginsIdentity(AGY_FLAVOR, await readGoogleLogins(AGY_FLAVOR)),
  },
  zai: apiKeyLoginPolicy("zai"),
  zhipu: apiKeyLoginPolicy("zhipu"),
  "minimax-coding-plan": regionalKeyPolicy(
    "minimax-coding-plan",
    API_KEY_LOGIN_VENDORS["minimax-coding-plan"],
    "international",
  ),
  "minimax-china-coding-plan": regionalKeyPolicy(
    "minimax-china-coding-plan",
    API_KEY_LOGIN_VENDORS["minimax-china-coding-plan"],
    "china",
  ),
  "kimi-code-plan-global": regionalKeyPolicy(
    "kimi-code-plan-global",
    API_KEY_LOGIN_VENDORS["kimi-code-plan-global"],
    "global",
  ),
  "kimi-code-plan-cn": regionalKeyPolicy(
    "kimi-code-plan-cn",
    API_KEY_LOGIN_VENDORS["kimi-code-plan-cn"],
    "cn",
  ),
  deepseek: apiKeyPolicy("deepseek"),
  xai: {
    kind: "resolved-auth",
    resolveIdentity: async () => xaiLoginsIdentity(await readXaiLogins()),
  },
  xiaomi: resolvedCredentialPolicy("xiaomi", async () => {
    const resolved = await resolveMimoConfigCached({
      maxAgeMs: DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return resolved.state === "configured" ? { credential: resolved.config.cookie } : null;
  }),
  "opencode-go": apiKeyLoginPolicy("opencode-go"),
  opencode: resolvedCredentialPolicy("opencode", async () => {
    const resolved = await resolveOpenCodeConsoleAuth();
    if (resolved.state !== "configured") return null;
    const { credential } = resolved;
    // The identity distinguishes accounts within the same org (member budgets
    // are queried per account): org + account, else the account, else the
    // token. The Console URL qualifies it because org ids can collide across
    // self-hosted Console URLs.
    return {
      credential:
        credential.orgId && credential.accountId
          ? JSON.stringify([credential.orgId, credential.accountId])
          : (credential.orgId ?? credential.accountId ?? credential.accessToken),
      principalKind: credential.orgId || credential.accountId ? "stable-id" : "credential",
      qualifiers: [consoleBaseUrl(credential)],
    };
  }),
  "ollama-cloud": apiKeyPolicy("ollama-cloud"),
  "quota-providers": quotaProvidersCachePolicy,
} satisfies Record<CanonicalQuotaProviderId, QuotaProviderCachePolicy>;
