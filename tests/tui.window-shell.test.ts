/**
 * The quota window (`src/tui/window/shell.tsx`) on a fake OpenCode host whose server answers
 * when the test says so: answers that arrive out of order, System's notice poll, and the keyboard
 * when OpenCode draws the window again.
 */
import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaRpcNoticeListInput, QuotaRpcNoticeListOutput } from "../src/rpc.js";
import { createDisplayStore, type DisplayStorage } from "../src/tui/display.js";
import { createSettingsEditor } from "../src/tui/window/settings.tsx";
import { createQuotaWindow, type QuotaWindow } from "../src/tui/window/shell.tsx";
import { findAll, THEME, textLines } from "./helpers/jsx-tree.js";

type Key = { bind: string; run: () => void };
type Layer = { target: () => unknown; priority?: number; commands: Key[] };
/** The window's own keys; the Usage tab's sit above them (11). */
const WINDOW_KEYS_PRIORITY = 10;

/** Clicks the innermost clickable part that shows `text`. */
function click(tree: unknown, text: string): void {
  const target = findAll(
    tree,
    (node) =>
      typeof node.props?.onMouseUp === "function" &&
      textLines(node).some((line) => line.includes(text)),
  ).at(-1);
  if (!target) throw new Error(`nothing clickable shows ${text}`);
  target.props.onMouseUp();
}

/** Clicks the › of the option line titled `title`, as a click on its value does. */
function clickLine(tree: unknown, title: string): void {
  const line = findAll(
    tree,
    (node) =>
      node.type === "box" &&
      typeof node.props?.onMouseDown === "function" &&
      textLines(node).some((text) => text.includes(title)),
  ).at(-1);
  if (!line) throw new Error(`no option line shows ${title}`);
  click(line, "›");
}

/** Lets the answered requests run to their end. */
async function flush(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

/** A renderable that can have the keyboard; focusing one blurs the last one, as in OpenTUI. */
type FakeBox = {
  isDestroyed: boolean;
  focused: boolean;
  on(event: string, listener: () => void): void;
  focus(): void;
  blur(): void;
  destroy(): void;
};

function fakeHost() {
  const keyboard: { current?: FakeBox } = {};
  const box = (): FakeBox => {
    const listeners = new Map<string, Array<() => void>>();
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    const self: FakeBox = {
      isDestroyed: false,
      focused: false,
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      focus() {
        if (self.isDestroyed || self.focused) return;
        self.focused = true;
        const previous = keyboard.current;
        keyboard.current = self;
        previous?.blur();
        emit("focused");
      },
      blur() {
        if (!self.focused) return;
        if (keyboard.current === self) keyboard.current = undefined;
        self.focused = false;
        emit("blurred");
      },
      // OpenTUI marks a renderable destroyed, then blurs it.
      destroy() {
        self.isDestroyed = true;
        self.blur();
      },
    };
    return self;
  };

  // The server's notices; a change applies when its request arrives, the answer comes later.
  const server = {
    notices: [
      { id: "a", message: "Copilot moves to AI Credits." },
      { id: "b", message: "v6 is out." },
    ],
    read: new Set<string>(),
  };
  const noticeCalls: Array<{ input: QuotaRpcNoticeListInput; answered: boolean; answer(): void }> =
    [];
  const statusCalls: Array<{ answered: boolean; answer(text: string): void }> = [];
  const layers: Layer[] = [];
  const copied: string[] = [];
  const resizeListeners: Array<() => void> = [];

  const api = {
    location: { directory: "/project" },
    theme: THEME,
    client: {
      rpc: () => ({
        noticeList: (input: QuotaRpcNoticeListInput) => {
          for (const id of input.read ?? []) server.read.add(id);
          for (const id of input.unread ?? []) server.read.delete(id);
          const board: QuotaRpcNoticeListOutput = {
            enabled: true,
            home: true,
            notices: server.notices.map((notice) => ({
              ...notice,
              read: server.read.has(notice.id),
            })),
          };
          return new Promise<QuotaRpcNoticeListOutput>((resolve) => {
            const call = {
              input,
              answered: false,
              answer: () => {
                call.answered = true;
                resolve(board);
              },
            };
            noticeCalls.push(call);
          });
        },
        status: () =>
          new Promise<{ text: string }>((resolve) => {
            const call = {
              answered: false,
              answer: (text: string) => {
                call.answered = true;
                resolve({ text });
              },
            };
            statusCalls.push(call);
          }),
      }),
    },
    data: {},
    renderer: {
      root: { on: () => {}, off: () => {} },
      on: (_event: "resize", listener: () => void) => resizeListeners.push(listener),
      off: (_event: "resize", listener: () => void) =>
        resizeListeners.splice(resizeListeners.indexOf(listener), 1),
      get currentFocusedRenderable() {
        return keyboard.current ?? null;
      },
      copyToClipboardOSC52: (text: string) => {
        copied.push(text);
        return true;
      },
    },
    keymap: { layer: (build: () => Layer) => layers.push(build()) },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      toast: { show: vi.fn() },
    },
  };
  // Nothing is saved yet: the Settings tabs start from the defaults.
  const storage: DisplayStorage = {
    store: (_key, options) => [options.initial, async () => {}],
  };
  const display = createDisplayStore(storage);
  const settings = createSettingsEditor(api as never, display);
  const surface = {
    theme: () => THEME,
    display: display.shown,
    quota: {
      snapshot: () => undefined,
      watch: () => () => {},
      refresh: async () => undefined,
    },
    editing: settings,
  };
  const quotaWindow = createQuotaWindow(api as never, surface as never, settings);
  /** The terminal changes size: OpenTUI calls every resize listener, in the order they came. */
  const resize = () => {
    for (const listener of [...resizeListeners]) listener();
  };
  return {
    quotaWindow,
    server,
    noticeCalls,
    statusCalls,
    layers,
    copied,
    keyboard,
    box,
    resizeListeners,
    resize,
  };
}

/** Draws the window as OpenCode's slot does; `dispose` takes it away again. */
function draw(quotaWindow: QuotaWindow) {
  return createRoot((dispose) => ({ tree: quotaWindow.Slot({ sessionID: "ses_1" }), dispose }));
}

/** Gives the drawn window its box, as OpenTUI does when it creates it. */
function mount(tree: unknown, box: FakeBox): void {
  findAll(tree, (node) => node.type === "box" && node.props.focusable === true)[0]?.props.ref(box);
}

/** A key of the window's newest key layer. */
function press(layers: Layer[], bind: string): void {
  windowLayer(layers)
    ?.commands.find((key) => key.bind === bind)
    ?.run();
}

function windowLayer(layers: Layer[]): Layer | undefined {
  return layers.filter((layer) => layer.priority === WINDOW_KEYS_PRIORITY).at(-1);
}

describe("quota window shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
  });

  it("shows the server's latest notice state when an older answer comes last", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    await flush();
    host.noticeCalls[0]?.answer();
    await flush();

    const view = draw(host.quotaWindow);
    click(view.tree, "Copilot moves to AI Credits.");
    click(view.tree, "v6 is out.");
    view.dispose();
    await flush();
    // Whenever two requests are out, the server answers the newer one first.
    for (let open = host.noticeCalls.filter((call) => !call.answered); open.length > 0; ) {
      open.at(-1)?.answer();
      await flush();
      open = host.noticeCalls.filter((call) => !call.answered);
    }

    expect(host.noticeCalls.map((call) => call.input)).toEqual([
      {},
      { read: ["a"] },
      { read: ["b"] },
    ]);
    const lines = textLines(draw(host.quotaWindow).tree);
    expect(lines.filter((line) => line === "read (click: unread)")).toHaveLength(2);
  });

  it("sends one change for two quick clicks on one line, and the next click undoes it", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    await flush();
    host.noticeCalls[0]?.answer();
    await flush();

    // Two clicks before the server answers: the board still shows both as unread.
    let view = draw(host.quotaWindow);
    click(view.tree, "Copilot moves to AI Credits.");
    click(view.tree, "Copilot moves to AI Credits.");
    clickLine(view.tree, "Count on the Home screen");
    clickLine(view.tree, "Count on the Home screen");
    view.dispose();
    await flush();
    // The requests run one after another: answer each as it goes out.
    for (let open = host.noticeCalls.find((call) => !call.answered); open; ) {
      open.answer();
      await flush();
      open = host.noticeCalls.find((call) => !call.answered);
    }

    view = draw(host.quotaWindow);
    click(view.tree, "Copilot moves to AI Credits.");
    view.dispose();
    await flush();
    expect(host.noticeCalls.map((call) => call.input)).toEqual([
      {},
      { read: ["a"] },
      { home: false },
      { unread: ["a"] },
    ]);
  });

  it("shows and copies the newest status report after closing and opening again", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    const first = draw(host.quotaWindow);
    press(host.layers, "escape");
    first.dispose();
    host.quotaWindow.open("system");
    host.statusCalls[1]?.answer("# Quota Status (new)");
    host.statusCalls[0]?.answer("# Quota Status (old)");
    await flush();

    const lines = textLines(draw(host.quotaWindow).tree);
    expect(lines).toContain("# Quota Status (new)");
    expect(lines).not.toContain("# Quota Status (old)");
    press(host.layers, "return");
    expect(host.copied).toEqual(["# Quota Status (new)"]);
  });

  it("asks for the notices again while System shows, and stops on another tab", async () => {
    const host = fakeHost();
    host.quotaWindow.open("system");
    // A poll waits while a request is still out.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.noticeCalls).toHaveLength(1);
    host.noticeCalls[0]?.answer();
    await flush();

    // A new notice arrives, and another window marks "a" read.
    host.server.notices.push({ id: "c", message: "A new notice." });
    host.server.read.add("a");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.noticeCalls).toHaveLength(2);
    host.noticeCalls[1]?.answer();
    await flush();
    const view = draw(host.quotaWindow);
    const lines = textLines(view.tree);
    expect(lines).toContain("A new notice.");
    expect(lines.filter((line) => line === "read (click: unread)")).toHaveLength(1);

    press(host.layers, "tab");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.noticeCalls).toHaveLength(2);
    view.dispose();
  });

  it.each([
    { order: "OpenCode's listener first", windowListenerFirst: false },
    { order: "the window's listener first", windowListenerFirst: true },
  ])("takes the keyboard back when a resize gives it to the message box ($order)", async ({
    windowListenerFirst,
  }) => {
    const host = fakeHost();
    const messageBox = host.box();
    messageBox.focus();
    // Across the sidebar's breakpoint, OpenCode gives the keyboard to its message box.
    const openCodeListener = () => messageBox.focus();
    if (!windowListenerFirst) host.resizeListeners.push(openCodeListener);
    host.quotaWindow.open("limits");
    const view = draw(host.quotaWindow);
    const windowBox = host.box();
    mount(view.tree, windowBox);
    if (windowListenerFirst) host.resizeListeners.push(openCodeListener);
    await vi.advanceTimersByTimeAsync(50);
    expect(host.keyboard.current).toBe(windowBox);

    // Narrower, then wider again: Esc and Tab still reach the window.
    for (const _direction of ["narrower", "wider"]) {
      host.resize();
      await vi.advanceTimersByTimeAsync(0);
      expect(host.keyboard.current).toBe(windowBox);
    }

    // A click on the message box takes the keyboard on purpose, and a resize leaves it there.
    messageBox.focus();
    await vi.advanceTimersByTimeAsync(0);
    host.resize();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.keyboard.current).toBe(messageBox);
    view.dispose();
    expect(host.resizeListeners).toEqual([openCodeListener]);
  });

  it("keeps the keyboard when OpenCode draws the window again, unless something took it", async () => {
    const host = fakeHost();
    const messageBox = host.box();
    messageBox.focus();
    host.quotaWindow.open("limits");
    let view = draw(host.quotaWindow);
    let windowBox = host.box();
    mount(view.tree, windowBox);
    await vi.advanceTimersByTimeAsync(50);
    expect(host.keyboard.current).toBe(windowBox);

    /** A new window, the old one destroyed a moment later, as @opentui/solid does. */
    async function redraw(): Promise<void> {
      const old = windowBox;
      view.dispose();
      view = draw(host.quotaWindow);
      windowBox = host.box();
      mount(view.tree, windowBox);
      old.destroy();
      await vi.advanceTimersByTimeAsync(0);
    }

    await redraw();
    expect(host.keyboard.current).toBe(windowBox);
    expect(windowLayer(host.layers)?.target()).toBe(windowBox);

    // A click on the message box takes the keyboard on purpose; a later redraw leaves it there.
    messageBox.focus();
    await vi.advanceTimersByTimeAsync(0);
    await redraw();
    expect(host.keyboard.current).toBe(messageBox);

    // Clicking the window takes it back; esc closes and gives it to the message box.
    windowBox.focus();
    press(host.layers, "escape");
    expect(host.keyboard.current).toBe(messageBox);
    view.dispose();
  });
});
