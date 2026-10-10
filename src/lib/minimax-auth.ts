import {
  API_KEY_LOGIN_CACHE_MAX_AGE_MS,
  API_KEY_LOGIN_VENDORS,
  type ApiKeyLoginDiagnostics,
  type ApiKeyLoginResult,
  getApiKeyLoginDiagnostics,
  parseApiKeyLogin,
  resolveApiKeyLogin,
} from "./api-key-resolver.js";
import type { MiniMaxQuotaEndpointId } from "./minimax-endpoints.js";
import type { AuthData } from "./types.js";

export const DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS = API_KEY_LOGIN_CACHE_MAX_AGE_MS;

export type ResolvedMiniMaxAuth =
  | Exclude<ApiKeyLoginResult, { state: "configured" }>
  | { state: "configured"; apiKey: string; endpoint: MiniMaxQuotaEndpointId };

export type MiniMaxAuthDiagnostics =
  | Exclude<ApiKeyLoginDiagnostics, { state: "configured" }>
  | (Extract<ApiKeyLoginDiagnostics, { state: "configured" }> & {
      endpoint: MiniMaxQuotaEndpointId;
    });

// The international and China plans have separate keys; the China env key never
// configures the international provider.
const INTERNATIONAL = API_KEY_LOGIN_VENDORS["minimax-coding-plan"];
const CHINA = API_KEY_LOGIN_VENDORS["minimax-china-coding-plan"];

function withEndpoint<T extends { state: string }>(value: T, endpoint: MiniMaxQuotaEndpointId): T {
  return value.state === "configured" ? { ...value, endpoint } : value;
}

export function resolveMiniMaxAuth(auth: AuthData | null | undefined): ResolvedMiniMaxAuth {
  return withEndpoint(
    parseApiKeyLogin(INTERNATIONAL, auth),
    "international",
  ) as ResolvedMiniMaxAuth;
}

export function resolveMiniMaxChinaAuth(auth: AuthData | null | undefined): ResolvedMiniMaxAuth {
  return withEndpoint(parseApiKeyLogin(CHINA, auth), "china") as ResolvedMiniMaxAuth;
}

export async function resolveMiniMaxAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedMiniMaxAuth> {
  return withEndpoint(
    await resolveApiKeyLogin(INTERNATIONAL, params),
    "international",
  ) as ResolvedMiniMaxAuth;
}

export async function resolveMiniMaxChinaAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedMiniMaxAuth> {
  return withEndpoint(await resolveApiKeyLogin(CHINA, params), "china") as ResolvedMiniMaxAuth;
}

export async function getMiniMaxAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<MiniMaxAuthDiagnostics> {
  return withEndpoint(
    await getApiKeyLoginDiagnostics(INTERNATIONAL, params),
    "international",
  ) as MiniMaxAuthDiagnostics;
}

export async function getMiniMaxChinaAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<MiniMaxAuthDiagnostics> {
  return withEndpoint(
    await getApiKeyLoginDiagnostics(CHINA, params),
    "china",
  ) as MiniMaxAuthDiagnostics;
}
