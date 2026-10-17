# Native GUI integration: quota snapshot contract (experimental)

This fork's first GUI increment adds a **read-only** `snapshot` method to
`slkiser.opencode-quota`'s existing OpenCode v2 server RPC. This is a data
contract only; it does **not** inject a widget into OpenCode Desktop/Web yet.

## Current contract

- Request: `QuotaRpc.methods.snapshot` with `{}` (no refresh options).
- Response: `GuiQuotaSnapshot` (`version: 1`), with `generatedAt`,
  `cacheAgeSeconds`, and canonical provider IDs keyed in `providers`.
- Provider rows have `status` (`ok`, `partial`, `error`, `unavailable`),
  optional `fetchedAt` and `windows`.
- A window includes `percentRemaining` (0–100), a recognized `window` when
  known, optional Unix-second `resetAt`/`observedAt`, `resultType` and
  `authority` (`provider_reported` or `locally_derived`).

The method reads the **existing provider cache** using the same identity-bound
cache lookup as the JSON export. It never calls the provider's `fetch` method
and never calls a model. Missing cache data yields `unavailable`, not invented
percentages. The UI must show cache age and avoid treating cached data as live.

Only allowlisted numeric quota fields pass to the GUI. Account identifiers,
source IDs, raw details, provider error strings and arbitrary text/monetary
values are deliberately excluded. Some providers offer only value-based limits,
so their GUI `windows` may be empty in this first contract; keep CLI/TUI reports
as the fallback and do not render an artificial bar.

## Desktop/Web adapter — not implemented yet

The OpenCode v2 desktop app uses Electron and its internal SolidJS GUI
extensions at `packages/gui-extensions`. The existing context trigger and
tooltip are in `src/context/indicator.tsx`, registered in the `session.header`
slot by `src/context/renderer.tsx`. The GUI extension registry is currently a
built-in composition, **not** a generic npm-plugin GUI extension loader.

Proposed independent OpenCode increment:

1. Introduce an opt-in, typed, read-only quota-view contribution point usable
   by external plugins, or a host-owned quota widget with a strict adapter.
2. Keep the current context circle and click action; extend its hover/focus
   popup with context percentage and provider quota bars, sources and reset
   countdowns. Use a normal click/focus accessible fallback for touch devices.
3. Maintain a visible missing/stale/partial state, update relative countdowns
   client-side, and **never refresh quota providers on hover**.
4. Prove isolation, teardown, XSS-resistant text handling, latency and
   consistency in both Desktop and Web component tests before upstream PRs.

The upstream UI extension discussion is
[anomalyco/opencode#43132](https://github.com/anomalyco/opencode/issues/43132).
Do not rely on DOM injection, Tauri hooks or external CSS overrides.
