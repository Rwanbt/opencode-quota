import { beforeEach, describe, expect, it, vi } from "vitest";
import { exampleProviderProvider } from "../src/providers/example-provider.js";
import { fetchRows, rowSummary, useProviderWorld } from "./helpers/provider-fetch.js";

const query = vi.hoisted(() => vi.fn());
const metadata = vi.hoisted(() => ({ available: false }));

vi.mock("../src/lib/example-provider.js", () => ({ queryExampleProviderQuota: query }));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: async () => metadata.available,
}));

const RESET = "2026-01-02T00:00:00.000Z";

describe("example provider", () => {
  // Temp OpenCode folders and no provider keys in the environment, never this machine's own.
  useProviderWorld();

  beforeEach(() => {
    metadata.available = false;
  });

  it("is not set up when it has no key", async () => {
    query.mockResolvedValueOnce(null);

    const fetched = await fetchRows(exampleProviderProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toEqual({ code: "not_configured" });
  });

  it("shows the daily quota left", async () => {
    query.mockResolvedValueOnce({ success: true, percentRemaining: 75, resetTimeIso: RESET });

    const fetched = await fetchRows(exampleProviderProvider);

    expect(rowSummary(fetched.rows)).toEqual([
      ["example-provider.daily", null, "Daily", "day", 75, RESET],
    ]);
    expect(fetched.error).toBeUndefined();
  });

  it("shows a failed check as the provider's error and keeps the message for /quota_status", async () => {
    query.mockResolvedValueOnce({ success: false, error: "HTTP 401 Unauthorized" });

    const fetched = await fetchRows(exampleProviderProvider);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Example Provider: HTTP 401 Unauthorized",
    });
  });

  it("is available when OpenCode lists the provider", async () => {
    metadata.available = true;

    await expect(exampleProviderProvider.isAvailable({} as never)).resolves.toBe(true);
  });

  it("is available with only a key in the environment", async () => {
    await expect(exampleProviderProvider.isAvailable({} as never)).resolves.toBe(false);

    process.env.EXAMPLE_PROVIDER_API_KEY = "test-key";

    await expect(exampleProviderProvider.isAvailable({} as never)).resolves.toBe(true);
  });
});
