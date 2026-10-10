/** @jsxImportSource @opentui/solid */
/**
 * The report dialogs of the token and pricing slash commands (`/tokens_*`, `/pricing_refresh`),
 * moved unchanged from the v5 TUI. The server builds each report over the quota RPC's `command`
 * method; this file shows it. It also runs the quota slash commands typed in the prompt.
 */

import { type RGBA, type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";

import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { fitTableToWidth } from "../lib/markdown-table.js";
import {
  type ReportBlock,
  type ReportDocument,
  renderableSections,
  renderKvRow,
} from "../lib/report-document.js";
import { QuotaRpc, REPORT_COMMANDS, type ReportCommandId } from "../rpc.js";
import {
  type QuotaRpcClient,
  quotaCallOptions,
  type RpcLocationHost,
  rpcErrorMessage,
} from "./client.js";

type Toast = {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
  duration?: number;
};
type KeymapCommand = {
  id?: string;
  title?: string;
  group?: string;
  bind?: string;
  palette?: true;
  /** A TUI-only "/" entry; without `arguments` it runs when picked from the "/" list. */
  slash?: { name: string };
  /** Returning false lets the key continue to the next layer. */
  run: () => void | false | Promise<void>;
};
type DialogTheme = {
  text: { base: RGBA; muted: RGBA; action: { primary: { focused: RGBA; selected: RGBA } } };
  background: { action: { primary: { focused: RGBA } } };
};
/** What the report dialogs need from the TUI context. */
export type LegacyDialogHost = RpcLocationHost & {
  renderer: { currentFocusedEditor: { plainText: string; clear: () => void } | null };
  client: {
    rpc: (definition: typeof QuotaRpc) => Pick<QuotaRpcClient, "command">;
  };
  theme: { surface: (name: "dialog") => DialogTheme };
  keymap: {
    /** Without a mode, a layer is active only in OpenCode's base mode. */
    layer: (
      build: () => { mode?: "global" | "modal"; priority?: number; commands: KeymapCommand[] },
    ) => void;
  };
  ui: {
    router: {
      current: () => { type: "home" } | { type: "session"; sessionID: string } | { type: "plugin" };
    };
    toast: { show: (toast: Toast) => void };
    dialog: {
      show: (render: () => JSX.Element, onClose?: () => void) => void;
      clear: () => void;
      prompt: (params: { title: string; placeholder?: string }) => Promise<string | undefined>;
      set: (params: { size: "xlarge" }) => void;
    };
  };
};

type TuiContext = LegacyDialogHost;

/** OpenCode's "xlarge" dialog width (dialogWidth in its ui/dialog.tsx). */
const DIALOG_WIDTH = 116;

/**
 * One block of a report. Lines and key-value rows wrap at words. A table keeps each row on
 * one line and spans `width` columns when it fits (see fitTableToWidth), with the header row
 * bold in OpenCode's primary accent (its text color for a selected tab). Like OpenCode's
 * sidebar, labels are muted and values are base.
 */
function ReportBlockView(props: {
  block: ReportBlock;
  theme: DialogTheme;
  width: number;
}): JSX.Element {
  const block = props.block;
  if (block.kind === "lines") {
    return <text fg={props.theme.text.muted}>{sanitizeDisplayText(block.lines.join("\n"))}</text>;
  }
  if (block.kind === "kv") {
    return (
      <box flexDirection="column">
        {block.rows.map(({ value, ...key }) =>
          value === undefined ? (
            <text fg={props.theme.text.muted}>{sanitizeDisplayText(renderKvRow(key))}</text>
          ) : (
            <text fg={props.theme.text.muted}>
              {sanitizeDisplayText(renderKvRow({ ...key, trailingColon: true }))}
              <span style={{ fg: props.theme.text.base }}> {sanitizeDisplayText(value)}</span>
            </text>
          ),
        )}
      </box>
    );
  }
  // Read in the JSX, so the table is laid out again when the terminal is resized.
  const table = () =>
    fitTableToWidth({
      headers: block.headers.map(sanitizeDisplayText),
      fullHeaders: block.fullHeaders?.map(sanitizeDisplayText),
      rows: block.rows.map((row) => row.map(sanitizeDisplayText)),
      aligns: block.aligns,
      width: props.width,
    });
  return (
    <box flexDirection="column">
      <text
        attributes={TextAttributes.BOLD}
        fg={props.theme.text.action.primary.selected}
        wrapMode="none"
      >
        {table().header}
      </text>
      {table().rows.map((row) => (
        <text fg={props.theme.text.base} wrapMode="none">
          {row}
        </text>
      ))}
    </box>
  );
}

/**
 * Draws a report document's sections with the same spacing as its plain text: one blank row
 * between the sections and between the blocks of a section, and a section title directly
 * above its first block. Section titles are bold. The dialog shows the heading's subtitle
 * under its own title, so the heading line is left out.
 */
function ReportDocumentView(props: {
  document: ReportDocument;
  theme: DialogTheme;
  width: number;
}): JSX.Element {
  return (
    <box flexDirection="column" gap={1}>
      {renderableSections(props.document).map((section) => (
        <box flexDirection="column">
          {section.title ? (
            <text attributes={TextAttributes.BOLD} fg={props.theme.text.base}>
              {sanitizeDisplayText(section.title)}
            </text>
          ) : null}
          <box flexDirection="column" gap={1}>
            {section.blocks.map((block) => (
              <ReportBlockView block={block} theme={props.theme} width={props.width} />
            ))}
          </box>
        </box>
      ))}
    </box>
  );
}

/**
 * Shows command output like OpenCode's alert dialog, but inside a scrollbox so long
 * reports (/quota_status, /tokens_*) stay reachable. The mouse wheel scrolls the box;
 * arrows, PageUp/PageDown, and Home/End scroll it from the keyboard. Esc is handled by
 * the host dialog; Enter and the ok/esc labels close it.
 */
function QuotaOutputDialog(props: {
  context: TuiContext;
  title: string;
  document: ReportDocument;
}): JSX.Element {
  const theme = () => props.context.theme.surface("dialog");
  const dimensions = useTerminalDimensions();
  // OpenCode's dialog is its size's width, at most the terminal width minus 2. Inside it
  // come this box's paddings (2 + 2) and one column for the scrollbox's scrollbar, which
  // shows when the report is taller than the box.
  const tableWidth = () => Math.min(DIALOG_WIDTH, dimensions().width - 2) - 4 - 1;
  const subtitle = props.document.heading?.subtitle;
  // The host dialog starts a quarter of the way down the terminal. The remaining
  // 8 rows cover the title, ok button, paddings, gaps, and one spare row; the subtitle
  // takes one more.
  const maxHeight = () =>
    Math.max(1, Math.floor(dimensions().height * 0.75) - 8 - (subtitle ? 1 : 0));
  let scroll: ScrollBoxRenderable | undefined;
  const close = () => props.context.ui.dialog.clear();

  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Close", group: "Dialog", run: close },
      { bind: "up", title: "Scroll up", group: "Dialog", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: "Dialog", run: () => scroll?.scrollBy(1) },
      {
        bind: "pageup",
        title: "Scroll up one page",
        group: "Dialog",
        run: () => scroll?.scrollBy(-maxHeight()),
      },
      {
        bind: "pagedown",
        title: "Scroll down one page",
        group: "Dialog",
        run: () => scroll?.scrollBy(maxHeight()),
      },
      { bind: "home", title: "Scroll to top", group: "Dialog", run: () => scroll?.scrollTo(0) },
      {
        bind: "end",
        title: "Scroll to bottom",
        group: "Dialog",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
    ],
  }));

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme().text.base}>
            {props.title}
          </text>
          <text fg={theme().text.muted} onMouseUp={close}>
            esc
          </text>
        </box>
        {subtitle ? <text fg={theme().text.muted}>{sanitizeDisplayText(subtitle)}</text> : null}
      </box>
      <box paddingBottom={1}>
        <scrollbox
          ref={(element: ScrollBoxRenderable) => {
            scroll = element;
          }}
          maxHeight={maxHeight()}
        >
          <ReportDocumentView document={props.document} theme={theme()} width={tableWidth()} />
        </scrollbox>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme().background.action.primary.focused}
          onMouseUp={close}
        >
          <text fg={theme().text.action.primary.focused}>ok</text>
        </box>
      </box>
    </box>
  );
}

function showQuotaOutputDialog(
  context: TuiContext,
  output: { title: string; document: ReportDocument },
): Promise<void> {
  return new Promise<void>((resolve) => {
    context.ui.dialog.show(
      () => <QuotaOutputDialog context={context} title={output.title} document={output.document} />,
      resolve,
    );
    context.ui.dialog.set({ size: "xlarge" });
  });
}

/**
 * Runs a report command from the command palette or the prompt. It opens the dialog and
 * posts no message. `typed` holds the arguments typed after the command name in the prompt.
 */
async function runReportCommand(
  context: TuiContext,
  command: ReportCommandId,
  sessionID: string | undefined,
  typed?: { argumentsText: string | undefined },
): Promise<void> {
  let argumentsText = typed?.argumentsText;
  // Only /tokens_between needs arguments; the palette asks for them.
  if (command === "tokens_between" && !typed) {
    const value = await context.ui.dialog.prompt({
      title: "OpenCode Quota Token Report",
      placeholder: "YYYY-MM-DD YYYY-MM-DD",
    });
    if (value === undefined) return;
    argumentsText = value.trim() || undefined;
  }

  try {
    const result = await context.client
      .rpc(QuotaRpc)
      .command({ command, arguments: argumentsText, sessionID }, quotaCallOptions(context));
    if (result.state === "noop") return;
    await showQuotaOutputDialog(context, { title: result.title, document: result.document });
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "OpenCode Quota",
      message: sanitizeDisplayText(rpcErrorMessage(error)),
    });
  }
}

function getRouteSessionID(context: TuiContext): string | undefined {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

/** The palette entries of the report commands. No slash entry: the server lists the "/" ones. */
export function reportCommands(context: TuiContext): KeymapCommand[] {
  return REPORT_COMMANDS.map((spec) => ({
    id: `quota.${spec.id}`,
    title: spec.title,
    group: "OpenCode Quota",
    palette: true,
    run: () => runReportCommand(context, spec.id, getRouteSessionID(context)),
  }));
}

/**
 * Runs quota slash commands typed in the prompt in the TUI. On Enter, before OpenCode submits
 * the prompt, a prompt that holds exactly a quota command is cleared and the command runs:
 * `quotaCommands` (/quota, /quota_usage, /quota_status, /quota_settings) their TUI action, the
 * report commands their dialog. So no report shows in the chat, and on Home no session is
 * created for one. The "/" list names each once: the server lists /quota, /quota_status and
 * the reports, the TUI the others.
 * The layer has no mode, so it is off while the "/" list or a dialog is open.
 */
export function registerTypedQuotaCommands(
  context: TuiContext,
  quotaCommands: Record<string, () => void>,
): void {
  context.keymap.layer(() => ({
    // Above OpenCode's textarea layer, which submits the prompt on Enter.
    priority: 1,
    commands: [
      {
        bind: "return",
        // Synchronous on purpose: a returned promise counts as handled.
        run: () => {
          const editor = context.renderer.currentFocusedEditor;
          const trimmed = editor?.plainText.trim() ?? "";
          if (!editor || !trimmed.startsWith("/")) return false;
          // As in OpenCode, the command name ends at the first whitespace.
          const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
          const argumentsText = trimmed.slice(1 + name.length).trim() || undefined;
          const quotaCommand = Object.hasOwn(quotaCommands, name) ? quotaCommands[name] : undefined;
          const report = REPORT_COMMANDS.find((spec) => spec.id === name);
          if (!quotaCommand && !report) return false;
          editor.clear();
          if (quotaCommand) quotaCommand();
          else if (report) {
            void runReportCommand(context, report.id, getRouteSessionID(context), {
              argumentsText,
            });
          }
        },
      },
    ],
  }));
}
