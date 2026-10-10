/** @jsxImportSource @opentui/solid */
/**
 * OpenCode Quota's TUI plugin. It draws the server's quota snapshot: the Quota panel in the
 * session sidebar, the status line under the message box (and on Home when turned on), the
 * toasts, the `/quota` quick look (`quick-look.tsx`), and the quota window that
 * `/quota_usage`, `/quota_status` and `/quota_settings` open above the message box (`window/`).
 * It reads only the quota RPC and the display settings in OpenCode's plugin storage. The report
 * dialogs of the token and pricing commands live in `legacy-dialogs.tsx`.
 */
import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { onCleanup, Show } from "solid-js";
import { type ClientHost, createQuotaClient, reportFailure } from "./client.js";
import { type DisplaySettings, type DisplayStorage, loadDisplaySettings } from "./display.js";
import {
  type LegacyDialogHost,
  registerTypedQuotaCommands,
  reportCommands,
} from "./legacy-dialogs.js";
import { createQuickLook, type QuickLookHost } from "./quick-look.js";
import { SidebarPanel, type SurfaceHost } from "./sidebar.js";
import { HomeFooter, StatusLine } from "./status-line.js";
import type { Theme } from "./theme.js";
import { createToasts, type TurnEnd } from "./toasts.js";
import { createQuotaWindow, type WindowHost } from "./window/shell.js";

type SidebarState = { open: boolean };
type TuiEvent = { data?: Record<string, unknown> };

/** What the plugin needs from OpenCode's TUI context, besides the dialogs' and the window's needs. */
type TuiContext = LegacyDialogHost &
  WindowHost &
  QuickLookHost &
  ClientHost & {
    theme: Theme & LegacyDialogHost["theme"] & QuickLookHost["theme"];
    storage: DisplayStorage;
    data: LegacyDialogHost["data"] & {
      on: (event: string, handler: (event: TuiEvent) => void) => () => void;
      session: { get: (sessionID: string) => { parentID?: string } | undefined };
    };
    ui: LegacyDialogHost["ui"] & {
      slot: (
        claim:
          | { append: "app"; render: () => null }
          | { append: "sidebar.content"; render: (props: { sessionID: string }) => JSX.Element }
          | { append: "prompt.footer"; render: (props: { sessionID?: string }) => JSX.Element }
          | { append: "home.footer.status"; render: () => JSX.Element }
          | {
              append: "session.composer.top";
              render: (props: { sessionID: string }) => JSX.Element;
            },
      ) => () => void;
    };
  };

function eventSessionID(event: TuiEvent): string | undefined {
  const sessionID = event.data?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

function eventToolCallID(event: TuiEvent): string | undefined {
  const id = event.data?.id;
  return typeof id === "string" ? id : undefined;
}

const plugin = Plugin.define({
  // OpenCode names this plugin's storage files after its id (`plugin.<id>.<key>.json`), so the
  // id may hold only letters, digits, ".", "_" and "-". The saved display settings live under
  // it: changing it again loses them.
  id: "slkiser.opencode-quota",
  setup(context) {
    const api = context as unknown as TuiContext;
    // Plugin storage is first read when a surface draws, never during setup.
    let readDisplay: (() => DisplaySettings) | undefined;
    const display = () => {
      readDisplay ??= loadDisplaySettings(api.storage);
      return readDisplay();
    };
    let sidebarStore: ReturnType<DisplayStorage["store"]> | undefined;
    const sidebarState = () => {
      sidebarStore ??= api.storage.store<SidebarState>("sidebar", { initial: { open: true } });
      return sidebarStore as readonly [
        SidebarState,
        (mutation: (draft: SidebarState) => void) => Promise<void>,
      ];
    };

    const isChildSession = (sessionID: string) =>
      Boolean(api.data.session.get(sessionID)?.parentID);
    const quota = createQuotaClient(api, (snapshot) => toasts.showResetNotices(snapshot));
    const toasts = createToasts({
      show: (toast) => api.ui.toast.show(toast),
      display,
      quota,
      isChildSession,
    });
    const host: SurfaceHost = { theme: () => api.theme, display, quota };
    const quotaWindow = createQuotaWindow(api, host);
    const quickLook = createQuickLook(api, host, quotaWindow);
    const quotaCommands = {
      quota: () => quickLook.open(),
      quota_usage: () => quotaWindow.open("usage"),
      quota_status: () => quotaWindow.open("status"),
      quota_settings: () => quotaWindow.open("settings"),
    };

    let disposeMount: (() => void) | undefined;
    const questionToolCalls = new Set<string>();
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        // OpenCode mounts this slot again when it reconnects to its server, which can also
        // happen right after it starts. Leaving a mount drops its keymap layers and event
        // listeners, so each mount stops the last one's and registers everything again.
        disposeMount?.();
        const stopQuota = quota.start();
        api.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "quota.quick_look",
              title: "Quota: quick look",
              group: "OpenCode Quota",
              palette: true,
              run: quotaCommands.quota,
            },
            {
              id: "quota.usage",
              title: "Quota: usage",
              group: "OpenCode Quota",
              palette: true,
              // The server lists /quota and /quota_status; these two exist only in the TUI.
              slash: { name: "quota_usage" },
              run: quotaCommands.quota_usage,
            },
            {
              id: "quota.status",
              title: "Quota status report",
              group: "OpenCode Quota",
              palette: true,
              run: quotaCommands.quota_status,
            },
            {
              id: "quota.settings",
              title: "Quota: settings",
              group: "OpenCode Quota",
              palette: true,
              slash: { name: "quota_settings" },
              run: quotaCommands.quota_settings,
            },
            ...reportCommands(api),
          ],
        }));
        registerTypedQuotaCommands(api, quotaCommands);
        const afterTurn = (event: TuiEvent, trigger: TurnEnd) => {
          const sessionID = eventSessionID(event);
          if (sessionID) void toasts.afterTurn(trigger, sessionID).catch(reportFailure);
        };
        const listeners = [
          api.data.on("session.execution.succeeded", (event) => afterTurn(event, "reply")),
          api.data.on("session.compaction.ended", (event) => afterTurn(event, "compaction")),
          // Each step can use quota; the server skips a refresh that is not due yet.
          api.data.on("session.step.ended", (event) => {
            const sessionID = eventSessionID(event);
            if (sessionID && !isChildSession(sessionID)) void quota.refresh("turn", sessionID);
          }),
          api.data.on("session.tool.input.started", (event) => {
            const id = eventToolCallID(event);
            if (event.data?.name === "question" && id) questionToolCalls.add(id);
          }),
          api.data.on("session.tool.success", (event) => {
            const id = eventToolCallID(event);
            if (id && questionToolCalls.delete(id)) afterTurn(event, "question");
          }),
          api.data.on("session.tool.failed", (event) => {
            const id = eventToolCallID(event);
            if (id) questionToolCalls.delete(id);
          }),
        ];
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (disposeMount === dispose) disposeMount = undefined;
          stopQuota();
          toasts.cancel();
          for (const stop of listeners) stop();
          questionToolCalls.clear();
        };
        disposeMount = dispose;
        onCleanup(dispose);
        return null;
      },
    });
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const [state, update] = sidebarState();
        return (
          <SidebarPanel
            host={host}
            sessionID={props.sessionID}
            open={() => state.open}
            setOpen={(open) => {
              void update((draft) => {
                draft.open = open;
              }).catch(reportFailure);
            }}
          />
        );
      },
    });
    const disposePrompt = api.ui.slot({
      append: "prompt.footer",
      // Home has a message box too; Home's status line sits in its own footer instead.
      render: (props) => (
        <Show when={props.sessionID && display().surfaces.statusLine.enabled}>
          <StatusLine host={host} sessionID={props.sessionID} />
        </Show>
      ),
    });
    const disposeHome = api.ui.slot({
      append: "home.footer.status",
      render: () => <HomeFooter host={host} />,
    });
    const disposeWindow = api.ui.slot({
      append: "session.composer.top",
      render: (props) => <quotaWindow.Slot sessionID={props.sessionID} />,
    });
    return () => {
      disposeMount?.();
      disposeApp();
      disposeSidebar();
      disposePrompt();
      disposeHome();
      disposeWindow();
    };
  },
});

export default plugin;
