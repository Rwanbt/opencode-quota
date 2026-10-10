import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext } from "../src/lib/entries.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { hasXaiOAuthCached, queryXaiQuota } from "../src/lib/xai.js";
import { xaiProvider } from "../src/providers/xai.js";
import { expectNotAttempted } from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/xai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/xai.js")>()),
  hasXaiOAuthCached: vi.fn(),
  queryXaiQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));

const actualXai = await vi.importActual<typeof import("../src/lib/xai.js")>("../src/lib/xai.js");

const FIXED_WINDOW = {
  kind: "fixed_window",
  startedAtIso: "2026-07-13T02:24:00.983Z",
  observedAtIso: "2026-07-15T00:00:00.000Z",
  endsAtIso: "2026-07-20T02:24:00.983Z",
  fullReset: true,
} as const;
const WEEKLY = {
  percentRemaining: 95,
  resetTimeIso: "2026-07-20T02:24:00.983Z",
  fixedWindow: FIXED_WINDOW,
  kind: "weekly",
} as const;
function context(config: Record<string, unknown> = {}): QuotaProviderContext {
  return { config } as unknown as QuotaProviderContext;
}

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

describe("xai provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCredentialRows).mockResolvedValue([]);
  });

  it.each([
    "xAI SuperGrok",
    "xAI Lite",
    "xAI Heavy",
  ] as const)("maps exactly one shared weekly %s row from the active login", async (label) => {
    vi.mocked(queryXaiQuota).mockResolvedValueOnce({ success: true, label, window: WEEKLY });

    const output = await xaiProvider.fetch(context({ requestTimeoutMs: 12_000 }));

    expect(queryXaiQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12_000 });
    expect(output).toEqual({
      attempted: true,
      entries: [
        {
          accounting: ACCOUNTING,
          name: `${label} Weekly`,
          group: label,
          label: "Weekly:",
          percentRemaining: 95,
          resetTimeIso: "2026-07-20T02:24:00.983Z",
          fixedWindow: FIXED_WINDOW,
        },
      ],
      errors: [],
      presentation: { singleWindowDisplayName: label },
    });
  });

  it("is not attempted without OAuth and labels a failed query xAI", async () => {
    vi.mocked(queryXaiQuota)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ success: false, error: "Token expired" });

    expectNotAttempted(await xaiProvider.fetch(context()));
    await expect(xaiProvider.fetch(context())).resolves.toEqual({
      attempted: true,
      entries: [],
      errors: [{ label: "xAI", message: "Token expired" }],
    });
  });

  it("shows one row per OAuth login, and a login OpenCode could not return as its own error row", async () => {
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "row-1",
        integrationId: "xai",
        label: "personal",
        active: true,
        value: { type: "oauth", access: "token-1" },
      },
      {
        id: "xai-id",
        integrationId: "xai",
        label: "default",
        active: false,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 401",
      },
    ]);
    vi.mocked(queryXaiQuota).mockImplementation(async (options) =>
      options?.auth?.state === "configured"
        ? { success: true, label: "xAI SuperGrok", window: WEEKLY }
        : actualXai.queryXaiQuota(options),
    );

    const output = await xaiProvider.fetch(context());

    expect(readCredentialRows).toHaveBeenCalledWith(["xai"], { methods: ["oauth"] });
    expect(output).toEqual({
      attempted: true,
      entries: [
        {
          accounting: { ...ACCOUNTING, sourceId: "row-1" },
          name: "[xAI personal] (SuperGrok) (active) Weekly",
          group: "[xAI personal] (SuperGrok) (active)",
          label: "Weekly:",
          percentRemaining: 95,
          resetTimeIso: "2026-07-20T02:24:00.983Z",
        },
      ],
      errors: [
        {
          label: "[xAI]",
          message:
            "xAI sign-in could not be refreshed: refresh_failed: HTTP 401. Run `opencode auth login xai`.",
        },
      ],
    });
  });

  it.each([
    ["grok-4", "xai", true],
    ["grok-code-fast-1", "github-copilot", false],
    ["grok-4", "grok", false],
    ["xai/grok-4", undefined, true],
    ["grok/grok-4", undefined, false],
    ["openai/grok-4", undefined, false],
  ])("matches %s with current provider %s -> %s", (model, currentProviderID, expected) => {
    expect(
      xaiProvider.matchesCurrentModel?.(model, { enabledProviders: "auto", currentProviderID }),
    ).toBe(expected);
  });

  it.each([
    ["the xai runtime provider exists", { providerIds: ["xai"] }, false, 0],
    ["runtime provider lookup is empty", { providerIds: [] }, true, 5_000],
    ["runtime provider lookup fails", { providersError: new Error("unavailable") }, true, 5_000],
  ])("requires the OAuth login when %s", async (_name, availability, hasOAuth, maxAgeMs) => {
    vi.mocked(hasXaiOAuthCached).mockResolvedValueOnce(hasOAuth);

    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext(availability)),
    ).resolves.toBe(hasOAuth);
    expect(hasXaiOAuthCached).toHaveBeenCalledWith({ maxAgeMs });
  });
});
