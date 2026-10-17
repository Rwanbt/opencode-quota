# OpenCode v2 Desktop/Web quota hover — isolated prototype

This directory carries a reproducible **host-side prototype patch** for
OpenCode's built-in context indicator. It is kept in this fork so neither
`anomalyco/opencode` nor `Rwanbt/unifia` is changed prematurely.

## Exact source revisions

- Host: `anomalyco/opencode` `dev` at
  `a49f179170b620f719fc6c25986e971af47b5268` (October 17, 2026).
- Host prototype commit: `b0ac10b6ab9a04bb4593c426723e9254eb49908d`.
- Plugin: `Rwanbt/opencode-quota` PR #1, with `slkiser.opencode-quota`
  RPC method `snapshot({})` (cache only).

To reproduce in **a dedicated clean OpenCode clone**, check out the exact host
base SHA, then apply the patch using Git:

```shell
git checkout a49f179170b620f719fc6c25986e971af47b5268
git am /path/to/opencode-quota/integration/patches/0001-feat-context-prototype-quota-hover-from-cached-plugi.patch
bun install --frozen-lockfile --ignore-scripts
bun --cwd packages/gui-extensions test src/context/quota-snapshot.test.ts
bun --cwd packages/gui-extensions run typecheck
```

The patch extends the **existing** context button, preserving its click
behavior and session-context ring, while adding a popup on pointer hover or
keyboard focus with context usage and subscription percentages, reset
countdowns, source authority, cache age and partial/stale states. No provider
fetch or model request is made on hover; the client calls the plugin's
cache-only RPC. A successful response is strictly parsed and capped before
rendering. Session and connection-generation changes reject stale responses.

## Validation performed on Windows

- GUI package TypeScript typecheck: **pass** (`tsgo -b`).
- `quota-snapshot.test.ts`: **5/5 pass** (input validation, provenance,
  hostile data, reset math and single authorized cache RPC call).
- Host Git diff and patch generation: **pass**.
- `oxlint`: **not certified**, local Windows worker hit OXC allocator
  out-of-memory; do not claim lint green.
- Full Desktop renderer E2E, hover/focus interaction and pixel review:
  **not yet executed**. Bun's standalone JSX test runner does not compile the
  SolidJS DOM component in browser mode; needs a Vite/bundled component test
  or Playwright harness. Do not claim visual production certification.

## Limitations and next requirements

- This is a **host patch**, not an independently installable npm GUI plugin.
  GUI extension contributions are still built into OpenCode v2.
- The plugin's `snapshot` method reads only cache. Desktop sessions that have
  never warmed that cache will show an explicit unavailable state. A separate,
  bounded and privacy-respecting background cache-warming mechanism is needed
  before this is useful on a fresh Desktop installation. It must never call
  providers at every hover.
- Provider display labels are intentionally limited to canonical IDs for now.
- The final upstream contribution should expose a generic trusted view
  contract, not bake this fork's RPC ID into upstream forever.
- Preserve the original CLI/TUI behavior, all privacy boundaries and the
  existing context button's click/keyboard/touch behavior.

See the tracking issues in `Rwanbt/opencode-quota`: #2 (UI) and #3 (host
extension contract). Neither patch nor plugin PR is merged or published.
