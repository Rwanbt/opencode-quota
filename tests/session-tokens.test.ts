import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSessionTokensForDisplay } from "../src/lib/session-tokens.js";
import { type SessionDatabaseMessage, writeSessionDatabase } from "./helpers/session-database.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-quota-session-tokens-"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("OPENCODE_DB", undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function message(
  id: string,
  sessionID: string,
  tokens: SessionDatabaseMessage["tokens"],
): SessionDatabaseMessage {
  return {
    id,
    sessionID,
    providerID: "openai",
    modelID: "gpt-5",
    created: 1,
    completed: 2,
    tokens,
  };
}

/** ses_root -> ses_child -> ses_leaf, and ses_leaf is also ses_root's parent: a cycle. */
function writeHistory(): void {
  writeSessionDatabase(join(root, "data", "opencode", "opencode.db"), {
    sessions: [
      { id: "ses_root", parentID: "ses_leaf", created: 1 },
      { id: "ses_child", parentID: "ses_root", created: 2 },
      { id: "ses_leaf", parentID: "ses_child", created: 3 },
      { id: "ses_other", created: 4 },
    ],
    messages: [
      message("msg_1", "ses_root", { input: 10, output: 5, cacheRead: 4 }),
      message("msg_2", "ses_root", { input: 2, output: 3, cacheRead: 6 }),
      message("msg_3", "ses_child", { input: 3, output: 2, cacheRead: 5 }),
      message("msg_4", "ses_leaf", { input: 1, output: 1 }),
      message("msg_5", "ses_other", { input: 100, output: 100 }),
      message("msg_6", "ses_other", {}),
    ],
  });
}

describe("fetchSessionTokensForDisplay", () => {
  it.each([
    { scope: "current", sessionTokens: { totalInput: 12, totalCachedInput: 10, totalOutput: 8 } },
    // Each session of the tree once, even when parent links form a cycle.
    { scope: "tree", sessionTokens: { totalInput: 16, totalCachedInput: 15, totalOutput: 11 } },
  ] as const)("sums new and cached input apart for the $scope scope", async (item) => {
    writeHistory();

    await expect(
      fetchSessionTokensForDisplay({ sessionID: "ses_root", scope: item.scope }),
    ).resolves.toEqual({ sessionTokens: item.sessionTokens });
  });

  it("has no tokens without a session, for an unknown session, or without a database", async () => {
    await expect(
      fetchSessionTokensForDisplay({ sessionID: "ses_root", scope: "tree" }),
    ).resolves.toEqual({});
    writeHistory();

    await expect(fetchSessionTokensForDisplay({ scope: "tree" })).resolves.toEqual({});
    await expect(
      fetchSessionTokensForDisplay({ sessionID: "ses_missing", scope: "tree" }),
    ).resolves.toEqual({});
    await expect(
      fetchSessionTokensForDisplay({ sessionID: "ses_missing", scope: "current" }),
    ).resolves.toEqual({ sessionTokens: undefined });
  });
});
