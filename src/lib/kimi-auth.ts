import {
  API_KEY_LOGIN_CACHE_MAX_AGE_MS,
  API_KEY_LOGIN_VENDORS,
  type ApiKeyLoginDiagnostics,
  type ApiKeyLoginResult,
  parseApiKeyLogin,
  resolveApiKeyLogin,
  resolveApiKeyLoginWithDiagnostics,
} from "./api-key-resolver.js";
import type { KimiQuotaEndpointId } from "./kimi-endpoints.js";
import type { AuthData } from "./types.js";

export const DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS = API_KEY_LOGIN_CACHE_MAX_AGE_MS;

export type ResolvedKimiAuth =
  | Exclude<ApiKeyLoginResult, { state: "configured" }>
  | { state: "configured"; apiKey: string; endpoint: KimiQuotaEndpointId };

export type KimiAuthDiagnostics =
  | Exclude<ApiKeyLoginDiagnostics, { state: "configured" }>
  | (Extract<ApiKeyLoginDiagnostics, { state: "configured" }> & {
      endpoint: KimiQuotaEndpointId;
    });

export type ResolvedKimiAuthWithDiagnostics = {
  auth: ResolvedKimiAuth;
  diagnostics: KimiAuthDiagnostics;
};

// Each region has its own key; the legacy aliases (`kimi`, `kimi-code`, ...) belong to CN.
const GLOBAL = API_KEY_LOGIN_VENDORS["kimi-code-plan-global"];
const CN = API_KEY_LOGIN_VENDORS["kimi-code-plan-cn"];

function withEndpoint<T extends { state: string }>(value: T, endpoint: KimiQuotaEndpointId): T {
  return value.state === "configured" ? { ...value, endpoint } : value;
}

export function resolveKimiGlobalAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return withEndpoint(parseApiKeyLogin(GLOBAL, auth), "global") as ResolvedKimiAuth;
}

export function resolveKimiCnAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  return withEndpoint(parseApiKeyLogin(CN, auth), "cn") as ResolvedKimiAuth;
}

export async function resolveKimiGlobalAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return withEndpoint(await resolveApiKeyLogin(GLOBAL, params), "global") as ResolvedKimiAuth;
}

export async function resolveKimiCnAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return withEndpoint(await resolveApiKeyLogin(CN, params), "cn") as ResolvedKimiAuth;
}

async function resolveWithDiagnostics(
  spec: typeof GLOBAL | typeof CN,
  endpoint: KimiQuotaEndpointId,
  params?: { maxAgeMs?: number },
): Promise<ResolvedKimiAuthWithDiagnostics> {
  const resolved = await resolveApiKeyLoginWithDiagnostics(spec, params);
  return {
    auth: withEndpoint(resolved.auth, endpoint) as ResolvedKimiAuth,
    diagnostics: withEndpoint(resolved.diagnostics, endpoint) as KimiAuthDiagnostics,
  };
}

export function resolveKimiGlobalAuthWithDiagnosticsCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuthWithDiagnostics> {
  return resolveWithDiagnostics(GLOBAL, "global", params);
}

export function resolveKimiCnAuthWithDiagnosticsCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuthWithDiagnostics> {
  return resolveWithDiagnostics(CN, "cn", params);
}
