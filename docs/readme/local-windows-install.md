# Personal Windows installation (OpenCode 2.x) — without an upstream release

This is an **experimental, locally installed server plugin** from the fork.
It has been loaded by stock OpenCode **2.0.29** on Windows and is independent
of the Git working tree after installation. The UI integration under the
existing **“Toggle session context”** hover is a **separate Desktop host patch**
in Draft PR #4; do not claim that installing this package alone enables it.

## Build and install a stable local copy

Prerequisites: Node.js 24, pnpm 11, OpenCode 2.0.16+, Git. Build from the
exact reviewed P1 commit or its branch:

```powershell
git clone --branch feat/p1-gui-background-refresh https://github.com/Rwanbt/opencode-quota.git
cd opencode-quota
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
New-Item -ItemType Directory -Force local-release | Out-Null
pnpm pack --pack-destination local-release

$destination = Join-Path $env:LOCALAPPDATA 'OpenCode\custom-plugins\opencode-quota-v5'
$tarball = (Get-ChildItem .\local-release\*.tgz | Select-Object -First 1).FullName
npm install --prefix $destination --omit=dev --ignore-scripts --no-audit --no-fund $tarball '@opencode/plugin@2.0.16'
```

In `%USERPROFILE%\.config\opencode\opencode.jsonc`, **back up the file**,
then **append** this local plugin *directory* to the existing `plugins`
array, preserving all other entries:

```text
<YOUR_LOCALAPPDATA>/OpenCode/custom-plugins/opencode-quota-v5/node_modules/@slkiser/opencode-quota/dist
```

In JSONC, replace `<YOUR_LOCALAPPDATA>` with the full Windows absolute path,
using forward slashes. Point at `dist`, **not** the tarball, `dist/index.js`,
or the source repository root. Do not install both upstream and fork in the
same OpenCode instance: they register the same plugin/RPC IDs.

Create `%USERPROFILE%\.config\opencode\opencode-quota\quota-toast.jsonc`
with the minimal opt-in:

```jsonc
{
  "guiBackgroundRefresh": { "enabled": true },
  "minIntervalMs": 300000,
  "enabledProviders": "auto"
}
```

If you already have quota settings, merge **only**
`guiBackgroundRefresh.enabled: true` into the existing file. Your explicitly
selected providers and other settings should remain unchanged.

Restart OpenCode when convenient. `opencode plugin list` should show
`@slkiser/opencode-quota.server` with a **local** source, and `/quota`
should continue working through OpenCode's command surface. The background
worker populates the cache without a model request or hover-triggered fetch.
If credentials/providers are unavailable, the snapshot shows unavailable.

## Safety, versioning and rollback

- Review the exact commit and run the CI before installation. Do not blindly
  run installers from an untrusted fork or use a floating `latest` tag.
- The new background network behavior is **opt-in** and runs at intervals of
  at least five minutes, backing off to at least fifteen minutes on error.
- On Windows, account-bound cached quota data is process-memory-only. A new
  process must warm the cache again. Credential switches select a distinct
  ephemeral identity, not an on-disk credential-derived key.
- To disable background network activity, change `guiBackgroundRefresh.enabled`
  to `false` and restart OpenCode. To completely uninstall, remove **only this
  plugin directory entry** from `plugins`, restart OpenCode, and then remove
  the private `opencode-quota-v5` installation directory. Keep the backup until
  verified. Do not delete other plugin entries or their files.
- The native Desktop popover still depends on a compatible and separately
  tested host-side adapter; this is **not** yet a production GUI plugin and
  installing P1 alone does not modify OpenCode's Electron renderer.

The source install can be reproduced without waiting for acceptance of any
pull request to `anomalyco/opencode`. The future native UI integration is
tracked by the fork's Issues #2, #3 and #6 and Draft PR #4.
