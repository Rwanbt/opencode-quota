[← Back to README](../../README.md)

# Manual install

The easy way is one command:

```bash
opencode plugin add @slkiser/opencode-quota
```

Use this page only if you want to edit OpenCode files yourself.

## Requirements

- OpenCode `2.0.16` or newer. On OpenCode 1, use `npx @slkiser/opencode-quota@4 init`.
- Node.js `22.13+` is required for `npx @slkiser/opencode-quota ...` (on Node 23, `23.4+`).

## Choose where to install

- **Global:** works in every project. Files live in `~/.config/opencode` on every OS (`$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set).
- **Project:** works only in the current repo or worktree.
- **Custom:** if `OPENCODE_CONFIG_DIR` is set, OpenCode uses that folder instead of the global one.

Use `.jsonc` files if you want comments, or `.json` if another tool needs strict JSON (no comments, no trailing commas).

## 1. Add the plugin

Add OpenCode Quota to `opencode.jsonc` or `opencode.json`, and keep your other plugins. This one entry loads both the server and the TUI; no `tui.json` entry is needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

## 2. Add quota settings (optional)

OpenCode Quota works without settings. To change something, create `opencode-quota/settings.jsonc` in the global OpenCode folder (or in `$OPENCODE_CONFIG_DIR`), also for a project install:

```jsonc
{
  // Find providers from your OpenCode config and logins.
  "providers": { "enabled": "auto" },

  // Show the count of maintainer notices on Home, once a day for 10 minutes.
  "announcements": { "enabled": true, "home": true },
}
```

Restart OpenCode, then run `/quota` and `/quota_status` in the TUI. `/quota_status` shows the settings file OpenCode Quota read.

## What appears in the TUI

The TUI shows the `Quota` panel in the session sidebar, a status line under the message box, and a toast after compaction. Change their look in the Settings tabs of `/quota`; see [TUI surfaces](configuration.md#tui-surfaces). Web and Desktop show none of these. See [Configuration](configuration.md) for every setting.

## Web and Desktop notes

- Slash commands work in the TUI, Web, and Desktop. Add a range after `/quota_usage`, like `/quota_usage between 2026-09-01 2026-09-25`.
- **TUI:** `/quota`, `/quota_usage` and `/quota_status` open the quota window above the message box, with tabs for limits, usage, maintainer notices and the `/quota_status` report, and Settings tabs for the sidebar, status line and toasts. They leave no chat message. The command palette has the same commands.
- **Web and Desktop:** `/quota` posts your limits and the maintainer notices in the chat as your message; the other commands post their report the same way. The AI never answers it, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered.
- Each report starts with `[OpenCode Quota report]` and ends with `[End of OpenCode Quota report]`, which also keeps it out of compaction summaries.
- Web uses a proportional font, so columns may not line up. Use the TUI or `npx @slkiser/opencode-quota show` for aligned columns.
- If the AI is busy, the report appears after it finishes. A new session whose first message is a report keeps its default title.
- The AI can call the `quota_status` tool to check your setup.

To update later, see [Updating](updating.md).
