/**
 * The tokens a session used so far, for the quota snapshot, with the reason when they could not
 * be read.
 */
import type { Words } from "../core/types.js";
import type { SessionTokensData } from "./entries.js";
import {
  getSessionTokenSummary,
  getSessionTreeTokenSummary,
  SessionNotFoundError,
} from "./quota-stats.js";

export interface SessionTokenError {
  sessionID: string;
  error: string;
  checkedPath?: string;
}

export interface SessionTokenFetchResult {
  sessionTokens?: SessionTokensData;
  error?: SessionTokenError;
}

/**
 * Fetch session token summary for display.
 *
 * @returns `sessionTokens` on success (undefined if no data),
 *          `error` on failure (for diagnostics).
 *          When both are undefined the feature was disabled or sessionID missing.
 */
export async function fetchSessionTokensForDisplay(params: {
  enabled: boolean;
  sessionID?: string;
  scope: Words["sessionTokens"];
}): Promise<SessionTokenFetchResult> {
  if (!params.enabled || !params.sessionID) return {};

  try {
    const summary =
      params.scope === "tree"
        ? await getSessionTreeTokenSummary(params.sessionID)
        : await getSessionTokenSummary(params.sessionID);
    if (summary && summary.models.length > 0) {
      return {
        sessionTokens: {
          models: summary.models,
          totalInput: summary.totalInput,
          totalCachedInput: summary.totalCachedInput,
          totalCombinedInput: summary.totalCombinedInput,
          totalOutput: summary.totalOutput,
        },
      };
    }
    // Success but no data — clear any previous error
    return {};
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return {
        error: {
          sessionID: err.sessionID,
          error: err.message,
          checkedPath: err.checkedPath,
        },
      };
    }
    return {
      error: {
        sessionID: params.sessionID,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
