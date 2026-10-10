/**
 * Ollama Cloud usage API client.
 *
 * Fetches session, weekly, and monthly usage fractions from the authenticated
 * Ollama Cloud usage endpoint.
 */

import { API_KEY_VENDORS, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { isRecord } from "./json-guards.js";
import type { OllamaCloudResult, OllamaCloudWindow } from "./types.js";

const OLLAMA_CLOUD_USAGE_URL = "https://ollama.com/api/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;

function sanitizeRemoteSingleLineText(text: string): string {
  return sanitizeSingleLineDisplayText(text).replace(/\p{Cf}/gu, "");
}

function sanitizeMessage(text: string, secret?: string, maxLength = 200): string {
  const redacted = secret ? text.split(secret).join("[redacted]") : text;
  const sanitized = sanitizeRemoteSingleLineText(redacted);
  return (sanitized || "unknown").slice(0, maxLength);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Ollama Cloud usage API response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Ollama Cloud usage API response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseWindow(value: unknown): OllamaCloudWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usageFraction = value.usage;
  if (
    typeof usageFraction !== "number" ||
    !Number.isFinite(usageFraction) ||
    usageFraction < 0 ||
    usageFraction > 1
  ) {
    return undefined;
  }

  const usagePercent = usageFraction * 100;
  return {
    usageFraction,
    usagePercent,
    percentRemaining: 100 - usagePercent,
  };
}

const OLLAMA_CLOUD_WINDOWS = [
  ["session", "Session"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
] as const;

function parseOllamaCloudUsage(payload: unknown): OllamaCloudResult {
  if (!isRecord(payload)) {
    return {
      success: false,
      error: "Ollama Cloud usage API returned an unexpected response shape",
    };
  }

  const limits = isRecord(payload.limits) ? payload.limits : {};
  const windows: Partial<Record<"session" | "weekly" | "monthly", OllamaCloudWindow>> = {};
  const rowErrors: string[] = [];
  for (const [key, name] of OLLAMA_CLOUD_WINDOWS) {
    const window = parseWindow(limits[key]);
    if (window) windows[key] = window;
    else if (limits[key] !== undefined) rowErrors.push(`${name}: ignored invalid usage fraction`);
  }

  if (!windows.session && !windows.weekly && !windows.monthly) {
    return {
      success: false,
      error: "Ollama Cloud usage API returned no usable usage data",
    };
  }

  return {
    success: true,
    ...windows,
    ...(rowErrors.length > 0 ? { rowErrors } : {}),
  };
}

export async function queryOllamaCloudQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<OllamaCloudResult> {
  const resolved = await resolveApiKey(API_KEY_VENDORS["ollama-cloud"]);
  if (!resolved) return null;

  try {
    return await fetchWithTimeout(OLLAMA_CLOUD_USAGE_URL, {
      request: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: resolved.key,
        },
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
        if (!response.ok) {
          const snippet = sanitizeMessage(text, resolved.key);
          return {
            success: false,
            error: `Ollama Cloud usage API error ${response.status}: ${snippet}`,
          };
        }

        return parseOllamaCloudUsage(JSON.parse(text) as unknown);
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), resolved.key),
    };
  }
}
