import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One row of OpenCode 2's `session_v2` table (the columns the plugin reads). */
export type SessionDatabaseSession = {
  id: string;
  /** Set for a subagent session; a fork has none. */
  parentID?: string;
  title?: string;
  created: number;
};

/** One row of OpenCode 2's `session_message` table; its `data` JSON is built from the rest. */
export type SessionDatabaseMessage = {
  id: string;
  sessionID: string;
  /** Defaults to "assistant". */
  type?: string;
  created: number;
  /** Absent while the message is still running. */
  completed?: number;
  providerID?: string;
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  cost?: number;
};

/**
 * Creates OpenCode 2's session tables in a new database file (use a temp dir), creating its
 * folder, and inserts `sessions` and `messages`.
 */
export function writeSessionDatabase(
  databasePath: string,
  data: {
    sessions: readonly SessionDatabaseSession[];
    messages: readonly SessionDatabaseMessage[];
  },
): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE "session_v2" (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent_id TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE "session_message" (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const insertSession = database.prepare(`INSERT INTO "session_v2" VALUES (?, ?, ?, ?, ?)`);
    for (const session of data.sessions) {
      insertSession.run(
        session.id,
        session.title ?? null,
        session.parentID ?? null,
        session.created,
        session.created,
      );
    }
    const insertMessage = database.prepare(
      `INSERT INTO "session_message" VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    data.messages.forEach((message, seq) => {
      const tokens = message.tokens ?? {};
      insertMessage.run(
        message.id,
        message.sessionID,
        message.type ?? "assistant",
        seq,
        message.created,
        message.completed ?? message.created,
        JSON.stringify({
          model: { providerID: message.providerID, id: message.modelID },
          tokens: {
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            reasoning: tokens.reasoning ?? 0,
            cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
          },
          cost: message.cost ?? 0,
          time:
            message.completed === undefined
              ? { created: message.created }
              : { created: message.created, completed: message.completed },
        }),
      );
    });
  } finally {
    database.close();
  }
}
