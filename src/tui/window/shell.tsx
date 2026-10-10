/** @jsxImportSource @opentui/solid */
/**
 * The quota window. `/quota` opens it above the message box of a session, where it covers the
 * chat with the same size on every tab: Limits, Usage, Notices and Status. While it is focused (it is
 * after opening; click it to give it the keyboard again) its keys work: ↑↓ select or scroll,
 * space/enter use a line, ←/→ change it, tab switches tabs, esc closes. Closing gives the
 * keyboard back to whatever had it before.
 */
import {
  type BoxRenderable,
  type Renderable,
  RGBA,
  type ScrollBoxRenderable,
  TextAttributes,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { sanitizeDisplayText } from "../../lib/display-sanitize.js";
import {
  QuotaRpc,
  type QuotaRpcDownloadPricesInput,
  type QuotaRpcDownloadPricesOutput,
  type QuotaRpcNoticeListInput,
  type QuotaRpcNoticeListOutput,
  type QuotaRpcStatusInput,
  type QuotaRpcStatusOutput,
  type QuotaRpcUsageInput,
  type QuotaRpcUsageOutput,
} from "../../rpc.js";
import { rpcErrorMessage } from "../client.js";
import type { SurfaceHost } from "../sidebar.js";
import type { Theme } from "../theme.js";
import { type NoticeBoard, noticeOptions } from "./notices.js";
import { createUsageTab, type UsageChoice } from "./usage.js";
import { LimitsView, NoticesView, type StatusReport, StatusView } from "./views.js";

const RPC_TIMEOUT_MS = 60_000;
/** Columns inside the window until it knows its real width. */
const DEFAULT_WIDTH = 120;

export type WindowTab = "limits" | "usage" | "notices" | "status";

const TABS: ReadonlyArray<{ tab: WindowTab; title: string; note: string }> = [
  {
    tab: "limits",
    title: "Limits",
    note: "Every limit, with its reset. The │ in a bar is where you'd be if you used it evenly: left of it = you use it faster than it refills.",
  },
  {
    tab: "usage",
    title: "Usage",
    note: "Tokens and what they would cost at API prices, from OpenCode's history. c/t cost or tokens · ←/→ range · m/d by model or day · ↑↓ pick a model, enter its details.",
  },
  {
    tab: "notices",
    title: "Notices",
    note: "Short notes from the OpenCode Quota maintainer (a provider changed its limits, a new version).",
  },
  {
    tab: "status",
    title: "Status",
    note: "What quota found and when it last checked. Copy it into a bug report.",
  },
];

/** The theme tokens the window reads, besides the surfaces' ones (OpenCode's `ResolvedTheme`). */
export type WindowTheme = Theme & {
  text: Theme["text"] & { action: { primary: { focused: RGBA; selected: RGBA } } };
  background: { action: { primary: { focused: RGBA } }; raised: { high: RGBA } };
  border: { base: RGBA };
};

type Toast = {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration?: number;
};
/** Returning false lets the key continue to the next layer. */
export type WindowKey = {
  bind: string;
  title: string;
  group: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: OpenCode's keymap API types `run` this way.
  run: () => void | false;
};
export type CallOptions = { location: { directory: string }; signal: AbortSignal };
export type WindowRpc = {
  noticeList(
    input: QuotaRpcNoticeListInput,
    options: CallOptions,
  ): Promise<QuotaRpcNoticeListOutput>;
  status(input: QuotaRpcStatusInput, options: CallOptions): Promise<QuotaRpcStatusOutput>;
  usage(input: QuotaRpcUsageInput, options: CallOptions): Promise<QuotaRpcUsageOutput>;
  downloadPrices(
    input: QuotaRpcDownloadPricesInput,
    options: CallOptions,
  ): Promise<QuotaRpcDownloadPricesOutput>;
};

/** What the window needs from OpenCode's TUI context. */
export type WindowHost = {
  location?: { directory: string };
  theme: WindowTheme;
  client: { rpc: (definition: typeof QuotaRpc) => WindowRpc };
  data: { location?: { default: () => { directory: string } } };
  renderer: {
    root: {
      on(event: "layout-changed", listener: () => void): void;
      off(event: "layout-changed", listener: () => void): void;
    };
    currentFocusedRenderable: Renderable | null;
    copyToClipboardOSC52(text: string): boolean;
  };
  keymap: {
    /**
     * A layer with a target works only while that renderable has the keyboard; a "modal" one
     * only while a dialog is open.
     */
    layer(
      build: () => {
        mode?: "modal";
        target?: () => Renderable | undefined;
        priority?: number;
        commands: WindowKey[];
      },
    ): void;
  };
  ui: {
    router: { current(): { type: string; sessionID?: string } };
    toast: { show(toast: Toast): void };
    dialog: {
      show(render: () => JSX.Element, onClose?: () => void): void;
      set(options: { size: "large" }): void;
      clear(): void;
    };
  };
};

/** A line above a tab's body that ↑↓ can select: a switch (‹ on ›) or a button (▸). */
type WindowOption = {
  id: string;
  title: string;
  value: string;
  note?: string;
  kind: "switch" | "button";
  run: () => void;
};

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
const KEYS = "Quota window";

export type QuotaWindow = {
  /** Opens the window on a tab, or switches to it. On Home it only says to open a session. */
  open(tab: WindowTab): void;
  /** Opens the window on its Usage tab, on `choice`. */
  openUsage(choice: UsageChoice): void;
  /** The `session.composer.top` slot. */
  Slot(props: { sessionID: string }): JSX.Element;
};

export function createQuotaWindow(api: WindowHost, host: SurfaceHost): QuotaWindow {
  const [tab, setTab] = createSignal<WindowTab>();
  const [selected, setSelected] = createSignal("");
  const [board, setBoard] = createSignal<NoticeBoard>();
  const [status, setStatus] = createSignal<StatusReport>({ state: "loading" });
  let windowBox: BoxRenderable | undefined;
  let scroll: ScrollBoxRenderable | undefined;
  /** What had the keyboard before the window opened (the message box), so closing gives it back. */
  let focusBefore: Renderable | null = null;

  // The RPC client is made per call, so nothing reaches OpenCode during plugin setup.
  const rpc = () => api.client.rpc(QuotaRpc);
  const options = (): CallOptions => {
    const location = api.location ?? api.data.location?.default();
    if (!location) throw new Error("OpenCode gave the TUI no location");
    return { location, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) };
  };
  const routeSessionID = () => {
    const route = api.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const usage = createUsageTab(api, { rpc, options, scroll: () => scroll });
  const showError = (error: unknown) =>
    api.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(rpcErrorMessage(error)),
    });

  /** Asks for the notices, after making the given changes. */
  async function changeNotices(input: QuotaRpcNoticeListInput): Promise<void> {
    try {
      setBoard(await rpc().noticeList(input, options()));
    } catch (error) {
      showError(error);
    }
  }

  async function loadStatus(sessionID: string | undefined): Promise<void> {
    setStatus({ state: "loading" });
    try {
      const output = await rpc().status(sessionID ? { sessionID } : {}, options());
      setStatus({ state: "ready", text: output.text });
    } catch (error) {
      setStatus({ state: "failed", message: sanitizeDisplayText(rpcErrorMessage(error)) });
    }
  }

  /** Each tab asks the server again when it shows: Limits a refresh, the others their data. */
  function showTab(next: WindowTab): void {
    setTab(next);
    const sessionID = routeSessionID();
    if (next === "limits") void host.quota.refresh("manual", sessionID);
    if (next === "notices") void changeNotices({});
    if (next === "status") void loadStatus(sessionID);
    if (next === "usage" && sessionID) usage.show(sessionID);
    setSelected(tabOptions()[0]?.id ?? "");
    scroll?.scrollTo(0);
  }

  function copyReport(): void {
    const report = status();
    if (report.state !== "ready") return;
    const copied = api.renderer.copyToClipboardOSC52(report.text);
    api.ui.toast.show({
      variant: copied ? "success" : "warning",
      title: "Status report",
      message: copied
        ? "Copied. Paste it into a GitHub issue."
        : "This terminal doesn't allow copying; select the text instead.",
      duration: 4_000,
    });
  }

  function tabOptions(): WindowOption[] {
    if (tab() === "status") {
      return [
        {
          id: "copy",
          title: "Copy this report",
          value: "copy",
          note: "then paste it into a GitHub issue",
          kind: "button",
          run: copyReport,
        },
      ];
    }
    const current = board();
    if (tab() !== "notices" || !current) return [];
    const unreadIds = current.notices.filter((notice) => !notice.read).map(({ id }) => id);
    const runs = {
      enabled: () => void changeNotices({ enabled: !current.enabled }),
      home: () => void changeNotices({ home: !current.home }),
      readAll: () => void changeNotices({ read: unreadIds }),
    };
    return noticeOptions(current).map((option) => ({ ...option, run: runs[option.id] }));
  }

  function open(next: WindowTab): void {
    if (!routeSessionID()) {
      api.ui.toast.show({
        variant: "info",
        title: "OpenCode Quota",
        message: "Open a session first: the quota window opens above its message box.",
      });
      return;
    }
    if (tab() === undefined) focusBefore = api.renderer.currentFocusedRenderable;
    showTab(next);
    // The command leaves the message box focused; take the keyboard once it has settled.
    setTimeout(() => windowBox?.focus(), 50);
  }

  function close(): void {
    setTab(undefined);
    if (focusBefore && !focusBefore.isDestroyed) focusBefore.focus();
    focusBefore = null;
  }

  function switchTab(delta: number): void {
    const index = TABS.findIndex((item) => item.tab === tab());
    showTab(TABS[(index + delta + TABS.length) % TABS.length].tab);
  }

  /** ↑↓ select the next line; past the first or last one (or with none) they scroll. */
  function select(delta: number): void {
    const ids = tabOptions().map((option) => option.id);
    const next = ids.indexOf(selected()) + delta;
    if (ids.length === 0 || next < 0 || next >= ids.length) scroll?.scrollBy(delta);
    else setSelected(ids[next]);
  }

  function useSelected(kind: "switch" | "any"): void {
    const option = tabOptions().find((item) => item.id === selected());
    if (option && (kind === "any" || option.kind === "switch")) option.run();
  }

  function Button(props: { label: string; primary?: boolean; run: () => void }): JSX.Element {
    const theme = () => api.theme;
    return (
      <box
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={
          props.primary ? theme().background.action.primary.focused : theme().background.raised.high
        }
        onMouseUp={props.run}
      >
        <text
          fg={props.primary ? theme().text.action.primary.focused : theme().text.base}
          selectable={false}
        >
          {props.label}
        </text>
      </box>
    );
  }

  function OptionLine(props: { option: WindowOption }): JSX.Element {
    const theme = () => api.theme;
    const active = () => selected() === props.option.id;
    const fg = () => (active() ? theme().text.action.primary.focused : theme().text.base);
    const arrow = () => (active() ? fg() : theme().text.action.primary.selected);
    const isSwitch = props.option.kind === "switch";
    return (
      <box
        flexDirection="row"
        backgroundColor={active() ? theme().background.action.primary.focused : TRANSPARENT}
        onMouseDown={() => setSelected(props.option.id)}
        onMouseUp={props.option.run}
      >
        <text fg={fg()} wrapMode="none" selectable={false}>
          {`   ${props.option.title.padEnd(28)} `}
        </text>
        <text fg={arrow()} wrapMode="none" selectable={false}>
          {isSwitch ? "‹ " : "  "}
        </text>
        <text fg={fg()} wrapMode="none" selectable={false}>
          {props.option.value.padEnd(isSwitch ? 3 : 9)}
        </text>
        <text fg={arrow()} wrapMode="none" selectable={false}>
          {isSwitch ? " ›" : " ▸"}
        </text>
        <Show when={props.option.note}>
          <text fg={active() ? fg() : theme().text.muted} wrapMode="none" selectable={false}>
            {`   ${props.option.note}`}
          </text>
        </Show>
      </box>
    );
  }

  function Window(props: { sessionID: string }): JSX.Element {
    const theme = () => api.theme;
    const [hasKeyboard, setHasKeyboard] = createSignal(false);
    const [width, setWidth] = createSignal(DEFAULT_WIDTH);
    const [nowMs, setNowMs] = createSignal(Date.now());
    // Reset times and "checked … ago" count on between snapshots.
    const clock = setInterval(() => setNowMs(Date.now()), 60_000);
    onCleanup(() => clearInterval(clock));
    const stopWatch = host.quota.watch(props.sessionID);
    onCleanup(stopWatch);

    // The window covers the whole chat, so it has the same size on every tab. OpenCode's
    // session column holds the messages box (its first child holds the messages scrollbox),
    // a one-line "Jump to latest" row, then the box with this slot and the message box. Room =
    // the column minus its 1-line bottom padding, the other rows, and whatever else sits in
    // that last box (the message box, queued prompts).
    const [roomHeight, setRoomHeight] = createSignal<number>();
    function measureRoom(): void {
      const box = windowBox;
      if (!box || box.isDestroyed) return;
      let child: Renderable = box;
      for (let parent = box.parent; parent; child = parent, parent = parent.parent) {
        const siblings = parent.getChildren();
        const messages = siblings[0];
        if (
          messages === child ||
          !messages?.getChildren().some((item) => "scrollChildIntoView" in item)
        ) {
          continue;
        }
        const otherRows = siblings
          .filter((item) => item !== child && item !== messages)
          .reduce((total, item) => total + item.height, 0);
        const room = Math.max(12, parent.height - 1 - otherRows - (child.height - box.height));
        if (room !== roomHeight()) queueMicrotask(() => setRoomHeight(room));
        return;
      }
    }
    onMount(() => {
      api.renderer.root.on("layout-changed", measureRoom);
      onCleanup(() => api.renderer.root.off("layout-changed", measureRoom));
    });
    onCleanup(() => {
      windowBox = undefined;
      scroll = undefined;
    });

    // Keys work only while this box has the keyboard; the message box keeps its own keys.
    api.keymap.layer(() => ({
      target: () => windowBox,
      priority: 10,
      commands: [
        { bind: "up", title: "Previous line", group: KEYS, run: () => select(-1) },
        { bind: "down", title: "Next line", group: KEYS, run: () => select(1) },
        {
          bind: "pageup",
          title: "Scroll up one page",
          group: KEYS,
          run: () => scroll?.scrollBy(-(scroll.height || 1)),
        },
        {
          bind: "pagedown",
          title: "Scroll down one page",
          group: KEYS,
          run: () => scroll?.scrollBy(scroll.height || 1),
        },
        { bind: "space", title: "Use the line", group: KEYS, run: () => useSelected("any") },
        { bind: "return", title: "Use the line", group: KEYS, run: () => useSelected("any") },
        { bind: "left", title: "Change the line", group: KEYS, run: () => useSelected("switch") },
        { bind: "right", title: "Change the line", group: KEYS, run: () => useSelected("switch") },
        { bind: "tab", title: "Next tab", group: KEYS, run: () => switchTab(1) },
        { bind: "shift+tab", title: "Previous tab", group: KEYS, run: () => switchTab(-1) },
        { bind: "escape", title: "Close", group: KEYS, run: close },
      ],
    }));

    const current = () => TABS.find((item) => item.tab === tab()) ?? TABS[0];
    const hint = () =>
      tab() === "usage" && usage.typingDate()
        ? "Typing a date: enter next date, then apply · tab other date · esc back to the window"
        : hasKeyboard()
          ? "↑↓ select or scroll · space/enter or click to use a line · ‹ › (or ←/→) to change · tab next tab · esc close"
          : "The keyboard is somewhere else (the message box, a dialog). Click this box to use ↑↓ space tab esc here.";

    return (
      <box
        ref={(element: BoxRenderable) => {
          windowBox = element;
          element.on("focused", () => setHasKeyboard(true));
          element.on("blurred", () => setHasKeyboard(false));
        }}
        focusable
        height={roomHeight()}
        border
        borderStyle="rounded"
        borderColor={hasKeyboard() ? theme().text.action.primary.selected : theme().border.base}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => windowBox?.focus()}
        onSizeChange={function (this: BoxRenderable) {
          // Inside the border and the padding.
          const measured = this.width - 4;
          if (measured > 0 && measured !== width()) queueMicrotask(() => setWidth(measured));
        }}
      >
        <box flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={0}>
          <text fg={theme().text.base} wrapMode="none" selectable={false}>
            <b>Quota</b>
          </text>
          {TABS.map((item) => (
            <text
              fg={item.tab === tab() ? theme().text.action.primary.selected : theme().text.muted}
              attributes={
                item.tab === tab()
                  ? TextAttributes.BOLD | TextAttributes.UNDERLINE
                  : TextAttributes.NONE
              }
              wrapMode="none"
              selectable={false}
              onMouseUp={() => showTab(item.tab)}
            >
              {item.title}
            </text>
          ))}
          <box flexGrow={1} />
          <text fg={theme().text.muted} selectable={false} onMouseUp={close}>
            esc
          </text>
        </box>
        {/* Padding instead of leading spaces, so a note that wraps stays indented. */}
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <text fg={theme().text.muted} wrapMode="word" selectable={false}>
            {current().note}
          </text>
        </box>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => {
            scroll = element;
          }}
          // Basis 0: the tab body gets the room left over and scrolls; it never squeezes the rest.
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          marginTop={1}
        >
          {tabOptions().map((option) => (
            <OptionLine option={option} />
          ))}
          <Show when={tab() === "limits"}>
            <LimitsView host={host} sessionID={props.sessionID} nowMs={nowMs()} width={width()} />
          </Show>
          <Show when={tab() === "usage"}>
            <usage.View width={width()} keyTarget={() => windowBox} />
          </Show>
          <Show when={tab() === "notices"}>
            <NoticesView
              theme={theme()}
              board={board()}
              toggle={(id, read) => void changeNotices(read ? { unread: [id] } : { read: [id] })}
            />
          </Show>
          <Show when={tab() === "status"}>
            <StatusView theme={theme()} report={status()} />
          </Show>
        </scrollbox>
        <box flexDirection="row" gap={2} marginTop={1} flexShrink={0}>
          <Button label="Close" primary run={close} />
        </box>
        {/* Two lines tall either way, so the box doesn't move when the hint changes. */}
        <text
          fg={theme().text.muted}
          wrapMode="word"
          minHeight={2}
          flexShrink={0}
          selectable={false}
        >
          {hint()}
        </text>
      </box>
    );
  }

  return {
    open,
    openUsage: (choice) => {
      usage.choose(choice);
      open("usage");
    },
    Slot: (props) => (
      <Show when={tab() !== undefined}>
        <Window sessionID={props.sessionID} />
      </Show>
    ),
  };
}
