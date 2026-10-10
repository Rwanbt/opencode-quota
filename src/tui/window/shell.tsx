/** @jsxImportSource @opentui/solid */
/**
 * The quota window. `/quota` opens it above the message box of a session, where it covers the
 * chat with the same size on every tab: Limits, Usage, Notices, Status and the Settings tabs
 * (`settings.tsx`). While it is focused (it is
 * after opening; click it to give it the keyboard again) its keys work: ↑↓ select or scroll,
 * space/enter use a line, ←/→ change it, tab switches tabs, esc closes. Closing gives the
 * keyboard back to whatever had it before.
 */
import type { Plugin } from "@opencode/plugin/tui";
import {
  type BoxRenderable,
  type Renderable,
  type RGBA,
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
import type { SettingsTab } from "../display.js";
import type { SurfaceHost } from "../sidebar.js";
import type { Theme } from "../theme.js";
import { type NoticeBoard, noticeOptions } from "./notices.js";
import {
  isSettingsTab,
  type OptionLine,
  OptionRow,
  SETTINGS_TABS,
  type SettingsEditor,
} from "./settings.js";
import { createUsageTab, type UsageChoice } from "./usage.js";
import { LimitsView, NoticesView, type StatusReport, StatusView } from "./views.js";

const RPC_TIMEOUT_MS = 60_000;
/** Columns inside the window until it knows its real width. */
const DEFAULT_WIDTH = 120;

export type WindowTab = "limits" | "usage" | "notices" | "status" | SettingsTab;

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
/** Every tab in the order tab and shift+tab go through them. */
const ALL_TABS: readonly WindowTab[] = [...TABS, ...SETTINGS_TABS].map((item) => item.tab);

/** The theme tokens the window reads, besides the surfaces' ones (OpenCode's `ResolvedTheme`). */
export type WindowTheme = Theme & {
  text: Theme["text"] & { action: { primary: { focused: RGBA; selected: RGBA } } };
  background: { action: { primary: { focused: RGBA } }; raised: { high: RGBA } };
  border: { base: RGBA };
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

/** What the window needs from OpenCode's TUI context (its theme and client types aren't installed). */
export type WindowHost = Pick<Plugin.Context, "keymap" | "renderer" | "themeMode" | "ui"> & {
  location?: { directory: string };
  theme: WindowTheme;
  client: { rpc: (definition: typeof QuotaRpc) => WindowRpc };
  data: { location?: { default: () => { directory: string } } };
};

const KEYS = "Quota window";

export type QuotaWindow = {
  /** Opens the window on a tab, or switches to it. On Home it only says to open a session. */
  open(tab: WindowTab): void;
  /** Opens the window on its Usage tab, on `choice`. */
  openUsage(choice: UsageChoice): void;
  /** The `session.composer.top` slot. */
  Slot(props: { sessionID: string }): JSX.Element;
};

export function createQuotaWindow(
  api: WindowHost,
  host: SurfaceHost,
  settings: SettingsEditor,
): QuotaWindow {
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
    settings.setTab(next);
    setTab(next);
    // A Settings line may have had the keyboard; it is gone with its tab.
    windowBox?.focus();
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

  /** The lines above a tab's body that ↑↓ can select: switches (‹ on ›) and buttons (▸). */
  function tabOptions(): OptionLine[] {
    if (tab() === "status") {
      const note = () => "then paste it into a GitHub issue";
      return [
        { id: "copy", title: "Copy this report", value: () => "copy", run: copyReport, note },
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
    return noticeOptions(current).map(({ id, title, value, kind }) => ({
      id,
      title,
      value: () => value,
      ...(kind === "switch" ? { cycle: runs[id] } : { run: runs[id] }),
    }));
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

  /** Esc or Close. With unsaved settings the bottom bar asks first. */
  function close(): void {
    if (settings.askBeforeClose()) return;
    settings.setTab(undefined);
    setTab(undefined);
    if (focusBefore && !focusBefore.isDestroyed) focusBefore.focus();
    focusBefore = null;
  }

  function switchTab(delta: number): void {
    const index = ALL_TABS.indexOf(tab() ?? "limits");
    showTab(ALL_TABS[(index + delta + ALL_TABS.length) % ALL_TABS.length] as WindowTab);
  }

  /** ↑↓ select the next line; past the first or last one (or with none) they scroll. */
  function select(delta: number): void {
    const ids = tabOptions().map((option) => option.id);
    const next = ids.indexOf(selected()) + delta;
    if (ids.length === 0 || next < 0 || next >= ids.length) scroll?.scrollBy(delta);
    else setSelected(ids[next]);
  }

  /** Space or enter use any line; ←/→ only flip a switch. */
  function useLine(option: OptionLine | undefined, anyKind: boolean): void {
    if (option?.cycle) option.cycle(1);
    else if (anyKind) option?.run?.();
  }
  const useSelected = (anyKind: boolean) =>
    useLine(
      tabOptions().find((item) => item.id === selected()),
      anyKind,
    );

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
      // While a Settings line takes typed text, the keys go to its input.
      enabled: () => !settings.typing(),
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
        { bind: "space", title: "Use the line", group: KEYS, run: () => useSelected(true) },
        { bind: "return", title: "Use the line", group: KEYS, run: () => useSelected(true) },
        { bind: "left", title: "Change the line", group: KEYS, run: () => useSelected(false) },
        { bind: "right", title: "Change the line", group: KEYS, run: () => useSelected(false) },
        { bind: "tab", title: "Next tab", group: KEYS, run: () => switchTab(1) },
        { bind: "shift+tab", title: "Previous tab", group: KEYS, run: () => switchTab(-1) },
        { bind: "escape", title: "Close", group: KEYS, run: close },
      ],
    }));

    const current = () => TABS.find((item) => item.tab === tab()) ?? TABS[0];
    const settingsTab = () => {
      const shown = tab();
      return isSettingsTab(shown) ? shown : undefined;
    };
    const hint = () =>
      tab() === "usage" && usage.typingDate()
        ? "Typing a date: enter next date, then apply · tab other date · esc back to the window"
        : (settings.hint(tab() ?? "", hasKeyboard()) ??
          (hasKeyboard()
            ? "↑↓ select or scroll · space/enter or click to use a line · ‹ › (or ←/→) to change · tab next tab · esc close"
            : "The keyboard is somewhere else (the message box, a dialog). Click this box to use ↑↓ space tab esc here."));
    const tabTitle = (item: { tab: WindowTab; title: string }) => (
      <text
        fg={item.tab === tab() ? theme().text.action.primary.selected : theme().text.muted}
        attributes={
          item.tab === tab() ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE
        }
        wrapMode="none"
        selectable={false}
        onMouseUp={settings.click(() => showTab(item.tab))}
      >
        {item.title}
      </text>
    );

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
        onMouseDown={() => {
          settings.pressed();
          if (!settings.typing()) windowBox?.focus();
        }}
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
          {TABS.map(tabTitle)}
          <text fg={theme().text.muted} wrapMode="none" selectable={false}>
            │ Settings:
          </text>
          {SETTINGS_TABS.map(tabTitle)}
          <box flexGrow={1} />
          <text fg={theme().text.muted} selectable={false} onMouseUp={settings.click(close)}>
            esc
          </text>
        </box>
        <Show
          when={settingsTab()}
          fallback={
            // Padding instead of leading spaces, so a note that wraps stays indented.
            <box paddingLeft={3} marginTop={1} flexShrink={0}>
              <text fg={theme().text.muted} wrapMode="word" selectable={false}>
                {current().note}
              </text>
            </box>
          }
        >
          {(shown: () => SettingsTab) => (
            <settings.Header tab={shown()} refocus={() => windowBox?.focus()} />
          )}
        </Show>
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
            <OptionRow
              line={option}
              theme={theme()}
              active={selected() === option.id}
              click={settings.click}
              press={() => setSelected(option.id)}
              use={() => useLine(option, true)}
              valueWidth={option.cycle ? 3 : 9}
            />
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
          <Show when={settingsTab()}>
            {(shown: () => SettingsTab) => (
              <settings.Body
                tab={shown()}
                host={host}
                sessionID={props.sessionID}
                box={() => windowBox}
                scroll={() => scroll}
              />
            )}
          </Show>
        </scrollbox>
        <box flexDirection="row" gap={2} marginTop={1} flexShrink={0}>
          <settings.Buttons
            tab={tab() ?? ""}
            host={host}
            sessionID={props.sessionID}
            box={() => windowBox}
            close={close}
          />
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
