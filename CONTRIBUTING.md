# Contributing to opencode-quota

Thanks for contributing! Please read this before you open an issue or PR.

## Issues first

- Open an issue before a feature, fix, refactor, or behavior change. Opening the issue and PR together is fine.
- Link it in the PR with `Fixes #<issue>` or `Refs #<issue>`. No issue? Explain the reason and scope in the PR.
- Use an issue form (bug, feature, or provider request). Write a short, specific title; the form adds the label, so skip `[bug]`-style prefixes.
- Very short or mostly empty issues get the `needs info` label. Adding the details removes it. `needs info` issues close after 21 days without activity; nothing else auto-closes.

## Setup

Node.js `^22.13.0 || >=23.4.0` and pnpm 11:

```sh
corepack enable
corepack prepare pnpm@11.0.0 --activate
pnpm install
```

`pnpm install` also installs the Git hooks: pre-commit formats staged files with Biome; pre-push runs `pnpm verify`.

## Checks

Run `pnpm verify` before opening a PR. It runs lint and formatting, typecheck, build, all tests, the cross-surface test, and package checks. CI runs the same command, then installs the packed package on Node 22 and 24 as a smoke test.

For quick iteration: `pnpm run test:watch`.

## Rules the code must keep

- **No AI calls.** Never send a request to an AI model to produce anything the plugin shows (quota rows, toasts, command output); it would spend the user's tokens. Calling a provider's quota or billing API is fine.
- **OpenCode 2 only.** No OpenCode 1 code, APIs, or tables.
- **Server vs. TUI.** The server plugin (`src/plugin.ts`) computes all text and registers the `quota_status` tool, the slash commands, and the `slkiser.opencode-quota` RPC. The TUI plugin (`src/tui-v2.tsx`) only draws what the RPC returns and never imports provider or credential code. Web and Desktop get slash commands only; OpenCode 2 has no plugin UI hooks there.
- **One command path.** Every slash command, the `quota_status` tool, and the RPC `command` method go through `buildQuotaDialogCommandOutput()`.
- **Credentials.** Read OpenCode logins only through `ctx.integration` in `src/lib/opencode-auth.ts`. The only exception is the terminal command (`src/lib/cli-show.ts`), which uses `src/lib/opencode-auth-sqlite.ts`; the plugins must never reach that file.
- **Money.** Show amounts with the provider's ISO code through the shared formatter (e.g. `USD 12.50`). No symbols, conversions, or adding up different currencies.
- Keep these boundary tests passing and up to date: `tests/plugin.command-handled-boundary.test.ts`, `tests/tui-dist-import-graph.test.ts`, `tests/plugin.question-hook.test.ts`, `tests/quota-provider-boundary.test.ts`.

## Provider changes

**Built-in providers** are considered only when:

- the provider is on [models.dev](https://models.dev/),
- at least two independent users asked for it (your own request, repeat comments, and requests from the provider's own company don't count),
- it has a documented API (no login cookies or website scraping), and
- the PR links that evidence and explains why a custom provider isn't enough.

Even then, it needs a reasonable maintenance cost.

**Pick the right path:**

| You want to… | Use |
| --- | --- |
| Use an OpenAI-compatible model service OpenCode doesn't include | an OpenCode custom provider |
| Track quota for a provider OpenCode already exposes (request estimates or one fixed quota endpoint) | an OpenCode Quota custom provider (`provider add`); its `providerId` must match OpenCode's |
| Anything the custom path can't do, and the policy above is met | a built-in provider |

**Building one:** for API-key or token providers, start from `contributing/provider-template/` (see its README), replace every example name, and add tests for every auth source. Use the README setup label that matches reality: `Automatic` or `Needs setup`.

**Every row** carries `AccountingMetadata`. Pick `resultType` by what the number means (`quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, `status`), not by what's easiest to draw, and name the real source in `authority`. `user_configured` is only for a basis fact such as a user-set limit, never a row.

Rich providers (more than a percentage) also:

- send numbers as typed `quantity` rows or percentage `basis` facts, and booleans as `boolean` rows; never pre-formatted money strings;
- set `semantic` with an explicit `primary` or `supplementary` prominence;
- keep `used`, `limit`, and `remaining` literal;
- keep labels short: the concept only, no values, units, or reset text;
- format through the shared accounting formatter.

A simple percentage-only provider may keep the plain percent row, with accurate `AccountingMetadata`.

## Fixes

Make the smallest safe fix for the root cause. Match current OpenCode behavior instead of adding extra hook layers. Test against the current released OpenCode version and name it in the PR.

## Before-and-after screenshots (required)

Every PR that changes what users see must include before-and-after screenshots taken with the same config, model, theme, and window size, with credentials, account identifiers, and private paths hidden. For quota changes, report each surface: Web, TUI sidebar, toast, and the status line under the message input (plus the command dialog if relevant). Say which ones you didn't test. Tests don't replace screenshots, and screenshots don't replace tests. No visible change? Write `Not applicable` and why.

## PR checklist

- [ ] Linked issue, or a short reason there is none
- [ ] `pnpm verify` passes
- [ ] Tested on the current released OpenCode; version noted
- [ ] Before-and-after screenshots and surface results, or `Not applicable`
- [ ] Docs updated if commands, config, or workflow changed (usually `README.md`)
- [ ] New built-in provider: models.dev link, two independent requests, why custom isn't enough
- [ ] New API-key/token provider: started from the provider template, or explained why not
