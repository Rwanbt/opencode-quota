import { afterEach, vi } from "vitest";

// Git hooks (for example the pre-push `pnpm verify`) export GIT_DIR, GIT_INDEX_FILE and similar
// variables. A git command run by a test would inherit them and write to the real repository
// instead of its temp folder, so no test process keeps any of them.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
process.env.GIT_CONFIG_NOSYSTEM = "1";

afterEach(async () => {
  try {
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    pricing.__resetPricingSnapshotForTests();
  } catch {
    // best effort; tests that don't load pricing module should still clean up
  }

  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
