/**
 * The v6 surfaces end to end: the real server plugin (`src/plugin.ts`) and the real TUI plugin
 * (`src/tui/index.tsx`) on fake OpenCode hosts, joined by a JSON RPC bridge. Three providers:
 * Copilot with only its plan, MiniMax over its quota, and a custom json-v1 source next to a
 * failing one. API keys and a private error body are canaries no surface may show.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  createAlibabaAuthModuleMock,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge, createQuotaRpcEvents } from "./helpers/quota-rpc-bridge.js";

const CANARIES = {
  teamKey: "v6-team-key-secret-canary",
  failingKey: "v6-failing-key-secret-canary",
  failureBody: "v6-private-http-body-canary",
};

const mocks = vi.hoisted(() => ({
  root: "",
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
}));

vi.mock("@opentui/solid", () => ({
  useTerminalDimensions: () => () => ({ width: 120, height: 40 }),
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  ...createPricingModuleMock(mocks),
}));
vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${mocks.root}/data`,
    configDir: `${mocks.root}/config`,
    cacheDir: `${mocks.root}/cache`,
    stateDir: `${mocks.root}/state`,
  }),
}));

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
// Resets in 2h 14m (the 30 s margin keeps the minute while the test runs).
const RESET = new Date(Date.now() + 134 * 60_000 - 30_000).toISOString();

const CUSTOM_SOURCES = [
  {
    id: "team-accounting",
    providerId: "team-gateway",
    label: "Team",
    url: "https://team-gateway.example/accounting",
    mode: "remote-api",
    format: "json-v1",
    apiKeyEnv: "V6_TEAM_KEY",
    adapter: {
      mappings: [
        {
          resultType: "quota",
          name: "Monthly",
          label: "Monthly:",
          resetTime: { path: ["quota", "resetAt"], encoding: "iso-8601" },
          metric: {
            type: "remaining-limit",
            remaining: { path: ["quota", "remaining"] },
            limit: { path: ["quota", "limit"] },
          },
        },
      ],
    },
  },
  {
    id: "failing-accounting",
    providerId: "failing-gateway",
    label: "Failing",
    url: "https://failing-gateway.example/accounting",
    mode: "remote-api",
    format: "quota-v1",
    apiKeyEnv: "V6_FAILING_KEY",
  },
];

/** Copilot without a billing token shows only its plan; MiniMax is past its 5h quota. */
function fakeProvider(id: string, entries: Array<Record<string, unknown>>) {
  return {
    id,
    isAvailable: async () => true,
    fetch: async () => ({
      attempted: true,
      entries: entries.map((entry) => ({ accounting: ACCOUNTING, ...entry })),
      errors: [],
    }),
  };
}

function httpFetch(url: string, init?: RequestInit): Response {
  const authorization = new Headers(init?.headers).get("authorization");
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (url === CUSTOM_SOURCES[0]?.url) {
    expect(authorization).toBe(`Bearer ${CANARIES.teamKey}`);
    return json({ quota: { remaining: 64, limit: 100, resetAt: RESET } });
  }
  if (url === CUSTOM_SOURCES[1]?.url) {
    expect(authorization).toBe(`Bearer ${CANARIES.failingKey}`);
    return new Response(CANARIES.failureBody, { status: 503 });
  }
  throw new Error(`unexpected URL: ${url}`);
}

type Node = { type: unknown; props: Record<string, any> };
type Listener = (event: { data: Record<string, unknown> }) => void;

/** Every `text` node of a JSX tree as one line, its spans joined. */
function textLines(node: unknown): string[] {
  const strings = (child: unknown): string =>
    Array.isArray(child)
      ? child.map(strings).join("")
      : typeof child === "string" || typeof child === "number"
        ? String(child)
        : child && typeof child === "object"
          ? strings((child as Node).props?.children)
          : "";
  if (Array.isArray(node)) return node.flatMap(textLines);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  if (element.type === "text") return [strings(element.props.children)];
  return textLines(element.props?.children);
}

function findAll(node: unknown, match: (node: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [...(match(element) ? [element] : []), ...findAll(element.props?.children, match)];
}

function expectNoCanary(...outputs: unknown[]): void {
  const text = JSON.stringify(outputs);
  for (const canary of Object.values(CANARIES)) expect(text).not.toContain(canary);
}

const THEME = {
  text: {
    base: "text",
    muted: "muted",
    feedback: {
      success: { base: "green" },
      warning: { base: "yellow" },
      error: { base: "red" },
      info: { base: "blue" },
    },
  },
  hue: { accent: { 500: "accent" } },
  surface: () => ({
    text: { base: "text", muted: "muted", action: { primary: { focused: "action" } } },
    background: { action: { primary: { focused: "action-bg" } } },
  }),
};

async function startHosts() {
  const { default: serverPlugin } = await import("../src/plugin.js");
  const events = createQuotaRpcEvents();
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: events.emit } }));
  const disposeServer = await serverPlugin.setup({
    location: { directory: process.cwd() },
    provider: {
      list: async () => ({ data: ["team-gateway", "failing-gateway"].map((id) => ({ id })) }),
    },
    session: {
      get: async () => ({ model: { id: "model-one", providerID: "github-copilot" } }),
      hook: vi.fn(),
    },
    command: { transform: vi.fn() },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: { transform: vi.fn() },
  } as never);
  const [, handlers] = register.mock.calls[0] as unknown as [
    unknown,
    Parameters<typeof createQuotaRpcBridge>[0],
  ];

  // OpenCode's plugin storage: one live object per key. A toast after every reply.
  const stored = new Map<string, any>();
  const storage = {
    store: (key: string, options: { initial: any }) => {
      if (!stored.has(key)) stored.set(key, structuredClone(options.initial));
      const value = stored.get(key);
      return [value, async (mutation: (draft: any) => void) => mutation(value)];
    },
  };
  storage.store("settings", {
    initial: {
      version: 1,
      settings: { toast: { afterReply: "always" }, statusLine: { detail: "one" } },
    },
  });

  const listeners = new Map<string, Listener>();
  const renderers = new Map<string, (props?: { sessionID?: string }) => unknown>();
  let commands: Array<{ id: string; run: () => Promise<void> }> = [];
  const dialogs: string[][] = [];
  const toast = vi.fn();
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const all = { ...props, children: children.length > 1 ? children : children[0] };
      return typeof type === "function" ? type(all) : { type, props: all };
    },
  });
  const { default: tuiPlugin } = await import("../src/tui/index.tsx");
  const disposeTui = tuiPlugin.setup({
    location: { directory: process.cwd() },
    renderer: { currentFocusedEditor: null },
    client: { rpc: createQuotaRpcBridge(handlers, events) },
    theme: THEME,
    storage,
    data: {
      on: (name: string, listener: Listener) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
      session: { get: () => ({}) },
      location: { default: () => ({ directory: process.cwd() }) },
    },
    keymap: {
      layer: (build: () => { mode?: string; commands: typeof commands }) => {
        const layer = build();
        if (layer.mode === "global") commands = layer.commands;
      },
    },
    ui: {
      slot: (claim: { append: string; render: (props?: { sessionID?: string }) => unknown }) => {
        renderers.set(claim.append, claim.render);
        if (claim.append === "app") claim.render();
        return () => {};
      },
      toast: { show: toast },
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      dialog: {
        show: (render: () => unknown, onClose?: () => void) => {
          dialogs.push(textLines(render()));
          onClose?.();
        },
        clear: vi.fn(),
        prompt: vi.fn(),
        set: vi.fn(),
      },
    },
  } as never);
  return {
    render: (slot: string, props?: { sessionID?: string }) => renderers.get(slot)?.(props),
    emit: (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data }),
    command: (id: string) => commands.find((command) => command.id === `quota.${id}`)!,
    dialogs,
    toast,
    stored,
    dispose: async () => {
      (disposeTui as () => void)();
      await (disposeServer as unknown as () => Promise<void>)?.();
    },
  };
}

type Observation = { value: number; attributes?: Record<string, unknown> };
type GaugeCallback = (result: {
  observe(value: number, attributes?: Observation["attributes"]): void;
}) => void;

/** OpenTelemetry's API with one gauge callback per name; `collect` reads a gauge. */
function fakeTelemetry() {
  const callbacks = new Map<string, GaugeCallback>();
  const api = {
    metrics: {
      getMeter: () => ({
        createObservableGauge: (name: string) => ({
          addCallback: (callback: GaugeCallback) => callbacks.set(name, callback),
          removeCallback: () => callbacks.delete(name),
        }),
      }),
    },
  };
  const collect = (name: string) => {
    const observations: Observation[] = [];
    callbacks.get(name)?.({
      observe: (value, attributes) => observations.push({ value, attributes }),
    });
    return observations;
  };
  return { api, collect };
}

describe("v6 surfaces on the quota snapshot", () => {
  const savedEnv = {
    V6_TEAM_KEY: process.env.V6_TEAM_KEY,
    V6_FAILING_KEY: process.env.V6_FAILING_KEY,
  };
  let telemetry = fakeTelemetry();

  beforeEach(async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "opencode-quota-v6-cross-surface-"));
    process.env.V6_TEAM_KEY = CANARIES.teamKey;
    process.env.V6_FAILING_KEY = CANARIES.failingKey;
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    writePluginTestSettings(mocks.root, {
      providers: { enabled: ["copilot", "minimax-coding-plan", "custom"], custom: CUSTOM_SOURCES },
      checking: { minIntervalMs: 60_000 },
      words: { sessionTokens: "current" },
      announcements: { enabled: false, home: false },
      export: { enabled: true, path: join(mocks.root, "quota-export.json") },
      telemetry: { enabled: true },
    });
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: { models: [], totalInput: 1200, totalCachedInput: 300, totalOutput: 45 },
    });
    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([
      fakeProvider("copilot", [{ name: "Copilot", group: "Copilot (pro)", percentRemaining: 81 }]),
      fakeProvider("minimax-coding-plan", [
        { name: "minimax-token-plan-5h", label: "5h:", percentRemaining: -5, resetTimeIso: RESET },
        { name: "minimax-token-plan-week", label: "Weekly:", percentRemaining: 40 },
      ]),
      quotaProvidersProvider,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => httpFetch(url, init)),
    );

    telemetry = fakeTelemetry();
    const quotaTelemetry = await import("../src/lib/quota-telemetry.js");
    quotaTelemetry.__resetQuotaTelemetryForTests();
    quotaTelemetry.__setQuotaTelemetryApiLoaderForTests(async () => telemetry.api as never);
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    await rm(mocks.root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("shows one snapshot in the sidebar, status line, toast, /quota, export and gauges", async () => {
    const tui = await startHosts();
    const sidebar = () => tui.render("sidebar.content", { sessionID: "ses_1" });
    // The first look asks the server; the providers answer in the background and the
    // `changed` event brings their rows, the last of them the custom source's.
    await vi.waitFor(
      () =>
        expect(textLines(sidebar())).toEqual(
          expect.arrayContaining([
            "Session  1.2K in · 45 out",
            " Monthly  █████░░░  64% left 2h 14m",
          ]),
        ),
      { timeout: 10_000 },
    );

    // Sidebar: every provider and its rows; an over-quota row shows 0% left.
    const expanded = sidebar();
    expect(textLines(expanded)).toEqual([
      "▼ Quota",
      "Copilot (pro)",
      " Plan     ██████░░  81% left       ",
      "MiniMax Token Plan",
      " 5h       ░░░░░░░░   0% left 2h 14m",
      " Weekly   ███░░░░░  40% left       ",
      "Quota providers (Team)  Provider er…",
      " Monthly  █████░░░  64% left 2h 14m",
      "Session  1.2K in · 45 out",
    ]);
    // Each bar and percent takes its level's theme color: plenty, getting low, almost out.
    const colors = (line: string) => {
      const text = findAll(expanded, (node) => node.type === "text").find(
        (node) => textLines(node)[0] === line,
      );
      return findAll(text, (node) => node.type === "span").map((span) => span.props.style.fg);
    };
    expect([
      colors(" Plan     ██████░░  81% left       "),
      colors(" Weekly   ███░░░░░  40% left       "),
      colors(" 5h       ░░░░░░░░   0% left 2h 14m"),
    ]).toEqual([
      ["text", "green", "muted", "green", "muted"],
      ["text", "yellow", "muted", "yellow", "muted"],
      ["text", "red", "muted", "red", "muted"],
    ]);

    // Collapsed: a click on the title collapses the panel; plugin storage remembers it.
    findAll(
      expanded,
      (node) => typeof node.props?.onMouseDown === "function",
    )[0]?.props.onMouseDown();
    expect(tui.stored.get("sidebar")).toEqual({ open: false });
    expect(textLines(sidebar())).toEqual([
      "▶ Quota (3 providers, 1 error)",
      "Copilot…  Plan ██████░░  81%        ",
      "MiniMax…  5h   ░░░░░░░░   0%  2h 14m",
      "Quota pr… 30d  █████░░░  64%  2h 14m",
    ]);

    // Status line under the message box, here "one provider, big bar".
    expect(textLines(tui.render("prompt.footer", { sessionID: "ses_1" }))).toEqual([
      "Copilot Plan ████████░░ 81% left",
    ]);

    // Toast after a reply.
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(tui.toast).toHaveBeenCalledOnce());
    expect(tui.toast.mock.calls[0]?.[0]).toMatchObject({
      variant: "info",
      title: "OpenCode Quota",
      message: [
        "Copilot (pro) Plan  81% left",
        "MiniMax Token Plan… 0% left       2h 14m",
        "MiniMax Token Plan… 40% left",
        "Quota providers (T… 64% left      2h 14m",
        "Quota providers (T… Provider error 503",
        "Session  1.2K in · 45 out",
      ].join("\n"),
    });

    // /quota builds its report on the server from the same snapshot and opens it in a dialog.
    await tui.command("quota").run();
    expect(tui.dialogs[0]).toContain(tui.toast.mock.calls[0]?.[0].message);

    // The export file and the gauges follow the snapshot without asking a provider again.
    const exportPath = join(mocks.root, "quota-export.json");
    const exported = await vi.waitFor(async () => {
      const file = JSON.parse(await readFile(exportPath, "utf8"));
      expect(file.providers["quota-providers"]?.status).toBe("partial");
      return file;
    });
    expect(
      Object.entries(exported.providers).map(([id, provider]: [string, any]) => [
        id,
        provider.status,
        provider.entries.map((entry: { name: string; percentRemaining: number }) => [
          entry.name,
          entry.percentRemaining,
        ]),
      ]),
    ).toEqual([
      ["copilot", "ok", [["Copilot (pro) Plan", 81]]],
      [
        "minimax-coding-plan",
        "ok",
        [
          ["MiniMax Token Plan 5h", -5],
          ["MiniMax Token Plan Weekly", 40],
        ],
      ],
      ["quota-providers", "partial", [["Quota providers (Team) Monthly", 64]]],
    ]);
    const gauges = telemetry.collect("opencode.quota.consumed");
    expect(
      gauges.map(({ value, attributes }) => [
        attributes?.["quota.provider"],
        attributes?.["quota.window"],
        value,
      ]),
    ).toEqual([
      ["copilot", "unknown", 0.19],
      ["custom", "month", 0.36],
      ["minimax-coding-plan", "five_hour", 1],
      ["minimax-coding-plan", "week", 0.6],
    ]);

    // No API key and no private error body reaches a surface, the RPC, a file or a gauge.
    const savedSnapshot = await vi.waitFor(() =>
      readFile(join(mocks.root, "state", "opencode-quota", "snapshot-v6.json"), "utf8"),
    );
    expectNoCanary(
      expanded,
      sidebar(),
      tui.toast.mock.calls,
      tui.dialogs,
      exported,
      gauges,
      savedSnapshot,
    );
    await tui.dispose();
  });
});
