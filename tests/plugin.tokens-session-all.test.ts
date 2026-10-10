import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import {
  type ReportDocument,
  renderMarkdownReport,
  renderPlainTextReport,
} from "../src/lib/report-document.js";
import { REPORT_COMMANDS, type ReportCommandId } from "../src/rpc.js";
import {
  createAlibabaAuthModuleMock,
  createPluginTestClient as createClient,
  createConfigModuleMock,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  aggregateUsage: vi.fn(),
  resolveSessionTree: vi.fn(),
  buildQuotaStatsReportDocument: vi.fn(),
  SessionNotFoundError: class SessionNotFoundError extends Error {
    sessionID: string;
    checkedPath: string;

    constructor(sessionID: string, checkedPath: string) {
      super(`Session not found: ${sessionID}`);
      this.name = "SessionNotFoundError";
      this.sessionID = sessionID;
      this.checkedPath = checkedPath;
    }
  },
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);

vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);

vi.mock("../src/lib/quota-stats.js", () => ({
  aggregateUsage: mocks.aggregateUsage,
  resolveSessionTree: mocks.resolveSessionTree,
  SessionNotFoundError: mocks.SessionNotFoundError,
}));

vi.mock("../src/lib/quota-stats-format.js", () => ({
  buildQuotaStatsReportDocument: mocks.buildQuotaStatsReportDocument,
}));

async function buildTokenDialogOutput(params: {
  command: Exclude<ReportCommandId, "pricing_refresh">;
  arguments?: string;
  client: ReturnType<typeof createClient>;
  sessionID: string;
  generatedAtMs?: number;
  /** The renderer the command uses for its text; the text must equal it applied to the document. */
  render: (document: ReportDocument) => string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: params.command,
    arguments: params.arguments,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
    generatedAtMs: params.generatedAtMs,
  });
  expect(params.client.session.prompt).not.toHaveBeenCalled();
  expect(result.state).toBe("output");
  if (result.state !== "output") throw new Error("expected report output");
  expect(params.render(result.document)).toBe(result.output);
  return { output: result.output, document: result.document };
}

// A titled section, so the markdown and plain-text renderers give different text.
const TOKEN_REPORT_DOCUMENT: ReportDocument = {
  heading: { line: "# Tokens used 00:00 01/01/1970", subtitle: "00:00 01/01/1970" },
  sections: [
    {
      id: "summary",
      title: "Summary",
      blocks: [{ kind: "lines", lines: ["formatted token report"] }],
    },
  ],
};

describe("/tokens_session_all command", () => {
  beforeEach(() => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      },
      resetModules: true,
      resetPluginState: true,
    });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({ state: "none" });
    mocks.aggregateUsage.mockResolvedValue({ totals: {}, bySession: [] });
    mocks.buildQuotaStatsReportDocument.mockReturnValue(TOKEN_REPORT_DOCUMENT);
    mocks.resolveSessionTree.mockResolvedValue([
      { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
      {
        sessionID: "ses_child",
        parentID: "ses_parent",
        title: "Child Session",
        depth: 1,
      },
    ]);
  });

  it("registers /tokens_session_all in the V2 TUI command palette", async () => {
    const { default: plugin } = await import("../src/tui/index.js");
    const tokensSessionAllCommand = REPORT_COMMANDS.find(
      (command) => command.id === "tokens_session_all",
    );
    let commands: Array<{ id: string; title: string }> = [];
    const rpc = vi.fn();
    plugin.setup({
      client: { rpc },
      keymap: {
        layer: (build: () => { mode?: string; commands: typeof commands }) => {
          const layer = build();
          if (layer.mode === "global") commands = layer.commands;
        },
      },
      data: { on: () => () => {} },
      ui: {
        slot: (claim: { append: string; render: () => void }) => {
          if (claim.append === "app") claim.render();
          return () => {};
        },
      },
    } as never);

    expect(commands.find((command) => command.id === "quota.tokens_session_all")).toEqual(
      expect.objectContaining({ title: tokensSessionAllCommand?.title }),
    );
    // Registering the palette makes no RPC call; each command makes its RPC client when run.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("aggregates the current session tree for /tokens_session_all", async () => {
    const client = createClient();

    const { output } = await buildTokenDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "ses_parent",
      render: renderMarkdownReport,
    });

    expect(mocks.resolveSessionTree).toHaveBeenCalledWith("ses_parent");
    expect(mocks.aggregateUsage).toHaveBeenCalledWith({
      sinceMs: undefined,
      untilMs: undefined,
      sessionID: undefined,
      sessionIDs: ["ses_parent", "ses_child"],
    });
    expect(mocks.buildQuotaStatsReportDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Tokens used (Current Session Tree) (/tokens_session_all)",
        focusSessionID: "ses_parent",
        reportKind: "session_tree",
        tableOptions: {
          compactHeaders: true,
          modelNameMaxWidth: 20,
        },
        sessionTree: {
          rootSessionID: "ses_parent",
          nodes: [
            { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
            {
              sessionID: "ses_child",
              parentID: "ses_parent",
              title: "Child Session",
              depth: 1,
            },
          ],
        },
      }),
    );
    expect(output).toBe(renderMarkdownReport(TOKEN_REPORT_DOCUMENT));
    expect(output).toContain("## Summary");
  });

  it("keeps /tokens_session scoped to the selected session only", async () => {
    const client = createClient();

    await buildTokenDialogOutput({
      command: "tokens_session",
      client,
      sessionID: "ses_parent",
      render: renderMarkdownReport,
    });

    expect(mocks.resolveSessionTree).not.toHaveBeenCalled();
    expect(mocks.aggregateUsage).toHaveBeenCalledWith({
      sinceMs: undefined,
      untilMs: undefined,
      sessionID: "ses_parent",
      sessionIDs: undefined,
    });
    expect(mocks.buildQuotaStatsReportDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Tokens used (Current Session) (/tokens_session)",
        focusSessionID: "ses_parent",
        sessionOnly: true,
        reportKind: "session",
        tableOptions: {
          compactHeaders: true,
          modelNameMaxWidth: 20,
        },
      }),
    );
  });

  it("returns a dialog session lookup error for /tokens_session_all", async () => {
    mocks.resolveSessionTree.mockRejectedValueOnce(
      new mocks.SessionNotFoundError("ses_missing", "/tmp/opencode.db"),
    );

    const client = createClient();

    const generatedAtMs = Date.UTC(2026, 0, 2, 3, 4);
    const { output: injected, document } = await buildTokenDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "ses_missing",
      generatedAtMs,
      render: renderPlainTextReport,
    });
    expect(injected).toBe(
      [
        `# Token report unavailable (/tokens_session_all) ${formatLocalCallTimestamp(generatedAtMs)}`,
        "",
        "session_lookup_error:",
        "- session_id: ses_missing",
        "- error: Session not found: ses_missing",
        "- checked_path: /tmp/opencode.db",
      ].join("\n"),
    );
    // The dialog title is the report's name, so the dialog shows why and when instead.
    expect(document.heading).toEqual({
      line: injected.split("\n")[0],
      subtitle: `Token report unavailable · ${formatLocalCallTimestamp(generatedAtMs)}`,
    });
  });

  it("returns a dialog session lookup error for /tokens_session", async () => {
    mocks.aggregateUsage.mockRejectedValueOnce(
      new mocks.SessionNotFoundError("ses_parent", "/tmp/opencode.db"),
    );

    const client = createClient();

    const { output: injected, document } = await buildTokenDialogOutput({
      command: "tokens_session",
      client,
      sessionID: "ses_parent",
      render: renderPlainTextReport,
    });
    expect(injected).toContain("Token report unavailable (/tokens_session)");
    expect(injected).toContain("- session_id: ses_parent");
    expect(injected).toContain("- checked_path: /tmp/opencode.db");
    expect(document.heading?.subtitle).toMatch(/^Token report unavailable · /);
  });

  it("titles every token report; only /tokens_between has facts the dialog title lacks", async () => {
    for (const spec of REPORT_COMMANDS) {
      if (spec.id === "pricing_refresh") continue;
      const between = spec.id === "tokens_between";
      mocks.buildQuotaStatsReportDocument.mockClear();
      await buildTokenDialogOutput({
        command: spec.id,
        arguments: between ? "2026-01-01 2026-01-15" : undefined,
        client: createClient(),
        sessionID: "ses_parent",
        render: renderMarkdownReport,
      });
      expect(mocks.buildQuotaStatsReportDocument).toHaveBeenCalledWith(
        expect.objectContaining(
          between
            ? {
                title: "Tokens used (2026-01-01 .. 2026-01-15) (/tokens_between)",
                titleDetail: "2026-01-01 .. 2026-01-15",
              }
            : { title: `${spec.title} (/${spec.id})`, titleDetail: undefined },
        ),
      );
    }
  });
});
