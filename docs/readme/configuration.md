[← Back to README](../../README.md)

# Configuration

Most people need no settings. When you do, the table below covers the usual changes, and every setting is listed at the bottom.

## Where settings live

One global file, `settings.jsonc`:

- `~/.config/opencode/opencode-quota/settings.jsonc` on every OS (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set)
- `$OPENCODE_CONFIG_DIR/opencode-quota/settings.jsonc` when `OPENCODE_CONFIG_DIR` is set (it replaces the global folder, like OpenCode 2)

There are no project settings. Comments and trailing commas are allowed. Every key is optional: a missing or invalid one uses its default. Changes apply without a restart. `/quota_status` shows the file it reads and anything wrong in it.

Without the file, OpenCode Quota uses the defaults. Create it when you want to change something. Coming from 5.x, the first start writes it from your old settings; see [Updating](updating.md#moving-from-5x).

## Common changes

| You want                                   | Setting                                            |
| ------------------------------------------ | -------------------------------------------------- |
| Find providers automatically               | `providers.enabled: "auto"`                        |
| Pick providers yourself                    | `providers.enabled: ["copilot", "openai"]`         |
| Show quota used instead of left            | `words.percent: "used"`                            |
| Show `81%` instead of `81% left`           | `words.percent: "bare"`                            |
| Show `2h14m` instead of `2h 14m`           | `words.reset: "compact"`                           |
| Show reset countdowns as decimals (`5.7d`) | `words.reset: "decimal"`                           |
| Show extra accounting rows                 | `words.detail: "detailed"`                         |
| Show only the current model's provider     | `words.onlyCurrentModel: true`                     |
| Include subagent session tokens            | `words.sessionTokens: "tree"`                      |
| Allow more time for provider requests      | `checking.requestTimeoutMs: 12000`                 |
| Keep OpenCode's normal retry after a limit | `checking.waitForQuotaReset: false`                |
| Write quota JSON for another tool          | `export.enabled: true`                             |

Example:

```jsonc
{
  "providers": { "enabled": ["copilot", "openai", "google-agy"] },
  "words": { "percent": "used", "reset": "compact" },
  "checking": { "requestTimeoutMs": 12000 },
}
```

The `words` settings apply everywhere: the sidebar, the status line, toasts, `/quota`, and terminal `show`.

## TUI surfaces

How the sidebar, the status line and toasts look (which rows, colors, bars, when toasts appear) is not in `settings.jsonc`. The TUI keeps it in OpenCode's plugin storage: the built-in look, plus the 5.x display settings converted on the first start.

- **Sidebar:** the `Quota` panel of each session, with a bar per row and the session tokens. Click its title to collapse it to one line per provider; OpenCode remembers the choice.
- **Status line:** under the message box, in the room OpenCode's footer leaves free. Each provider shows its lowest window with as much detail as fits; when not all fit, scroll with the mouse wheel or click `‹` and `+N ›`.
- **Toasts:** after compaction and when every provider fails, for 9 seconds. Toasts appear only in the TUI, never in Web or Desktop.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or tunes a maintained local estimate. Ask your agent to add a custom provider: [Custom providers](providers.md#custom-providers) has a copy-paste prompt.

To edit it yourself, add the definition to `providers.custom` in `settings.jsonc`. `/quota_status` (or the `quota_status` tool) checks it with the same validator the plugin uses.

Rules:

- `providers.custom` keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- `modelIds` affects only `words.onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- Remote APIs use a fixed authenticated `GET`. Formats: `quota-v1`, `json-v1`, and `openrouter-key-v1`. `json-v1` needs an `adapter` with 1–16 mappings; paths are literal own-property segment arrays, not JSONPath. See [response rules](providers.md#custom-providers).
- Local estimates support 1–16 UTC-day or rolling request windows. Counters live under `~/.local/state/opencode/opencode-quota/quota-providers/`.
- Automatic models.dev matching runs first. Add `pricingModelMap` only when it cannot find one clear model. `pricingModelMap` cannot override a successful automatic match.
- If any request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.
- Credentials resolve from `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then API-key logins saved in OpenCode 2 (`opencode.db`).
- `"enabled": false` switches a definition off: it is never fetched, its key is never sent, and `/quota_status` shows it as off. Without `enabled` (or with `true`) it is on. Providers an agent adds start switched off; switch one on by setting `"enabled": true` in `opencode-quota/settings.jsonc`, or in `/quota_settings` → **Providers**.
- Definitions run automatically with `providers.enabled: "auto"`. A list must include `custom` and every built-in provider you still want.
- To tune maintained estimates, use the reserved `alibaba-coding-plan` ID and its window shape. Do not add a duplicate normal provider block.
- Not accepted: project secrets, scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, and automatic endpoint discovery.
- A custom model provider still needs its normal OpenCode `provider` block in `opencode.json`: that block tells OpenCode how to use the model, and `providers.custom` tells OpenCode Quota how to measure it.
- `/quota_status` shows the exact state path and safe credential source, never URLs, keys, headers, response bodies, counter contents, or raw errors.

<details>
<summary><strong>Complete example</strong></summary>

`settings.jsonc`:

```jsonc
{
  "providers": {
    "enabled": "auto",
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

Provider credentials (API keys, cookies, tokens) are never set here. See [API keys](providers.md#api-keys) and each provider's [setup notes](providers.md#provider-setup-notes).

<details>
<summary><strong>All settings</strong></summary>

### Providers

| Setting                                  | Default    | Meaning |
| ---------------------------------------- | ---------- | ------- |
| `providers.enabled`                      | `"auto"`   | `"auto"` finds every provider you have set up; a list uses only those. `custom` means the custom providers. |
| `providers.custom`                       | `[]`       | Custom provider definitions. See [Custom providers](#custom-providers). |
| `providers.anthropic.binaryPath`         | `"claude"` | Claude CLI command or path. With `"claude"`, OpenCode's `PATH` is tried first, then the usual install folders (not on Windows). |
| `providers.cursor.plan`                  | `"none"`   | Cursor included API budget: `none`, `pro`, `pro-plus`, or `ultra`. |
| `providers.cursor.includedApiUsd`        | `null`     | Override Cursor's monthly included API budget in USD. |
| `providers.cursor.billingCycleStartDay`  | `null`     | Billing day `1`–`28`. `null` uses the local calendar month. |
| `providers.opencode.monthlyLimitUsd`     | `null`     | Override the OpenCode Zen monthly budget in USD. |

### Checking

| Setting                      | Default  | Meaning |
| ---------------------------- | -------- | ------- |
| `checking.minIntervalMs`     | `300000` | Minimum time between checks of a provider. |
| `checking.requestTimeoutMs`  | `5000`   | Provider request timeout in milliseconds. |
| `checking.waitForQuotaReset` | `true`   | When a request hits a provider limit, the plugin asks that model's provider for fresh quota; if a window shows 0% left, OpenCode retries 1 minute after the earliest such window resets (at most 5 hours per wait) instead of retrying quickly or giving up. Interrupt the session to stop waiting (Esc twice in the TUI). `false` keeps OpenCode's normal retry timing. |

### Words

| Setting                  | Default     | Meaning |
| ------------------------ | ----------- | ------- |
| `words.percent`          | `"left"`    | `left` (`58% left`), `remaining` (`58% remaining`), `bare` (`58%`), or `used` (`42% used`). |
| `words.reset`            | `"exact"`   | Reset countdowns: `exact` (`2h 14m`), `compact` (`2h14m`), `short` (`2h`), or `decimal` (`2.2h`). Partial minutes round up. |
| `words.resetDecimals`    | `1`         | `0`–`4` decimals for `decimal`. |
| `words.detail`           | `"summary"` | `detailed` also shows supplementary accounting rows. |
| `words.runsOut`          | `false`     | `true` adds the pace of a limit used faster than it refills (`runs out in 2h`) to the short `/quota` text: Web, Desktop, and the toast. |
| `words.onlyCurrentModel` | `false`     | Show only the providers that serve the session's current model, when they can be found. Of the custom providers, only those whose `providerId` and `modelIds` serve it. |
| `words.sessionTokens`    | `"current"` | `tree` adds every subagent session to the session tokens, counted once. It does not change `/tokens_session` or `/tokens_session_all`. |

### Pricing, notices, export and telemetry

| Setting                         | Default   | Meaning |
| ------------------------------- | --------- | ------- |
| `pricing.source`                | `"auto"`  | Token pricing for `/tokens_*` and the local estimates (Cursor, custom local providers): `auto`, `bundled`, or `runtime`. |
| `pricing.autoRefreshDays`       | `7`       | Refresh local pricing after this many days. |
| `announcements.enabled`         | `true`    | Show bundled maintainer notices. |
| `announcements.home`            | `true`    | Show the count of active notices at the bottom of Home. |
| `announcements.homeFrequency`   | `"daily"` | `"daily"`: show that Home line on the first Home screen of each day, for 10 minutes. `"always"`: show it on every Home screen. The Notices tab of the quota window (`/quota_status`, then Notices) lists every notice. |
| `export.enabled`                | `false`   | Write a JSON file each time the quota snapshot changes. |
| `export.path`                   | `""`      | Empty uses `$XDG_CACHE_HOME/opencode/quota-export.json`. Otherwise an absolute or `~/` path. |
| `telemetry.enabled`             | `false`   | Publish quota and cache-age gauges through OpenCode's global OpenTelemetry `MeterProvider`. No extra provider calls. |

See [External integration](external-integration.md) for export and telemetry details.

</details>
