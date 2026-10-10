import { TextAttributes } from "@opentui/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ width: 120, height: 40 }));
vi.mock("@opentui/solid", () => ({
  useTerminalDimensions: () => () => ({ ...terminal }),
}));

import { formatLocalCallTimestamp } from "../src/lib/format-utils.js";
import { buildQuotaStatsReportDocument } from "../src/lib/quota-stats-format.js";
import {
  commandHeading,
  messageDocument,
  type ReportDocument,
} from "../src/lib/report-document.js";
import { REPORT_COMMANDS, type ReportCommandId } from "../src/rpc.js";
import plugin from "../src/tui/index.tsx";

// The server plugin's quota RPC runs palette commands; the TUI shows their output.
const rpc = vi.hoisted(() => ({
  command: vi.fn(),
  snapshot: vi.fn(async () => ({
    snapshot: { version: 6, providers: [], resetNotices: [], generatedAtMs: 0 },
  })),
  refresh: vi.fn(),
  notices: vi.fn(),
  status: vi.fn(),
  usage: vi.fn(),
  events: { on: vi.fn(() => () => {}) },
}));

type Node = { type: string; props: Record<string, any> };

function findNodes(node: unknown, type: string): Node[] {
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, type));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  if (element.type === type) return [element];
  return findNodes(element.props?.children, type);
}

function findNode(node: unknown, type: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const element = node as Node;
  if (element.type === type) return element;
  return findNode(element.props?.children, type);
}

/** Makes JSX build a plain tree of { type, props } nodes, running components. */
function stubRenderingReact() {
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const all = { ...props, children: children.length > 1 ? children : children[0] };
      return typeof type === "function" ? type(all) : { type, props: all };
    },
  });
}

/** The quota output dialog's title and the subtitle text under it (null when there is none). */
function dialogHeader(tree: unknown): {
  title: string;
  subtitle: { children: string; fg: string } | null;
} {
  const [titleRow, subtitle] = (tree as Node).props.children[0].props.children;
  return {
    title: findNode(titleRow, "text")?.props.children,
    subtitle: subtitle && { children: subtitle.props.children, fg: subtitle.props.fg },
  };
}

type RegisteredCommand = {
  id: string;
  slash?: { name: string };
  palette: boolean;
  run: () => Promise<void>;
};
type Listener = (event: { data?: Record<string, unknown> }) => void;
type Layer = {
  mode?: string;
  priority?: number;
  commands: Array<RegisteredCommand & { bind?: string; run: () => unknown }>;
};

function startTui(
  location?: { directory: string },
  route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" },
) {
  let layer: { commands: RegisteredCommand[] } | undefined;
  let renderApp: (() => unknown) | undefined;
  const listeners = new Map<string, Listener>();
  const editor = { plainText: "", clear: vi.fn() };
  const context = {
    location,
    renderer: { currentFocusedEditor: editor as typeof editor | null },
    client: { rpc: vi.fn(() => rpc) },
    theme: {
      text: { base: "base", muted: "muted" },
      surface: vi.fn(() => ({
        text: {
          base: "base",
          muted: "muted",
          action: { primary: { focused: "action", selected: "accent" } },
        },
        background: { action: { primary: { focused: "action-bg" } } },
      })),
    },
    storage: {
      store: (_key: string, options: { initial: unknown }) => [options.initial, async () => {}],
    },
    data: {
      on: vi.fn((name: string, listener: Listener) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
      session: { get: vi.fn() },
      location: { default: vi.fn(() => ({ directory: "/work/default" })) },
    },
    keymap: {
      layer: vi.fn((next) => {
        layer ??= next();
      }),
    },
    ui: {
      slot: vi.fn((claim) => {
        if (claim.append === "app") {
          renderApp = claim.render;
          claim.render();
        }
        return vi.fn();
      }),
      toast: { show: vi.fn() },
      router: { current: vi.fn((): typeof route => route) },
      dialog: {
        show: vi.fn((_render: () => unknown, onClose?: () => void) => onClose?.()),
        clear: vi.fn(),
        prompt: vi.fn().mockResolvedValue(undefined),
        set: vi.fn(),
      },
    },
  };
  plugin.setup(context as any);
  const commands = layer!.commands;
  const command = (id: string) => commands.find((item) => item.id === `quota.${id}`)!;
  const emit = (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data });
  const layers = () => context.keymap.layer.mock.calls.map(([build]) => build() as Layer);
  /** OpenCode mounts the "app" slot again, for example after it reconnects to its server. */
  const mountAppAgain = () => renderApp!();
  return { context, editor, commands, command, emit, layers, mountAppAgain };
}

describe("V2 quota TUI commands", () => {
  beforeEach(() => {
    terminal.width = 120;
    rpc.command.mockReset().mockResolvedValue({
      state: "output",
      command: "tokens_today",
      title: "Tokens",
      output: "ok",
      document: messageDocument("ok"),
    });
    rpc.refresh.mockReset().mockResolvedValue({ snapshot: undefined });
    rpc.status.mockReset().mockResolvedValue({ text: "status" });
    // The quick look's data never arrives here; these tests check only what opens.
    rpc.snapshot.mockReset().mockReturnValue(new Promise(() => {}));
    rpc.usage.mockReset().mockReturnValue(new Promise(() => {}));
  });

  it("registers every quota command in the palette, and slash entries only for the TUI-only ones", () => {
    const { context, commands } = startTui();

    // The RPC client is made per call, never during setup.
    expect(context.client.rpc).not.toHaveBeenCalled();
    expect(commands.map((command) => command.id)).toEqual([
      "quota.quick_look",
      "quota.usage",
      "quota.status",
      "quota.settings",
      "quota.pricing_refresh",
      "quota.tokens_today",
      "quota.tokens_daily",
      "quota.tokens_weekly",
      "quota.tokens_monthly",
      "quota.tokens_all",
      "quota.tokens_session",
      "quota.tokens_session_all",
      "quota.tokens_between",
    ]);
    expect(commands.every((command) => command.palette)).toBe(true);
    // The server lists /quota, /quota_status and the reports in the "/" list.
    expect(commands.flatMap((command) => (command.slash ? [command.slash.name] : []))).toEqual([
      "quota_usage",
      "quota_settings",
    ]);
    expect(context.ui.slot.mock.calls.map(([claim]) => claim.append)).toEqual([
      "app",
      "sidebar.content",
      "prompt.footer",
      "home.footer.status",
      "session.composer.top",
    ]);
    expect(context.data.on.mock.calls.map(([event]) => event)).toEqual([
      "session.execution.succeeded",
      "session.compaction.ended",
      "session.step.ended",
      "session.tool.input.started",
      "session.tool.success",
      "session.tool.failed",
    ]);
  });

  it("registers its layers and listeners again when OpenCode mounts the app slot again", () => {
    const { context, mountAppAgain } = startTui();
    const firstListeners = context.data.on.mock.results.map((result) => result.value);
    const firstLayers = context.keymap.layer.mock.calls.length;

    mountAppAgain();

    // The previous mount's layers left with it, so both layers are registered again.
    expect(context.keymap.layer).toHaveBeenCalledTimes(firstLayers * 2);
    expect(context.data.on).toHaveBeenCalledTimes(firstListeners.length * 2);
    for (const dispose of firstListeners) expect(dispose).toHaveBeenCalledOnce();
    const secondListeners = context.data.on.mock.results.slice(firstListeners.length);
    for (const { value: dispose } of secondListeners) expect(dispose).not.toHaveBeenCalled();
  });

  it("prompts for /tokens_between dates in the palette and stops when cancelled", async () => {
    const { context, command } = startTui();

    await command("tokens_between").run();
    expect(context.ui.dialog.prompt).toHaveBeenCalledOnce();
    expect(rpc.command).not.toHaveBeenCalled();

    context.ui.dialog.prompt.mockResolvedValue(" 2026-09-01 2026-09-25 ");
    await command("tokens_between").run();
    expect(rpc.command).toHaveBeenCalledWith(
      { command: "tokens_between", arguments: "2026-09-01 2026-09-25", sessionID: undefined },
      expect.anything(),
    );
  });

  it("runs /pricing_refresh from the palette without a prompt", async () => {
    const { context, command } = startTui();

    await command("pricing_refresh").run();

    expect(context.ui.dialog.prompt).not.toHaveBeenCalled();
    expect(rpc.command.mock.calls.map(([input]) => [input.command, input.arguments])).toEqual([
      ["pricing_refresh", undefined],
    ]);
  });

  describe("typed quota slash commands", () => {
    function startTyped(
      route: { type: "home" } | { type: "session"; sessionID: string } = { type: "home" },
    ) {
      const tui = startTui(undefined, route);
      const enter = tui.layers().find((layer) => layer.priority === 1)!;
      return { ...tui, enter: enter.commands[0] };
    }

    it("registers one Enter binding above OpenCode's prompt, only in the base mode", () => {
      const { layers, enter } = startTyped();

      const layer = layers().find((item) => item.priority === 1)!;
      expect(layer.mode).toBeUndefined();
      expect(layer.commands).toHaveLength(1);
      expect(enter.bind).toBe("return");
      expect("id" in enter).toBe(false);
      expect("slash" in enter).toBe(false);
    });

    it("clears the prompt and runs a report command with its arguments, synchronously", async () => {
      const { context, editor, enter } = startTyped({ type: "session", sessionID: "ses_open" });
      editor.plainText = "  /tokens_between  2026-09-01 2026-09-25 \n";

      const result = enter.run();

      // A returned promise would count as handled, so run must not return one.
      expect(result).toBeUndefined();
      expect(editor.clear).toHaveBeenCalledOnce();
      expect(context.ui.dialog.prompt).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(context.ui.dialog.show).toHaveBeenCalledOnce());
      expect(rpc.command).toHaveBeenCalledExactlyOnceWith(
        { command: "tokens_between", arguments: "2026-09-01 2026-09-25", sessionID: "ses_open" },
        expect.anything(),
      );
    });

    it("opens the quick look for /quota, even on Home", () => {
      const home = startTyped();
      home.editor.plainText = "/quota";
      expect(home.enter.run()).toBeUndefined();
      expect(home.editor.clear).toHaveBeenCalledOnce();
      expect(home.context.ui.dialog.show).toHaveBeenCalledOnce();
      expect(home.context.ui.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
      expect(home.context.ui.toast.show).not.toHaveBeenCalled();
      expect(rpc.usage).toHaveBeenCalledExactlyOnceWith({ range: "7d" }, expect.anything());
    });

    it("opens the quota window for the other quota commands, and on Home says to open a session first", () => {
      const home = startTyped();
      for (const name of ["quota_usage", "quota_status", "quota_settings"]) {
        home.editor.plainText = `/${name}`;
        expect(home.enter.run()).toBeUndefined();
      }
      expect(home.editor.clear).toHaveBeenCalledTimes(3);
      expect(home.context.ui.toast.show).toHaveBeenCalledTimes(3);
      expect(home.context.ui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Open a session first: the quota window opens above its message box.",
        }),
      );

      const session = startTyped({ type: "session", sessionID: "ses_open" });
      session.editor.plainText = "/quota_status";
      expect(session.enter.run()).toBeUndefined();
      expect(session.context.ui.toast.show).not.toHaveBeenCalled();
      // The Status tab asks for the report; no report command runs.
      expect(rpc.status).toHaveBeenCalledExactlyOnceWith(
        { sessionID: "ses_open" },
        expect.anything(),
      );
      expect(rpc.command).not.toHaveBeenCalled();
    });

    it("leaves other text and a missing editor to OpenCode's submit", () => {
      const { context, editor, enter } = startTyped();
      for (const text of ["hello", "/quotax", "/quota_statu", "/help", "hello /quota", "/", ""]) {
        editor.plainText = text;
        expect(enter.run()).toBe(false);
      }
      context.renderer.currentFocusedEditor = null;
      expect(enter.run()).toBe(false);
      expect(editor.clear).not.toHaveBeenCalled();
    });
  });

  it("runs commands for the session on screen, and without a session elsewhere", async () => {
    await startTui(undefined, { type: "session", sessionID: "ses_open" })
      .command("tokens_session")
      .run();
    await startTui(undefined, { type: "home" }).command("tokens_session").run();

    expect(rpc.command.mock.calls.map(([input]) => input.sessionID)).toEqual([
      "ses_open",
      undefined,
    ]);
  });

  it("runs commands at the TUI location, else the default location, with a timeout", async () => {
    await startTui({ directory: "/work/project" }).command("tokens_today").run();
    const { context, command } = startTui();
    await command("pricing_refresh").run();

    expect(rpc.command.mock.calls.map(([, options]) => options)).toEqual([
      { location: { directory: "/work/project" }, signal: expect.any(AbortSignal) },
      { location: { directory: "/work/default" }, signal: expect.any(AbortSignal) },
    ]);
    // The server looks up the session model; the palette never reads it.
    expect(context.data.session.get).not.toHaveBeenCalled();
  });

  it("shows the message of a failed RPC call in the error toast", async () => {
    rpc.command.mockRejectedValue({ type: "rpc.internal", message: "server \u001b[31mbroke" });
    const { context, command } = startTui();

    await command("tokens_today").run();

    expect(context.ui.toast.show).toHaveBeenCalledExactlyOnceWith({
      variant: "error",
      title: "OpenCode Quota",
      message: "server broke",
    });
    expect(context.ui.dialog.show).not.toHaveBeenCalled();
  });

  it("shows command output in a scrollable dialog that fits the terminal", async () => {
    stubRenderingReact();
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
    const generatedAtMs = Date.UTC(2026, 0, 2, 3, 4);
    const document: ReportDocument = {
      heading: commandHeading({ title: "Tokens used (Today) (/tokens_today)", generatedAtMs }),
      sections: [
        {
          id: "models",
          title: "Top Models",
          blocks: [
            {
              kind: "table",
              headers: ["Model", "Tok", "Cost"],
              fullHeaders: ["Model", "Tokens", "Cost"],
              aligns: ["left", "right", "right"],
              rows: [
                ["gpt-5", "1.0K", "$1.23"],
                ["claude-\u001b[31mopus", "20K", "$10.00"],
              ],
            },
            { kind: "kv", rows: [{ key: "enabled", value: "true" }] },
          ],
        },
        { id: "empty", blocks: [{ kind: "lines", lines: [] }] },
        { id: "notes", blocks: [{ kind: "lines", lines }] },
      ],
    };
    rpc.command.mockResolvedValue({
      state: "output",
      command: "tokens_today",
      title: "Tokens used (Today)",
      output: "the chat text",
      document,
    });
    const { context, command, layers } = startTui();

    await command("tokens_today").run();

    expect(context.ui.dialog.show).toHaveBeenCalledOnce();
    expect(context.ui.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    const render = context.ui.dialog.show.mock.calls[0][0] as () => unknown;
    const tree = render();
    const scrollbox = findNode(tree, "scrollbox");
    // 40 terminal rows: three quarters is 30, minus 8 rows of dialog chrome and the subtitle.
    expect(scrollbox?.props.maxHeight).toBe(21);
    // The subtitle sits directly under the title, muted; the report's title line is left out.
    expect(dialogHeader(tree)).toEqual({
      title: "Tokens used (Today)",
      subtitle: { children: formatLocalCallTimestamp(generatedAtMs), fg: "muted" },
    });
    const texts = findNodes(scrollbox?.props.children, "text").map((node) => ({
      children: node.props.children,
      fg: node.props.fg,
      bold: node.props.attributes === TextAttributes.BOLD,
      wrapMode: node.props.wrapMode,
    }));
    // Section titles are bold base, table headers bold accent, and values base. A key-value
    // row is a muted "- key:" with a base value; plain lines are muted.
    // A 120-column terminal fits the whole 116-column dialog; minus its paddings and the
    // scrollbar, a table spans 111 columns. It fits with its full labels (27 columns), so its
    // two gaps share the 84 spare columns.
    const gap = " ".repeat(44);
    expect(texts).toEqual([
      { children: "Top Models", fg: "base", bold: true, wrapMode: undefined },
      {
        children: `Model      ${gap}Tokens${gap}  Cost`,
        fg: "accent",
        bold: true,
        wrapMode: "none",
      },
      {
        children: `gpt-5      ${gap}  1.0K${gap} $1.23`,
        fg: "base",
        bold: false,
        wrapMode: "none",
      },
      {
        children: `claude-opus${gap}   20K${gap}$10.00`,
        fg: "base",
        bold: false,
        wrapMode: "none",
      },
      {
        children: [
          "- enabled:",
          { type: "span", props: { style: { fg: "base" }, children: [" ", "true"] } },
        ],
        fg: "muted",
        bold: false,
        wrapMode: undefined,
      },
      { children: lines.join("\n"), fg: "muted", bold: false, wrapMode: undefined },
    ]);
    // One blank row between the sections and between the blocks of a section; a section
    // title sits directly above its first block.
    const body = scrollbox?.props.children;
    expect(body.props.gap).toBe(1);
    const section = body.props.children[0];
    expect(section.props.gap).toBeUndefined();
    expect(section.props.children[1].props.gap).toBe(1);

    const dialogLayer = layers().find((item) => item.mode === "modal")!;
    expect(dialogLayer.mode).toBe("modal");
    expect(dialogLayer.commands.map((item) => item.bind)).toEqual([
      "return",
      "up",
      "down",
      "pageup",
      "pagedown",
      "home",
      "end",
    ]);
    const scroll = { scrollBy: vi.fn(), scrollTo: vi.fn(), scrollHeight: 80 };
    scrollbox?.props.ref(scroll);
    const run = (bind: string) => dialogLayer.commands.find((item) => item.bind === bind)!.run();
    run("pagedown");
    run("up");
    run("end");
    expect(scroll.scrollBy.mock.calls).toEqual([[21], [-1]]);
    expect(scroll.scrollTo).toHaveBeenCalledWith(80);
    run("return");
    expect(context.ui.dialog.clear).toHaveBeenCalledOnce();
  });

  it("lays popup tables out again for the terminal width, with compact labels when narrow", async () => {
    stubRenderingReact();
    rpc.command.mockResolvedValue({
      state: "output",
      command: "tokens_today",
      title: "Tokens",
      output: "the chat text",
      document: {
        sections: [
          {
            id: "models",
            blocks: [
              {
                kind: "table",
                headers: ["Model", "Tok", "Cost"],
                fullHeaders: ["Model", "Tokens", "Cost"],
                aligns: ["left", "right", "right"],
                rows: [["claude-opus", "20K", "$10.00"]],
              },
            ],
          },
        ],
      },
    });
    const { context, command } = startTui();
    await command("tokens_today").run();
    const render = context.ui.dialog.show.mock.calls[0][0] as () => unknown;
    const tableLines = () =>
      findNodes(findNode(render(), "scrollbox")?.props.children, "text").map(
        (node) => node.props.children as string,
      );

    // 33 columns: the dialog is 31 wide and a table 26; the full labels (27) do not fit,
    // the compact ones (24) do, and the two gaps share the 2 spare columns.
    terminal.width = 33;
    expect(tableLines()).toEqual(["Model         Tok     Cost", "claude-opus   20K   $10.00"]);
    // 30 columns: a table gets 23; even the compact labels do not fit, so it keeps its
    // natural layout.
    terminal.width = 30;
    expect(tableLines()).toEqual(["Model        Tok    Cost", "claude-opus  20K  $10.00"]);
  });

  it("shows every command's report title once, as the dialog title, with the subtitle under it", async () => {
    stubRenderingReact();
    const generatedAtMs = Date.UTC(2026, 8, 29, 14, 0);
    const time = formatLocalCallTimestamp(generatedAtMs);
    const tokenResult = {
      window: { sinceMs: 0, untilMs: 1 },
      totals: {
        priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 0,
        sessionCount: 0,
      },
      bySourceProvider: [],
      bySourceModel: [],
      byModel: [],
      bySession: [],
      unknown: [],
      unpriced: [],
    };
    // Each document has the heading its server builder gives it.
    const reports = new Map<ReportCommandId, { document: ReportDocument; subtitle: string }>(
      REPORT_COMMANDS.map(
        (spec): [ReportCommandId, { document: ReportDocument; subtitle: string }] => {
          if (spec.id === "pricing_refresh") {
            const heading = commandHeading({
              title: "Pricing Refresh (/pricing_refresh)",
              generatedAtMs,
            });
            const sections = [
              {
                id: "refresh",
                title: "refresh:",
                blocks: [{ kind: "lines" as const, lines: ["-"] }],
              },
            ];
            return [spec.id, { document: { heading, sections }, subtitle: time }];
          }
          if (spec.id === "tokens_between") {
            const document = buildQuotaStatsReportDocument({
              title: "Tokens used (2026-01-01 .. 2026-01-15) (/tokens_between)",
              titleDetail: "2026-01-01 .. 2026-01-15",
              result: tokenResult,
              generatedAtMs,
            });
            return [spec.id, { document, subtitle: `2026-01-01 .. 2026-01-15 · ${time}` }];
          }
          const document = buildQuotaStatsReportDocument({
            title: `${spec.title} (/${spec.id})`,
            result: tokenResult,
            generatedAtMs,
          });
          return [spec.id, { document, subtitle: time }];
        },
      ),
    );

    for (const spec of REPORT_COMMANDS) {
      const report = reports.get(spec.id)!;
      rpc.command.mockResolvedValueOnce({
        state: "output",
        command: spec.id,
        title: spec.title,
        output: "the chat text",
        document: report.document,
      });
      const { context, command } = startTui();
      context.ui.dialog.prompt.mockResolvedValue("2026-01-01 2026-01-15");

      await command(spec.id).run();

      const tree = (context.ui.dialog.show.mock.calls[0][0] as () => unknown)();
      expect(dialogHeader(tree)).toEqual({
        title: spec.title,
        subtitle: { children: report.subtitle, fg: "muted" },
      });
      const body = findNodes(findNode(tree, "scrollbox")?.props.children, "text")
        .map((node) => node.props.children)
        .join("\n");
      expect(body).not.toBe("");
      expect(body).not.toContain(report.document.heading!.line);
      expect(body).not.toContain(spec.title);
      expect(body).not.toContain(`(/${spec.id})`);
    }
  });
});
