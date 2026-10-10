import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { QUOTA_DIALOG_COMMANDS } from "../src/lib/quota-dialog-command-specs.js";
import { QUOTA_RPC_ID, QuotaRpc } from "../src/rpc.js";

type ValidateResult = { value?: unknown; issues?: ReadonlyArray<{ message: string }> };
type StandardSchema = {
  "~standard": {
    version: number;
    vendor: string;
    types?: unknown;
    validate: (value: unknown) => unknown;
  };
};

async function validate(schema: StandardSchema, value: unknown): Promise<ValidateResult> {
  return (await schema["~standard"].validate(value)) as ValidateResult;
}

async function expectAccepted(schema: StandardSchema, value: unknown): Promise<void> {
  const result = await validate(schema, value);
  expect(result.issues).toBeUndefined();
  expect(result.value).toBe(value);
}

async function expectRejected(schema: StandardSchema, value: unknown, message: string) {
  const result = await validate(schema, value);
  expect(result.issues).toEqual([{ message }]);
  expect(result).not.toHaveProperty("value");
}

const methods = QuotaRpc.methods;

describe("quota RPC definition", () => {
  it("defines the plain RPC id, the changed event and seven methods", () => {
    expect(QUOTA_RPC_ID).toBe("slkiser.opencode-quota");
    expect(QuotaRpc.id).toBe(QUOTA_RPC_ID);
    expect(Object.keys(QuotaRpc.events)).toEqual(["changed"]);
    expect(Object.keys(methods)).toEqual([
      "surface",
      "footer",
      "writeExport",
      "command",
      "snapshot",
      "refresh",
      "usage",
    ]);
  });

  it("uses Standard Schema v1 validators that carry no runtime types", () => {
    const schemas = [
      ...Object.values(methods).flatMap((method) => [method.input, method.output]),
      QuotaRpc.events.changed.schema,
    ];
    for (const schema of schemas) {
      expect(schema["~standard"]).toEqual(
        expect.objectContaining({ version: 1, vendor: "opencode-quota" }),
      );
      expect(schema["~standard"]).not.toHaveProperty("types");
    }
  });

  it("validates surface input", async () => {
    for (const surface of ["sidebar", "idle", "compacted", "question"]) {
      await expectAccepted(methods.surface.input, { surface, sessionID: "session-1" });
    }
    await expectRejected(methods.surface.input, null, "input must be an object");
    await expectRejected(methods.surface.input, [], "input must be an object");
    await expectRejected(
      methods.surface.input,
      { sessionID: "session-1" },
      "surface must be one of sidebar, idle, compacted, question",
    );
    await expectRejected(
      methods.surface.input,
      { surface: "prompt", sessionID: "session-1" },
      "surface must be one of sidebar, idle, compacted, question",
    );
    await expectRejected(methods.surface.input, { surface: "idle" }, "sessionID must be a string");
    await expectRejected(
      methods.surface.input,
      { surface: "idle", sessionID: 1 },
      "sessionID must be a string",
    );
  });

  it("validates footer input", async () => {
    await expectAccepted(methods.footer.input, { surface: "prompt", sessionID: "session-1" });
    await expectAccepted(methods.footer.input, { surface: "prompt" });
    await expectAccepted(methods.footer.input, { surface: "home" });
    await expectRejected(methods.footer.input, "home", "input must be an object");
    await expectRejected(methods.footer.input, {}, "surface must be one of prompt, home");
    await expectRejected(
      methods.footer.input,
      { surface: "sidebar" },
      "surface must be one of prompt, home",
    );
    await expectRejected(
      methods.footer.input,
      { surface: "home", sessionID: null },
      "sessionID must be a string",
    );
  });

  it("validates writeExport input", async () => {
    await expectAccepted(methods.writeExport.input, {});
    await expectRejected(methods.writeExport.input, undefined, "input must be an object");
    await expectRejected(methods.writeExport.input, null, "input must be an object");
  });

  it("validates command input", async () => {
    for (const spec of QUOTA_DIALOG_COMMANDS) {
      await expectAccepted(methods.command.input, { command: spec.id });
    }
    await expectAccepted(methods.command.input, {
      command: "tokens_between",
      arguments: "2026-01-01 2026-01-15",
      sessionID: "session-1",
    });
    await expectRejected(methods.command.input, 1, "input must be an object");
    await expectRejected(methods.command.input, {}, "command must be a quota command id");
    await expectRejected(
      methods.command.input,
      { command: "quota_nope" },
      "command must be a quota command id",
    );
    await expectRejected(
      methods.command.input,
      { command: "quota", arguments: 5 },
      "arguments must be a string",
    );
    await expectRejected(
      methods.command.input,
      { command: "quota", sessionID: 5 },
      "sessionID must be a string",
    );
  });

  it("validates snapshot and refresh input", async () => {
    await expectAccepted(methods.snapshot.input, {});
    await expectAccepted(methods.snapshot.input, { sessionID: "session-1" });
    await expectRejected(methods.snapshot.input, null, "input must be an object");
    await expectRejected(methods.snapshot.input, { sessionID: 1 }, "sessionID must be a string");

    for (const reason of ["poll", "turn", "manual"]) {
      await expectAccepted(methods.refresh.input, { reason });
    }
    await expectAccepted(methods.refresh.input, {
      reason: "manual",
      providerIds: ["copilot", "anthropic"],
      sessionID: "session-1",
    });
    const reasonIssue = "reason must be one of poll, turn, manual";
    await expectRejected(methods.refresh.input, [], "input must be an object");
    await expectRejected(methods.refresh.input, {}, reasonIssue);
    // A retry refresh is the server's own; clients can't ask for one.
    await expectRejected(methods.refresh.input, { reason: "retry" }, reasonIssue);
    await expectRejected(
      methods.refresh.input,
      { reason: "manual", providerIds: "copilot" },
      "providerIds must be a list of strings",
    );
    await expectRejected(
      methods.refresh.input,
      { reason: "manual", providerIds: [1] },
      "providerIds must be a list of strings",
    );
    await expectRejected(
      methods.refresh.input,
      { reason: "poll", sessionID: false },
      "sessionID must be a string",
    );
  });

  it("validates usage input", async () => {
    for (const range of ["today", "7d", "30d", "90d", "all"]) {
      await expectAccepted(methods.usage.input, { range });
    }
    await expectAccepted(methods.usage.input, { range: "session", sessionID: "ses_1" });
    await expectAccepted(methods.usage.input, { range: "session_tree", sessionID: "ses_1" });
    await expectAccepted(methods.usage.input, {
      range: "between",
      from: "2026-01-01",
      to: "2026-01-01",
    });

    const rangeIssue =
      "range must be one of today, 7d, 30d, 90d, all, session, session_tree, between";
    const cases: Array<[unknown, string]> = [
      [null, "input must be an object"],
      [{}, rangeIssue],
      [{ range: "1y" }, rangeIssue],
      [{ range: "toString" }, rangeIssue],
      [{ range: "all", sessionID: 1 }, "sessionID must be a string"],
      [{ range: "session" }, "sessionID is required for range session"],
      [{ range: "session_tree", sessionID: "" }, "sessionID is required for range session_tree"],
      [{ range: "between", to: "2026-01-01" }, "from must be a date like 2026-01-31"],
      [
        { range: "between", from: "2026-01-01", to: "1/2/2026" },
        "to must be a date like 2026-01-31",
      ],
      [{ range: "between", from: "2026-01-02", to: "2026-01-01" }, "to must not be before from"],
    ];
    for (const [input, issue] of cases) {
      await expectRejected(methods.usage.input, input, issue);
    }
  });

  it("requires a report in usage output", async () => {
    await expectAccepted(methods.usage.output, { report: { range: "all" } });
    for (const value of [undefined, {}, { report: null }, { report: [] }]) {
      await expectRejected(methods.usage.output, value, "output must carry a report");
    }
  });

  it("requires every v5 output to be an object", async () => {
    for (const method of [methods.surface, methods.footer, methods.writeExport, methods.command]) {
      await expectAccepted(method.output, { any: "object" });
      for (const value of [undefined, null, "text", 1, []]) {
        await expectRejected(method.output, value, "output must be an object");
      }
    }
  });

  it("requires a snapshot in snapshot and refresh output and in the changed event", async () => {
    const snapshot = { version: 6, providers: [], resetNotices: [], generatedAtMs: 1 };
    for (const schema of [
      methods.snapshot.output,
      methods.refresh.output,
      QuotaRpc.events.changed.schema,
    ]) {
      await expectAccepted(schema, { snapshot });
      for (const value of [undefined, null, {}, { snapshot: null }, { snapshot: [] }]) {
        await expectRejected(schema, value, "output must carry a snapshot");
      }
    }
  });

  it("ships dist/rpc.js without loading any @opencode package", () => {
    const source = readFileSync(new URL("../dist/rpc.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*["']@opencode\//);
    expect(source).toContain('from "./lib/quota-dialog-command-specs.js"');
  });
});
