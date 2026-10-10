[← Back to README](../../README.md)

# Configuration

Most people only need the table below. Every option is listed at the bottom.

## Where settings live

Settings go in one separate file:

- Project install: `<your-repo>/opencode-quota/quota-toast.jsonc`
- Global install: `~/.config/opencode/opencode-quota/quota-toast.jsonc` on every OS (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set)
- Custom config folder: `$OPENCODE_CONFIG_DIR/opencode-quota/quota-toast.jsonc` (replaces the global folder, like OpenCode 2)

Strict `.json` files also work. Not sure which file is active? Run `/quota_status`. Restart OpenCode after changing the file.

## Common changes

| You want                                    | Setting                                     |
| ------------------------------------------- | ------------------------------------------- |
| Find providers automatically                | `enabledProviders: "auto"`                  |
| Pick providers yourself                     | `enabledProviders: ["copilot", "openai"]`   |
| Show every reset period                     | `formatStyle: "allWindows"`                 |
| Show one quota window per provider          | `formatStyle: "singleWindow"`               |
| Show quota used instead of left             | `percentDisplayMode: "used"`                |
| Estimate when fixed quota runs out          | `quotaProjection: "runway"`                 |
| Show `81%` instead of `81% left`            | `percentLabelStyle: "bare"`                 |
| Show `2d5h14m` instead of `2d 5h 14m`       | `resetTimeSpaced: false`                    |
| Show reset countdowns as decimals (`5.7d`)  | `resetTimeDecimals: 1`                      |
| Show extra accounting rows                  | `accountingDetail: "detailed"`              |
| Show or hide session input/output tokens    | `showSessionTokens`                         |
| Include subagent session tokens             | `sessionTokenScope: "tree"`                 |
| Allow more time for provider requests       | `requestTimeoutMs: 12000`                   |
| Write quota JSON for another tool           | `export.enabled: true`                      |
| Keep OpenCode's normal retry after a limit  | `waitForQuotaReset: false`                  |

If the setting is missing, the default is `singleWindow`.

These settings shape `/quota` and terminal `show`. The TUI sidebar, status line and toasts have their own built-in look; see [TUI surfaces](#tui-surfaces).

Example:

```jsonc
{
  "enabledProviders": ["copilot", "openai", "google-agy"],
  "formatStyle": "allWindows",
  "percentDisplayMode": "remaining",
  "quotaProjection": "runway",
}
```

### Show accounting detail

`accountingDetail` has two values:

- `"summary"` (default): main rows only, with at most one supporting detail per percentage row.
- `"detailed"`: also shows supplementary rows and, on wide output, separate `Used`, `Limit`, and `Remaining` values.

It applies to `/quota` and terminal `show`. Narrow layouts may drop detail rather than cut off a money value. It is separate from `formatStyle` (which windows) and `percentDisplayMode` (used or left). `Used`, `Limit`, and `Remaining` always mean exactly that, in either mode. A change applies right away to data already fetched.

### Estimate when fixed quota runs out

`quotaProjection: "runway"` (off by default) adds a **Runs out** estimate to eligible rows on `/quota`.

- It is a straight-line average since the fixed window began: used percentage divided by time passed. It is not a recent-rate forecast. `percentDisplayMode` does not change it.
- It says **Runs out ≈ 1h 50m**. Partial minutes round up. If your current pace lasts past the reset, it says **lasts past reset**. The reset countdown stays separate.
- It uses cached data, makes no extra provider requests, and adds nothing to the JSON export.

Only rows with a known fixed window start, end, and full reset qualify. Labels such as Five-hour, Weekly, Monthly, or RPM never qualify a row by themselves:

- **OpenAI:** known 5-hour, weekly, or monthly rate-limit windows with `limit_window_seconds` and an exact reset. Spend-control rows, code-review rows, and unknown durations are excluded.
- **xAI:** credit periods with both `currentPeriod.start` and `currentPeriod.end`. A billing-end date without a start is excluded.
- **Cursor:** the included API budget when `cursorBillingCycleStartDay` is set. The calendar-month fallback, partial or unknown model spend, and spend-only rows are excluded.
- **Custom local estimates:** `utc-day` request and priced budget percentages. `rolling` windows and unpriced rows are excluded.

Everything else (rolling windows, RPM, balance, status, unlimited rows) is left unchanged.

### Notify when quota becomes available again

The server notices when a quota window resets, from data already fetched. The TUI popup for it is off, and `resetNotifications` is not read.

### Include subagent session tokens

Session totals count only the current session by default. `sessionTokenScope: "tree"` adds every subagent session, counted once. This applies to the session tokens in `/quota`, popup toasts, and the sidebar. It does not change `/tokens_session` or `/tokens_session_all`.

### Countdown and label styles

- Reset countdowns are exact and spaced by default, such as `6d 1h 17m`, `2h 14m`, or `37m`. Partial minutes round up.
- `resetTimeSpaced: false` writes `2d5h14m` instead of `2d 5h 14m`. Minute-only values, `reset`, and rounding stay the same. It applies to `/quota`.
- `resetTimeDecimals` (`0` to `4`) is not read: countdowns never show decimals.
- `percentLabelStyle: "bare"` shows `81%` instead of `81% left` (or `19%` instead of `19% used`) in `/quota`, which then shows `Quota [Remaining]` or `Quota [Used]` as the heading.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or tunes a maintained local estimate. Ask your agent to add a custom provider: [Custom providers](providers.md#custom-providers) has a copy-paste prompt.

To edit it yourself, add the definition to `quotaProviders` in the global `quota-toast.jsonc` or `.json` if one exists, otherwise to `experimental.quotaToast.quotaProviders` in the global `opencode.jsonc` or `.json`. Project definitions are not allowed. `/quota_status` (or the `quota_status` tool) checks it with the same validator used at startup.

Rules:

- `quotaProviders` is global-only and keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- `modelIds` affects only `onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- Remote APIs use a fixed authenticated `GET`. Formats: `quota-v1`, `json-v1`, and `openrouter-key-v1`. `json-v1` needs an `adapter` with 1–16 mappings; paths are literal own-property segment arrays, not JSONPath. See [response rules](providers.md#custom-providers).
- Local estimates support 1–16 UTC-day or rolling request windows. Counters live under `~/.local/state/opencode/opencode-quota/quota-providers/`.
- Automatic models.dev matching runs first. Add `pricingModelMap` only when it cannot find one clear model. `pricingModelMap` cannot override a successful automatic match.
- If any request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.
- Credentials resolve from `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then API-key logins saved in OpenCode 2 (`opencode.db`); an `apiKeyEnv` starting with `OPENCODE_QUOTA_` is the only source.
- Definitions run automatically with `enabledProviders: "auto"`. A manual list must include `quota-providers` and every built-in provider you still want.
- To tune maintained estimates, use the reserved `alibaba-coding-plan` ID and its window shape. Do not add a duplicate normal provider block.
- Not accepted: project secrets, scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, and automatic endpoint discovery.
- A custom model provider still needs its normal OpenCode `provider` block: that block tells OpenCode how to use the model, and `quotaProviders` tells OpenCode Quota how to measure it.
- `/quota_status` shows the exact state path and safe credential source, never URLs, keys, headers, response bodies, counter contents, or raw errors.

<details>
<summary><strong>Complete example (no separate quota settings file)</strong></summary>

Without a `quota-toast` file, `quotaProviders` goes in `experimental.quotaToast` in the global OpenCode config, next to the normal OpenCode `provider` block:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "experimental": {
    "quotaToast": {
      "enabledProviders": "auto",
      "quotaProviders": [
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
  },
  "provider": {
    "private-gateway": {
      "models": { "model-a": {} },
    },
  },
}
```

</details>

## Full configuration reference

Most settings go in the `opencode-quota/quota-toast.jsonc` or `.json` file described above. Keep `quotaProviders` in that file when it exists; otherwise use the global OpenCode JSONC/JSON `experimental.quotaToast` section; do not duplicate it in a second file. Existing `experimental.quotaToast` settings still work.

Provider credentials (API keys, cookies, tokens) are never set here. See [API keys](providers.md#api-keys) and each provider's [setup notes](providers.md#provider-setup-notes).

<details>
<summary><strong>All settings</strong></summary>

### Core settings

| Option                        | Default        | Meaning |
| ----------------------------- | -------------- | ------- |
| `enabled`                     | `true`         | Master switch. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` do nothing. |
| `enabledProviders`            | `"auto"`       | Auto-detect providers, or list them. Use `quota-providers` for custom definitions. |
| `quotaProviders`              | `[]`           | Custom provider definitions (global-only). See [Custom providers](#custom-providers). |
| `minIntervalMs`               | `300000`       | Minimum time between provider updates. |
| `requestTimeoutMs`            | `5000`         | Provider request timeout in milliseconds. |
| `formatStyle`                 | `singleWindow` | `singleWindow` shows one reset period per provider; `allWindows` shows all. Used by `/quota` and terminal `show`. Old `classic`/`grouped` names still work. |
| `percentDisplayMode`          | `remaining`    | `remaining` shows what is left; `used` shows what is used. |
| `quotaProjection`             | unset          | `"runway"` adds a **Runs out** estimate. See [above](#estimate-when-fixed-quota-runs-out). |
| `percentLabelStyle`           | unset          | `bare` drops `left`/`used` from labels. `full` is also accepted. |
| `accountingDetail`            | `summary`      | `summary` or `detailed`. See [above](#show-accounting-detail). |
| `resetTimeDecimals`           | unset          | `0`–`4`: show the largest countdown unit as a decimal. |
| `resetTimeSpaced`             | `true`         | `false` writes countdowns without spaces (`2d5h14m`). |
| `onlyCurrentModel`            | `false`        | Show only the current model's provider, when it can be found. |
| `waitForQuotaReset`           | `true`         | On by default. When a request hits a provider limit, the plugin asks that model's provider for fresh quota; if a window shows 0% left, OpenCode retries 1 minute after the earliest such window resets (at most 5 hours per wait) instead of retrying quickly or giving up. Interrupt the session to stop waiting (Esc twice in the TUI). Set `"waitForQuotaReset": false` to keep OpenCode's normal retry timing. |
| `showSessionTokens`           | `true`         | Show `Session input/output tokens` when available. Cached input appears in parentheses next to input. |
| `sessionTokenScope`           | `"current"`    | `current` or `tree` (adds subagent sessions). See [above](#include-subagent-session-tokens). |
| `pricingSnapshot.source`      | `"auto"`       | Token pricing for `/tokens_*`: `auto`, `bundled`, or `runtime`. |
| `pricingSnapshot.autoRefresh` | `7`            | Refresh local pricing after this many days. |

### TUI surfaces

The sidebar, the status line and toasts draw the server's last quota snapshot with a built-in look (kept in OpenCode's plugin storage). They don't read `tuiSidebarPanel`, `tuiCompactStatus`, `tuiPromptBar`, `enableToast`, `toastDurationMs`, `showOnIdle`, `showOnQuestion`, `showOnCompact`, `showOnBothFail`, `layout`, `debug`, or `resetNotifications`.

- **Sidebar:** the `Quota` panel of each session, with a bar per row and the session tokens. Click its title to collapse it to one line per provider; OpenCode remembers the choice.
- **Status line:** under the message box, in the room OpenCode's footer leaves free. Each provider shows its lowest window with as much detail as fits; when not all fit, scroll with the mouse wheel or click `‹` and `+N ›`.
- **Toasts:** after compaction and when every provider fails, for 9 seconds. Toasts appear only in the TUI, never in Web or Desktop.

### Maintainer notices

| Option                                  | Default   | Meaning |
| --------------------------------------- | --------- | ------- |
| `maintainerAnnouncements.enabled`       | `true`    | Show bundled maintainer notices. |
| `maintainerAnnouncements.home`          | `true`    | Show the count of active notices at the bottom of Home. |
| `maintainerAnnouncements.homeFrequency` | `"daily"` | `"daily"`: show that Home line on the first Home screen of each day, for 10 minutes. `"always"`: show it on every Home screen. The Notices tab of `/quota` lists every notice. |

### Provider settings

| Option                       | Default                            | Meaning |
| ---------------------------- | ---------------------------------- | ------- |
| `anthropicBinaryPath`        | `"claude"`                         | Claude CLI command or path. With `"claude"`, OpenCode's `PATH` is tried first, then the usual install folders (not on Windows). |
| `opencodeGoWindows`          | `["rolling", "weekly", "monthly"]` | Which OpenCode Go windows appear: Five-hour, Weekly, and Monthly. |
| `opencodeMonthlyLimit`       | unset                              | Override the OpenCode Zen monthly budget in USD. |
| `cursorPlan`                 | `"none"`                           | Cursor included API budget: `none`, `pro`, `pro-plus`, or `ultra`. |
| `cursorIncludedApiUsd`       | unset                              | Override Cursor's monthly included API budget in USD. |
| `cursorBillingCycleStartDay` | unset                              | Billing day `1`–`28`. Unset uses the local calendar month. |

The old `opencodeZenDisplay` setting is gone. If it is still in your config, it is ignored and `/quota_status` reports it; use root `accountingDetail` (`"summary"` or `"detailed"`) instead.

### Export and telemetry settings

| Option              | Default | Meaning |
| ------------------- | ------- | ------- |
| `export.enabled`    | `false` | Write a JSON file each time the server's quota snapshot changes. |
| `export.path`       | `""`    | Empty uses `$XDG_CACHE_HOME/opencode/quota-export.json`. Supports `~/`. A relative path is relative to your home folder, where OpenCode's service runs. |
| `telemetry.enabled` | `false` | Publish quota and cache-age gauges through OpenCode's global OpenTelemetry `MeterProvider`. No extra provider calls. |

See [External integration](external-integration.md) for details.

</details>
