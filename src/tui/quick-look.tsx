/** @jsxImportSource @opentui/solid */
/**
 * `/quota` in the TUI: the quick look (`view/quick-look.ts`) in the form the display setting
 * `quickLook` picks. "dialog", the default, opens a popup: c/t show cost or tokens, ←/→ change
 * the range, u and s open the quota window on Usage or Settings, ↑↓ scroll, esc closes.
 * "toast" shows the short text in a toast. "chat" runs the server's `/quota` in the session,
 * which posts the short text there without an AI turn, as on Web; Home has no session, so
 * there it shows the toast.
 */
import { type RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";
import type { UsageReport } from "../core/usage.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { QuotaRpc, type QuotaRpcUsageInput, type QuotaRpcUsageOutput } from "../rpc.js";
import {
  DEFAULT_QUICK_LOOK_RANGE,
  type QuickLookLine,
  type QuickLookRange,
  type QuickLookRole,
  quickLookText,
  quickLookView,
  stepRange,
} from "../view/quick-look.js";
import type { UsageMode } from "../view/usage.js";
import {
  type QuotaRpcCallOptions,
  quotaCallOptions,
  type RpcLocationHost,
  rpcErrorMessage,
} from "./client.js";
import type { DisplaySettings } from "./display.js";
import type { SurfaceHost } from "./sidebar.js";
import { roleColor } from "./theme.js";
import type { QuotaWindow, WindowTheme } from "./window/shell.js";

/** OpenCode's "xlarge" dialog width (dialogWidth in its ui/dialog.tsx). */
const DIALOG_WIDTH = 116;
const COMMAND_TIMEOUT_MS = 60_000;
/**
 * OpenCode gives the keyboard back to the message box 1 ms after a dialog closes. The window
 * opens after that, so closing the window gives the keyboard back to the message box.
 */
const WINDOW_AFTER_DIALOG_MS = 10;
const KEYS = "Quota quick look";

type Toast = {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration?: number;
};
type QuickLookKey = { bind: string; title: string; group: string; run: () => void };

/** What the quick look needs from OpenCode's TUI context. */
export type QuickLookHost = RpcLocationHost & {
  /** `categorical` is OpenCode's palette for things that need telling apart, like providers. */
  theme: WindowTheme & { categorical?: ReadonlyArray<Readonly<Record<number, RGBA>>> };
  client: {
    rpc: (definition: typeof QuotaRpc) => {
      usage(input: QuotaRpcUsageInput, options: QuotaRpcCallOptions): Promise<QuotaRpcUsageOutput>;
    };
    session: {
      command(
        input: { sessionID: string; name: string; text: string },
        options?: { signal?: AbortSignal },
      ): Promise<void>;
    };
  };
  keymap: { layer(build: () => { mode: "modal"; commands: QuickLookKey[] }): void };
  ui: {
    router: { current(): { type: string; sessionID?: string } };
    toast: { show(toast: Toast): void };
    dialog: {
      show(render: () => JSX.Element, onClose?: () => void): void;
      set(params: { size: "xlarge" }): void;
      clear(): void;
    };
  };
};

export type QuickLook = {
  /** Shows the quick look of the current session (or of Home) in the configured form. */
  open(): void;
};

type SpanStyle = { fg: RGBA; bg?: RGBA; attributes?: number };

/** Each provider's color: OpenCode's categorical palette, else the accent. */
function providerColor(theme: QuickLookHost["theme"], index: number): RGBA {
  const palette = theme.categorical ?? [];
  const fallback = theme.hue.accent[500] ?? theme.text.base;
  return palette.length > 0 ? (palette[index % palette.length][500] ?? fallback) : fallback;
}

function spanStyle(
  theme: QuickLookHost["theme"],
  display: DisplaySettings,
  role: QuickLookRole,
): SpanStyle {
  switch (role) {
    case "title":
    case "heading":
      return { fg: theme.text.base, attributes: TextAttributes.BOLD };
    case "text":
    case "value":
      return { fg: theme.text.base };
    case "muted":
      return { fg: theme.text.muted };
    case "good":
    case "warning":
    case "low":
    case "empty":
    case "error":
      return { fg: roleColor(theme, display, role) };
    case "marker":
      return { fg: roleColor(theme, display, "label") };
    case "bar":
      return { fg: theme.hue.accent[500] ?? theme.text.base };
    case "chip":
      return {
        fg: theme.text.action.primary.focused,
        bg: theme.background.action.primary.focused,
      };
  }
  if (role.startsWith("provider:")) {
    return { fg: providerColor(theme, Number(role.slice("provider:".length))) };
  }
  // The "by type" parts: their shade marks tell them apart; output, the most expensive, is bright.
  return { fg: role === "part:output" ? theme.text.base : theme.text.muted };
}

function LineView(props: {
  line: QuickLookLine;
  style: (role: QuickLookRole) => SpanStyle;
}): JSX.Element {
  return (
    <text wrapMode="none" selectable={false} flexShrink={0}>
      {props.line.length === 0 ? " " : null}
      {props.line.map((part) => (
        <span style={props.style(part.role)}>{part.text}</span>
      ))}
    </text>
  );
}

export function createQuickLook(
  api: QuickLookHost,
  host: SurfaceHost,
  quotaWindow: Pick<QuotaWindow, "open">,
): QuickLook {
  const routeSessionID = () => {
    const route = api.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const showError = (error: unknown) =>
    api.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(rpcErrorMessage(error)),
    });

  // The RPC client is made per call, so nothing reaches OpenCode during plugin setup.
  async function loadUsage(range: QuickLookRange, sessionID?: string): Promise<UsageReport> {
    const input = { range, ...(sessionID ? { sessionID } : {}) };
    return (await api.client.rpc(QuotaRpc).usage(input, quotaCallOptions(api))).report;
  }

  async function showToast(sessionID: string | undefined): Promise<void> {
    const [refreshed, usage] = await Promise.all([
      host.quota.refresh("manual", sessionID),
      loadUsage(DEFAULT_QUICK_LOOK_RANGE, sessionID).catch(() => undefined),
    ]);
    const snapshot = refreshed ?? host.quota.snapshot(sessionID);
    if (!snapshot) {
      api.ui.toast.show({
        variant: "error",
        title: "OpenCode Quota",
        message: "Couldn't load quota. Run /quota_status to see why.",
      });
      return;
    }
    const display = host.display();
    const message = quickLookText({ snapshot, usage, settings: display, nowMs: Date.now() });
    api.ui.toast.show({
      variant: "info",
      title: "OpenCode Quota",
      message,
      duration: display.toast.seconds * 1000,
    });
  }

  async function postToChat(sessionID: string): Promise<void> {
    try {
      await api.client.session.command(
        { sessionID, name: "quota", text: "" },
        { signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) },
      );
    } catch (error) {
      showError(error);
    }
  }

  function openDialog(sessionID: string | undefined): void {
    const [mode, setMode] = createSignal<UsageMode>("cost");
    const [range, setRange] = createSignal<QuickLookRange>(DEFAULT_QUICK_LOOK_RANGE);
    /** Every range's report once it arrived, so going back to a range shows it at once. */
    const [reports, setReports] = createSignal<ReadonlyMap<QuickLookRange, UsageReport>>(new Map());
    const [failures, setFailures] = createSignal<ReadonlyMap<QuickLookRange, string>>(new Map());
    const [nowMs, setNowMs] = createSignal(Date.now());

    async function showRange(next: QuickLookRange): Promise<void> {
      setRange(next);
      if (reports().has(next)) return;
      setFailures((current) => new Map([...current].filter(([key]) => key !== next)));
      try {
        const report = await loadUsage(next, sessionID);
        setReports((current) => new Map(current).set(next, report));
      } catch (error) {
        const note = `Couldn't load usage: ${sanitizeDisplayText(rpcErrorMessage(error))}`;
        setFailures((current) => new Map(current).set(next, note));
      }
    }

    function openWindow(tab: "usage" | "settings"): void {
      api.ui.dialog.clear();
      setTimeout(() => quotaWindow.open(tab), WINDOW_AFTER_DIALOG_MS);
    }

    const stopWatch = host.quota.watch(sessionID);
    // Reset times count down while the dialog is open.
    const clock = setInterval(() => setNowMs(Date.now()), 60_000);
    void host.quota.refresh("manual", sessionID);
    void showRange(DEFAULT_QUICK_LOOK_RANGE);

    function Dialog(): JSX.Element {
      const dimensions = useTerminalDimensions();
      // OpenCode's dialog is its size's width, at most the terminal width minus 2. Inside it
      // come this box's paddings (2 + 2) and one column for the scrollbar.
      const width = () => Math.min(DIALOG_WIDTH, dimensions().width - 2) - 4 - 1;
      // The dialog starts a quarter of the way down. The other 7 rows: the dialog's top
      // padding, the header, the key line, the two gaps, the bottom padding and one spare.
      const maxHeight = () => Math.max(3, Math.floor(dimensions().height * 0.75) - 7);
      let scroll: ScrollBoxRenderable | undefined;
      const view = createMemo(() => {
        const display = host.display();
        return quickLookView({
          snapshot: host.quota.snapshot(sessionID),
          usage: reports().get(range()),
          usageNote: failures().get(range()),
          range: range(),
          mode: mode(),
          settings: display,
          thresholds: display.thresholds,
          nowMs: nowMs(),
          width: width(),
        });
      });
      const style = (role: QuickLookRole) => spanStyle(api.theme, host.display(), role);
      const step = (delta: number) => void showRange(stepRange(range(), delta, !!sessionID));

      api.keymap.layer(() => ({
        mode: "modal",
        commands: [
          { bind: "c", title: "Show cost", group: KEYS, run: () => setMode("cost") },
          { bind: "t", title: "Show tokens", group: KEYS, run: () => setMode("tokens") },
          { bind: "left", title: "Shorter range", group: KEYS, run: () => step(-1) },
          { bind: "right", title: "Longer range", group: KEYS, run: () => step(1) },
          { bind: "u", title: "Open Usage", group: KEYS, run: () => openWindow("usage") },
          { bind: "s", title: "Open Settings", group: KEYS, run: () => openWindow("settings") },
          { bind: "up", title: "Scroll up", group: KEYS, run: () => scroll?.scrollBy(-1) },
          { bind: "down", title: "Scroll down", group: KEYS, run: () => scroll?.scrollBy(1) },
          {
            bind: "pageup",
            title: "Scroll up one page",
            group: KEYS,
            run: () => scroll?.scrollBy(-maxHeight()),
          },
          {
            bind: "pagedown",
            title: "Scroll down one page",
            group: KEYS,
            run: () => scroll?.scrollBy(maxHeight()),
          },
        ],
      }));

      return (
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <LineView line={view().header} style={style} />
          <scrollbox
            ref={(element: ScrollBoxRenderable) => {
              scroll = element;
            }}
            // As tall as the body, up to the room there is; then it scrolls.
            height={Math.min(view().body.length, maxHeight())}
          >
            {view().body.map((line) => (
              <LineView line={line} style={style} />
            ))}
          </scrollbox>
          <LineView line={view().keys} style={style} />
        </box>
      );
    }

    api.ui.dialog.show(
      () => <Dialog />,
      () => {
        clearInterval(clock);
        stopWatch();
      },
    );
    api.ui.dialog.set({ size: "xlarge" });
  }

  return {
    open() {
      const sessionID = routeSessionID();
      const form = host.display().quickLook;
      if (form === "chat" && sessionID) void postToChat(sessionID);
      else if (form === "dialog") openDialog(sessionID);
      else void showToast(sessionID);
    },
  };
}
