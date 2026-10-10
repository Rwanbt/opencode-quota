import { beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/tui/index.tsx";

// The server plugin's quota RPC; the quota window asks it for its tabs.
const rpc = vi.hoisted(() => ({
  snapshot: vi.fn(async () => ({
    snapshot: { version: 6, providers: [], resetNotices: [], generatedAtMs: 0 },
  })),
  refresh: vi.fn(),
  notices: vi.fn(),
  status: vi.fn(),
  usage: vi.fn(),
  events: { on: vi.fn(() => () => {}) },
}));

type RegisteredCommand = {
  id: string;
  slash?: unknown;
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
    rpc.usage.mockReset().mockReturnValue(new Promise(() => {}));
    rpc.refresh.mockReset().mockResolvedValue({ snapshot: undefined });
    rpc.status.mockReset().mockResolvedValue({ text: "status" });
  });

  it("registers every quota command in the palette and leaves slash commands to the server", () => {
    const { context, commands } = startTui();

    // The RPC client is made per call, never during setup.
    expect(context.client.rpc).not.toHaveBeenCalled();
    expect(commands.map((command) => command.id)).toEqual([
      "quota.window",
      "quota.usage",
      "quota.status",
    ]);
    expect(commands.every((command) => command.palette)).toBe(true);
    expect(commands.some((command) => "slash" in command)).toBe(false);
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

    it("opens the quota window for /quota, and on Home says to open a session first", () => {
      const home = startTyped();
      home.editor.plainText = "/quota";
      expect(home.enter.run()).toBeUndefined();
      expect(home.editor.clear).toHaveBeenCalledOnce();
      expect(home.context.ui.toast.show).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: "Open a session first: the quota window opens above its message box.",
        }),
      );

      // A typed command runs synchronously: a returned promise would count as handled.
      const session = startTyped({ type: "session", sessionID: "ses_open" });
      session.editor.plainText = "  /quota_status \n";
      expect(session.enter.run()).toBeUndefined();
      expect(session.context.ui.toast.show).not.toHaveBeenCalled();
      expect(rpc.status).toHaveBeenCalledExactlyOnceWith(
        { sessionID: "ses_open" },
        expect.anything(),
      );
      // /quota_usage opens the Usage tab, which asks for the default range.
      session.editor.plainText = "/quota_usage";
      expect(session.enter.run()).toBeUndefined();
      expect(rpc.usage).toHaveBeenCalledExactlyOnceWith(
        { range: "7d", sessionID: "ses_open" },
        expect.anything(),
      );
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
});
