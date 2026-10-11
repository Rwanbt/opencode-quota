[← Back to README](../../README.md)

# Configuration

Most people need no settings. When you do, the table below covers the usual changes, and every setting but `version` is listed at the bottom.

## Where settings live

One global file, `settings.jsonc`:

- `~/.config/opencode/opencode-quota/settings.jsonc` on every OS (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set)
- `$OPENCODE_CONFIG_DIR/opencode-quota/settings.jsonc` when `OPENCODE_CONFIG_DIR` is set (it replaces the global folder, like OpenCode 2)

There are no project settings. Comments and trailing commas are allowed. Every key is optional. A missing or invalid value uses its default. `/quota_status` shows the file it reads and any problems in it.

Every quota setting lives here, with one section per Settings tab: `sidebar`, `collapsed`, `statusLine`, `toast`, `colors`, `layout`, `words`, `providers`, and `system`. In the TUI, `/quota_settings` edits the settings through the server. Save, or ctrl+s, writes them to this file and keeps its comments. While you edit, the sidebar, status line, toasts and quota window show saved values with your unsaved changes on top. Discard drops those changes. File edits and a Save from any TUI reach all open TUIs within a few seconds.

Only the sidebar panel's open or collapsed state lives in OpenCode's plugin storage. Custom definitions, the Claude CLI path, the export path and `system.noticesOnHomeEvery` are file-only settings. The Notices tab changes the notice switches. Export and telemetry switches are in the file's `system` section.

Without the file, OpenCode Quota uses its defaults and writes nothing. Saving creates the file with the default sections. The first start with global 5.x settings converts them into this file. See [Updating](updating.md#moving-from-5x).

## Common changes

| You want | Setting |
| --- | --- |
| Check every provider quota finds | `providers.off: []` |
| Skip a provider | `providers.off: ["openai"]` |
| Show quota used instead of left | `words.percent: "used"` |
| Show `81%` instead of `81% left` | `words.percent: "bare"` |
| Show `2h14m` instead of `2h 14m` | `words.reset: "compact"` |
| Show reset countdowns as decimals | `words.reset: "decimal"` |
| Show extra accounting rows | `words.detail: "detailed"` |
| Show only the current model's provider | `words.onlyCurrentModel: true` |
| Include subagent session tokens | `words.sessionTokens: "tree"` |
| Allow more time for provider requests | `providers.checking.requestTimeoutMs: 12000` |
| Keep OpenCode's normal retry after a limit | `providers.checking.waitForQuotaReset: false` |
| Write quota JSON for another tool | `system.exportFile: true` |

Nest the keys in the file:

```jsonc
{
  "sidebar": { "sessionTokens": false },
  "collapsed": { "window": { "anthropic": "five_hour" } },
  "statusLine": { "window": { "anthropic": "week" } },
  "toast": { "afterReply": "low" },
  "colors": { "good": "green" },
  "layout": { "barWidth": 10 },
  "words": { "percent": "used", "reset": "compact" },
  "providers": { "off": ["openai"], "checking": { "requestTimeoutMs": 12000 } },
  "system": { "notices": true },
}
```

The `words` settings apply to the sidebar, status line, toasts, `/quota`, and terminal `show`. Web and Desktop `/quota` text and terminal `show` always include "runs out in" when the limit's pace runs out before its reset. Each TUI surface has its own `runsOut` switch, off by default. The Limits tab always shows pace.

## TUI surfaces

- Sidebar shows a bar per row and session tokens. Click its title to collapse it. `sidebar.names` holds row names by row id. The collapsed sidebar, status line and quota window's Limits tab use those names too.
- Collapsed shows one line per provider. `collapsed.window` picks a window per provider id.
- Status line uses the room OpenCode's footer leaves free. `statusLine.window` picks its own window per provider. The `‹ ›` window picker on each tab changes only that tab's setting. Scroll with the mouse wheel or click `‹` and `+N ›` when providers do not fit.
- Toasts appear after compaction and when every provider fails, for 9 seconds by default. `toast.names` holds their row names. Renaming a row on Sidebar or Toast changes that tab's names only. Toasts appear only in the TUI.

`/quota`, `/quota_usage`, `/quota_status` and `/quota_settings` open the quota window on Limits, Usage, System and the first Settings tab.

On Providers, every provider is ticked unless its id is in `providers.off`. Ticked providers show "checked" when found, or "not found" when absent. Unticked providers show "skipped". Space or a click switches a provider on or off. A provider found later is checked automatically unless it is switched off.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or tunes a maintained local estimate. Ask your agent to add a custom provider: [Custom providers](providers.md#custom-providers) has a copy-paste prompt.

To edit it yourself, add the definition to `providers.custom` in `settings.jsonc`. `/quota_status` (or the `quota_status` tool) checks it with the same validator the plugin uses.

Rules:

- `providers.custom` keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- `modelIds` only limits `words.onlyCurrentModel` and which requests a local estimate counts. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- Remote APIs use a fixed authenticated `GET`. Formats: `quota-v1`, `json-v1`, and `openrouter-key-v1`. `json-v1` needs an `adapter` with 1–16 mappings; paths are literal own-property segment arrays, not JSONPath. See [response rules](providers.md#custom-providers).
- Local estimates support 1–16 UTC-day or rolling request windows. Counters live under `~/.local/state/opencode/opencode-quota/quota-providers/`.
- Automatic models.dev matching runs first. Add `pricingModelMap` only when it cannot find one clear model. `pricingModelMap` cannot override a successful automatic match.
- If any request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.
- Credentials resolve from `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then API-key logins saved in OpenCode 2 (`opencode.db`).
- `"enabled": false` switches a definition off: it is never fetched, its key is never sent, and `/quota_status` shows it as off. Without `enabled` (or with `true`) it is on. Providers an agent adds start switched off; switch one on by setting `"enabled": true` in `opencode-quota/settings.jsonc`, or in `/quota_settings` → **Providers**, which shows each custom provider's web address and the key it sends (and warns about plain `http`) next to its switch.
- Definitions run when `custom` is absent from `providers.off`. Adding `custom` there skips every custom definition. Each definition also has its own `enabled` switch.
- To tune maintained estimates, use the reserved `alibaba-coding-plan` ID and its window shape. Do not add a duplicate normal provider block.
- Not accepted: project secrets, scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, and automatic endpoint discovery.
- A custom model provider still needs its normal OpenCode `provider` block in `opencode.json`: that block tells OpenCode how to use the model, and `providers.custom` tells OpenCode Quota how to measure it.
- `/quota_status` shows each definition as `custom 1`, `custom 2`, … with its mode, model count, check outcome and credential source, never its id, URLs, keys, headers, response bodies, counter contents, or raw errors.

<details>
<summary><strong>Complete example</strong></summary>

`settings.jsonc`:

```jsonc
{
  "providers": {
    "off": [],
    "custom": [
      {
        "id": "openrouter-primary",
        "providerId": "openrouter",
        "label": "OpenRouter Primary",
        "mode": "remote-api",
        "url": "https://openrouter.ai/api/v1/key",
        "format": "openrouter-key-v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
      },
      {
        "id": "private-gateway",
        "label": "Private Gateway Estimate",
        "mode": "local-estimate",
        "modelIds": ["model-a"],
        "windows": [
          { "id": "daily", "label": "Daily", "type": "utc-day", "requestLimit": 1000, "usdBudget": 25 },
        ],
      },
    ],
  },
}
```

The global `opencode.json` keeps the normal OpenCode `provider` block:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "private-gateway": {
      "models": { "model-a": {} },
    },
  },
}
```

</details>

## All settings

Credentials belong in OpenCode or environment variables, never in this file. See [API keys](providers.md#api-keys).

<details>
<summary>Settings by tab</summary>

### Sidebar, Collapsed, Status line and Toast

Each section has `show: true`, `runsOut: false`, `hidden: []`, `providerOrder: []`, and `rowOrder: {}`. `hidden` lists provider or row ids. `providerOrder` lists provider ids; `rowOrder` maps a provider id to a list of row ids. Unlisted ids follow their normal order.

| Setting | Default | Values |
| --- | --- | --- |
| `sidebar.sessionTokens`, `toast.sessionTokens` | `true` | Show the session tokens line. |
| `sidebar.names`, `toast.names` | `{}` | Row ids mapped to names. |
| `collapsed.window`, `statusLine.window` | `{}` | Provider ids mapped to `lowest`, `rpm`, `hour`, `five_hour`, `session`, `day`, `week`, `month`, `year`, `mcp`, or `code_review`. Missing means lowest left. |
| `statusLine.detail` | `"auto"` | `auto`, `one`, `full`, `bar`, `reset`, `numbers`. |
| `statusLine.width` | `0` | Whole number 0–1000. 0 uses all free room. |
| `statusLine.autoScrollSeconds` | `0` | Whole number 0–600. 0 switches scrolling off. |
| `statusLine.home` | `false` | Show the status line at the bottom of Home. |
| `toast.afterReply` | `"off"` | `off`, `always`, or `low`. |
| `toast.afterQuestion` | `false` | Show quota after a question. |
| `toast.afterCompaction` | `true` | Show quota after compaction. |
| `toast.whenAllFail` | `true` | Show quota when every provider fails. |
| `toast.resetNotice` | `"off"` | `off`, `weekly`, or `all`. |
| `toast.seconds` | `9` | Whole number 1–120. |

### Colors

Roles are `good`, `warning`, `low`, `empty`, `title`, `provider`, `account`, `label`, `percent`, `reset`, `value`, `error`, `statusName`, `separator`, and `arrows`. Each `colors.<role>` follows the theme when unset. Set a role to `text`, `muted`, `accent`, `green`, `yellow`, `red`, `blue`, `bar`, or a `#rrggbb` color. `bar` follows the row's level color.

| Setting | Default | Values |
| --- | --- | --- |
| `colors.warningBelow` | `50` | Whole number 0–100, percent left below which quota is getting low. |
| `colors.lowBelow` | `20` | Whole number 0–100, percent left below which quota is almost out. |

### Layout

| Setting | Default | Values |
| --- | --- | --- |
| `layout.bar` | `"blocks"` | `blocks`, `shades`, `line`, `squares`, `dots`, `none`. |
| `layout.barWidth` | `8` | Whole number 1–30. |
| `layout.indent` | `1` | Whole number 0–4. |
| `layout.labelWidth` | `8` | Whole number 3–20. |
| `layout.providerGap` | `0` | Whole number 0–2. |
| `layout.separator` | `" · "` | Up to 5 characters. |

### Words

| Setting | Default | Values |
| --- | --- | --- |
| `words.percent` | `"left"` | `left`, `remaining`, `bare`, `used`. |
| `words.reset` | `"exact"` | `exact` gives `2h 14m`, `compact` gives `2h14m`, `short` gives `2h`, `decimal` gives `2.2h`. |
| `words.resetDecimals` | `1` | Whole number 0–4. |
| `words.detail` | `"summary"` | `detailed` includes supplementary rows. |
| `words.onlyCurrentModel` | `false` | Show providers serving the current model. |
| `words.sessionTokens` | `"current"` | `tree` includes subagent sessions, each counted once. |

### Providers

| Setting | Default | Values |
| --- | --- | --- |
| `providers.off` | `[]` | Provider ids switched off. `custom` means every custom definition. |
| `providers.custom` | `[]` | Custom provider definitions, file only. |
| `providers.anthropic.binaryPath` | `"claude"` | CLI command or absolute or `~/` path without `..`, file only. |
| `providers.cursor.plan` | `"none"` | `none`, `pro`, `pro-plus`, `ultra`. |
| `providers.cursor.includedApiUsd` | `null` | Positive monthly USD amount. Unset uses the plan. |
| `providers.cursor.billingCycleStartDay` | `null` | Whole number 1–28. Unset uses the calendar month. |
| `providers.opencode.monthlyLimitUsd` | `null` | Positive monthly USD amount. |
| `providers.checking.minIntervalMs` | `300000` | Positive milliseconds between provider checks. |
| `providers.checking.requestTimeoutMs` | `5000` | Positive request timeout in milliseconds. |
| `providers.checking.waitForQuotaReset` | `true` | On a model limit error, wait until 1 minute after the earliest exhausted window resets, at most 5 hours. `false` keeps normal retry timing. |
| `providers.pricing.source` | `"auto"` | `auto`, `bundled`, `runtime`. |
| `providers.pricing.autoRefreshDays` | `7` | Whole number of days, at least 1. |

### System

| Setting | Default | Values |
| --- | --- | --- |
| `system.notices` | `true` | Show maintainer notices. |
| `system.noticesOnHome` | `true` | Show their count on Home. |
| `system.noticesOnHomeEvery` | `"daily"` | `daily` shows the count for 10 minutes on the first Home screen of the day. `always` shows it each time. File only. |
| `system.exportFile` | `false` | Write quota JSON when the snapshot changes. |
| `system.exportPath` | `""` | Empty uses `$XDG_CACHE_HOME/opencode/quota-export.json`; otherwise an absolute or `~/` path without `..`. File only. |
| `system.telemetry` | `false` | Publish quota and cache-age metrics through OpenCode's global OpenTelemetry MeterProvider. |

See [External integration](external-integration.md) for JSON and telemetry details.

</details>
