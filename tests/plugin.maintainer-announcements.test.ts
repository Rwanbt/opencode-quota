import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createPluginRuntimePathsMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge } from "./helpers/quota-rpc-bridge.js";

// A fresh folder per run, so test runs in sibling checkouts never share it.
const TEST_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "opencode-quota-plugin-announcements-"));
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const ANNOUNCEMENT_HOME_MESSAGE = "Notice: 1 unread maintainer notice, see /quota → Notices.";

const TEST_ANNOUNCEMENT = vi.hoisted(() => ({
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
  providerIds: ["copilot"],
}));

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
}));

const announcementMocks = vi.hoisted(() => ({
  getMaintainerAnnouncementsSummary: vi.fn(),
}));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);
// Records the getters of the TUI's Solid signals, so a test can read what a view shows.
const signals = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("solid-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("solid-js")>();
  return {
    ...actual,
    createSignal: ((...args: Parameters<typeof actual.createSignal>) => {
      const signal = actual.createSignal(...args);
      signals.push(signal[0]);
      return signal;
    }) as typeof actual.createSignal,
  };
});
vi.mock("../src/lib/maintainer-announcements.js", () => ({
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [TEST_ANNOUNCEMENT],
  getMaintainerAnnouncementsSummary: announcementMocks.getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds: () => ["copilot"],
}));

function makeAnnouncementSummary(overrides: Record<string, unknown> = {}) {
  return {
    source: "bundled_only",
    network: false,
    bundledCount: 1,
    activeCount: 1,
    futureCount: 0,
    expiredCount: 0,
    activeAnnouncements: [
      {
        announcement: TEST_ANNOUNCEMENT,
        active: true,
        reasons: [],
      },
    ],
    evaluations: [],
    ...overrides,
  };
}

/** Copilot with quota; the announcements as `announcements` sets them. */
function configureQuestionQuotaToast(
  announcements: Record<string, unknown> = { enabled: true, home: true },
): void {
  writePluginTestSettings(TEST_RUNTIME_ROOT, {
    providers: { enabled: ["copilot"] },
    checking: { minIntervalMs: 1 },
    announcements,
  });
  mocks.getProviders.mockReturnValue([
    {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 81 }],
        errors: [],
      }),
    },
  ]);
}

/** Starts the server plugin and the TUI plugin, joined by the quota RPC. */
async function startCli() {
  vi.stubGlobal("React", {
    createElement: (type: unknown, props: Record<string, unknown> | null) =>
      typeof type === "function" ? type(props ?? {}) : { type, props },
  });
  const { default: server } = await import("../src/plugin.js");
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: vi.fn() } }));
  const disposeServer = await server.setup({
    location: { directory: process.cwd() },
    provider: { list: vi.fn(async () => ({ data: [{ id: "copilot" }] })) },
    session: { get: vi.fn(async () => ({})), hook: vi.fn() },
    command: { transform: vi.fn() },
    tool: { transform: vi.fn() },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  } as never);
  const [, serverHandlers] = register.mock.calls[0] as unknown as [
    unknown,
    Parameters<typeof createQuotaRpcBridge>[0],
  ];
  // Recorded, so a test can wait for the Home notice line the TUI asked for.
  const notices = vi.fn(serverHandlers.notices);
  const handlers = { ...serverHandlers, notices };
  const { default: plugin } = await import("../src/tui/index.js");
  const listeners = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const renderers = new Map<string, () => unknown>();
  const toast = vi.fn();
  const context = {
    location: { directory: process.cwd() },
    client: { rpc: createQuotaRpcBridge(handlers) },
    theme: { text: { base: "base", muted: "muted" } },
    // Display settings with the question toast turned on.
    storage: {
      store: (key: string, options: { initial: any }) => {
        const value =
          key === "settings"
            ? { ...options.initial, settings: { toast: { afterQuestion: true } } }
            : options.initial;
        return [value, async () => {}];
      },
    },
    data: {
      session: { get: vi.fn(() => undefined) },
      on: vi.fn((name: string, listener: (event: { data: Record<string, unknown> }) => void) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }),
    },
    keymap: { layer: vi.fn() },
    ui: {
      slot: vi.fn((claim: { append: string; render: () => unknown }) => {
        renderers.set(claim.append, claim.render);
        if (claim.append === "app") claim.render();
        return vi.fn();
      }),
      toast: { show: toast },
    },
  };
  const disposeTui = plugin.setup(context as never);
  const renderHome = () => renderers.get("home.footer.status")?.();
  // Stops the TUI, then the server's store with its fetches and file writes.
  const dispose = async () => {
    (disposeTui as unknown as () => void)?.();
    await (disposeServer as unknown as () => Promise<void>)?.();
  };
  return { listeners, toast, renderHome, notices, dispose };
}

async function flushMaintainerFallbackWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("maintainer announcement plugin integration", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    announcementMocks.getMaintainerAnnouncementsSummary
      .mockReset()
      .mockReturnValue(makeAnnouncementSummary());
    signals.length = 0;
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 3 });
  });

  it("shows the count-only announcement on Home instead of a toast", async () => {
    configureQuestionQuotaToast();
    const cli = await startCli();
    cli.renderHome();
    // The Home footer shows the notice line the server returns over the RPC.
    await vi.waitFor(() =>
      expect(signals.map((read) => read())).toContain(ANNOUNCEMENT_HOME_MESSAGE),
    );
    expect(announcementMocks.getMaintainerAnnouncementsSummary).toHaveBeenCalledWith(
      expect.objectContaining({ enabledProviders: ["copilot"] }),
    );

    cli.listeners.get("session.tool.input.started")?.({
      data: { id: "call-1", name: "question", sessionID: "session-question" },
    });
    cli.listeners.get("session.tool.success")?.({
      data: { id: "call-1", sessionID: "session-question" },
    });
    await vi.waitFor(() => expect(cli.toast).toHaveBeenCalledOnce());
    await flushMaintainerFallbackWork();
    expect(cli.toast).toHaveBeenCalledOnce();
    expect(cli.toast.mock.calls[0]?.[0].message).toContain("Copilot");
    expect(cli.toast.mock.calls[0]?.[0].message).not.toContain("Notice:");
    await cli.dispose();
  });

  it("does not show the Home announcement when announcements.home is off", async () => {
    configureQuestionQuotaToast({ enabled: true, home: false });
    const cli = await startCli();
    cli.renderHome();
    // The notices call reads the settings, then stops.
    await vi.waitFor(() => expect(cli.notices).toHaveBeenCalled());
    await expect(cli.notices.mock.results[0]?.value).resolves.toEqual({ homeLine: "" });
    await flushMaintainerFallbackWork();

    expect(announcementMocks.getMaintainerAnnouncementsSummary).not.toHaveBeenCalled();
    await cli.dispose();
  });
});
