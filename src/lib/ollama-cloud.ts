/**
 * Ollama Cloud balance API client (https://docs.ollama.com/api/balance).
 *
 * Fetches included credits (credit plans) or session and weekly limits (legacy plans),
 * plus purchased credits, from the authenticated Ollama Cloud balance endpoint.
 */

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { finiteNumber, isRecord } from "./json-guards.js";
import type { OllamaCloudIncludedCredits, OllamaCloudResult, OllamaCloudWindow } from "./types.js";

const OLLAMA_CLOUD_BALANCE_URL = "https://ollama.com/api/balance";
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
      throw new Error(`Ollama Cloud balance API response exceeded ${maxBytes} bytes`);
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
        throw new Error(`Ollama Cloud balance API response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Canonical ISO time, or undefined when the value is not a parseable time. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeMs = Date.parse(value);
  return Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : undefined;
}

/** A legacy plan limit: `{ remaining_percent: 0..100, resets_at }`. */
function parseLegacyWindow(value: unknown): OllamaCloudWindow | undefined {
  if (!isRecord(value)) return undefined;
  const percentRemaining = finiteNumber(value.remaining_percent);
  if (percentRemaining === undefined || percentRemaining < 0 || percentRemaining > 100) {
    return undefined;
  }
  const resetTimeIso = isoTime(value.resets_at);
  return { percentRemaining, ...(resetTimeIso ? { resetTimeIso } : {}) };
}

/** A credit plan's included credits: `{ balance_usd, allowance_usd, period: { from, until } }`. */
function parseIncludedCredits(
  included: Record<string, unknown>,
): OllamaCloudIncludedCredits | undefined {
  const balanceUsd = finiteNumber(included.balance_usd);
  const allowanceUsd = finiteNumber(included.allowance_usd);
  if (balanceUsd === undefined || allowanceUsd === undefined || allowanceUsd < 0) {
    return undefined;
  }

  const period = isRecord(included.period) ? included.period : undefined;
  const periodStartIso = isoTime(period?.from);
  const resetTimeIso = isoTime(period?.until);
  return {
    balanceUsd,
    allowanceUsd,
    // A plan without an included allowance has no share left to show.
    ...(allowanceUsd > 0
      ? { percentRemaining: Math.min(100, Math.max(0, (balanceUsd / allowanceUsd) * 100)) }
      : {}),
    ...(periodStartIso ? { periodStartIso } : {}),
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };
}

function parsePurchasedUsd(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const balanceUsd = finiteNumber(value.balance_usd);
  return balanceUsd !== undefined && balanceUsd >= 0 ? balanceUsd : undefined;
}

function parseOllamaCloudBalance(payload: unknown): OllamaCloudResult {
  if (!isRecord(payload)) {
    return {
      success: false,
      error: "Ollama Cloud balance API returned an unexpected response shape",
    };
  }

  const included = isRecord(payload.included) ? payload.included : undefined;
  const hasCreditFields =
    included?.balance_usd !== undefined || included?.allowance_usd !== undefined;
  const includedCredits = included && hasCreditFields ? parseIncludedCredits(included) : undefined;
  const session = parseLegacyWindow(included?.session);
  const weekly = parseLegacyWindow(included?.weekly);
  const purchasedUsd = parsePurchasedUsd(payload.purchased);

  const rowErrors: string[] = [];
  if (!included) {
    rowErrors.push("Included: missing or invalid, expected an object");
  } else if (!hasCreditFields && included.session === undefined && included.weekly === undefined) {
    rowErrors.push("Included: invalid, expected credits or session and weekly limits");
  }
  if (hasCreditFields && !includedCredits) {
    rowErrors.push("Included credits: ignored invalid balance");
  }
  if (included?.session !== undefined && !session) {
    rowErrors.push("Session: ignored invalid remaining percent");
  }
  if (included?.weekly !== undefined && !weekly) {
    rowErrors.push("Weekly: ignored invalid remaining percent");
  }
  if (payload.purchased !== undefined && purchasedUsd === undefined) {
    rowErrors.push("Purchased credits: ignored invalid balance");
  }

  if (!includedCredits && !session && !weekly && purchasedUsd === undefined) {
    return { success: false, error: "Ollama Cloud returned no limits or balance" };
  }

  return {
    success: true,
    ...(includedCredits ? { includedCredits } : {}),
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    ...(purchasedUsd !== undefined ? { purchasedUsd } : {}),
    ...(rowErrors.length > 0 ? { rowErrors } : {}),
  };
}

/** The Ollama Cloud limits and balance of one API key. */
export async function queryOllamaCloudQuota(options: {
  apiKey: string;
  requestTimeoutMs?: number;
}): Promise<OllamaCloudResult> {
  try {
    return await fetchWithTimeout(OLLAMA_CLOUD_BALANCE_URL, {
      request: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
        if (!response.ok) {
          const snippet = sanitizeMessage(text, options.apiKey);
          return {
            success: false,
            error: `Ollama Cloud balance API error ${response.status}: ${snippet}`,
          };
        }

        return parseOllamaCloudBalance(JSON.parse(text) as unknown);
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(
        error instanceof Error ? error.message : String(error),
        options.apiKey,
      ),
    };
  }
}
