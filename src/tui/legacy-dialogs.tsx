/**
 * Runs the quota slash commands typed in the prompt in the TUI, before OpenCode sends them to
 * the server as a message.
 */

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

/** What the typed commands (and the palette commands in `index.tsx`) need from the TUI context. */
export type TypedCommandHost = {
  renderer: { currentFocusedEditor: { plainText: string; clear: () => void } | null };
  keymap: {
    /** Without a mode, a layer is active only in OpenCode's base mode. */
    layer: (
      build: () => { mode?: "global" | "modal"; priority?: number; commands: KeymapCommand[] },
    ) => void;
  };
};

/**
 * Runs quota slash commands typed in the prompt in the TUI. On Enter, before OpenCode submits
 * the prompt, a prompt that starts with a quota command is cleared and the command runs with
 * the rest of the prompt as its arguments: each of `quotaCommands` (/quota, /quota_usage,
 * /quota_status, /quota_settings) runs its TUI action. So no report shows in the chat, and on
 * Home no session is created for one. The "/" list names each once: the server lists /quota,
 * /quota_usage and /quota_status, the TUI /quota_settings.
 * The layer has no mode, so it is off while the "/" list or a dialog is open.
 */
export function registerTypedQuotaCommands(
  context: TypedCommandHost,
  quotaCommands: Record<string, (argumentsText: string) => void>,
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
          if (!Object.hasOwn(quotaCommands, name)) return false;
          editor.clear();
          quotaCommands[name](trimmed.slice(1 + name.length).trim());
        },
      },
    ],
  }));
}
