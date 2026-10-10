/**
 * The tokens a session used so far, for the quota snapshot: its own messages, or with
 * `scope: "tree"` its subagent sessions' messages too.
 */
import type { Words } from "../core/types.js";
import {
  iterAssistantMessagesForSession,
  iterAssistantMessagesForSessions,
  type OpenCodeMessage,
  resolveSessionTree,
} from "./opencode-storage.js";

/** A session's new input, cache-read input and output tokens. */
interface SessionTokensData {
  totalInput: number;
  totalCachedInput: number;
  totalOutput: number;
}

/** The token totals, or undefined when no message used a token. */
function sumSessionTokens(messages: readonly OpenCodeMessage[]): SessionTokensData | undefined {
  let totalInput = 0;
  let totalCachedInput = 0;
  let totalOutput = 0;
  let used = false;

  for (const { tokens } of messages) {
    if (!tokens) continue;
    const input = typeof tokens.input === "number" ? tokens.input : 0;
    const cachedInput = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
    const output = typeof tokens.output === "number" ? tokens.output : 0;
    if (input + cachedInput === 0 && output === 0) continue;

    totalInput += input;
    totalCachedInput += cachedInput;
    totalOutput += output;
    used = true;
  }

  return used ? { totalInput, totalCachedInput, totalOutput } : undefined;
}

/**
 * The session's token totals. `sessionTokens` is undefined without a session, when no message
 * used a token, and when the session or OpenCode's database can't be read.
 */
export async function fetchSessionTokensForDisplay(params: {
  sessionID?: string;
  scope: Words["sessionTokens"];
}): Promise<{ sessionTokens?: SessionTokensData }> {
  const { sessionID } = params;
  if (!sessionID) return {};

  try {
    const messages =
      params.scope === "tree"
        ? await iterAssistantMessagesForSessions({
            sessionIDs: await resolveSessionTree(sessionID),
          })
        : await iterAssistantMessagesForSession({ sessionID });
    return { sessionTokens: sumSessionTokens(messages) };
  } catch {
    return {};
  }
}
