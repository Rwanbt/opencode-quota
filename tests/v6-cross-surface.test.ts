import { QUOTA_PROVIDER_CATALOG } from "../src/lib/provider-metadata.js";

const CONFIG_PROVIDER_IDS = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) =>
  id === "quota-providers" ? "custom" : id,
);

/**
 * The v6 surfaces end to end: the real server plugin (`src/plugin.ts`) and the real TUI plugin
 * (`src/tui/index.tsx`) on fake OpenCode hosts, joined by a JSON RPC bridge. Three providers:
 * Copilot with only its plan, MiniMax over its quota, and a custom json-v1 source next to a
 * failing one. OpenCode's history (a session database) used Anthropic and GitHub Copilot.
 * API keys and a private error body are canaries no surface may show. Then the quota window's
 * Settings tabs change a surface, words and a custom
 * provider switched on to settings.jsonc.
 *
 * Agent tool to plugin: a custom provider an agent replaces is switched off, and the running
 * server stops its requests through the settings reload alone.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRow } from "../src/providers/contract.js";
import { answer, percentRow } from "./helpers/fake-answers.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import { findAll, type Node, THEME, textLines } from "./helpers/jsx-tree.js";
import {
  createAlibabaAuthModuleMock,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
  writePluginTestSettings,
} from "./helpers/plugin-test-harness.js";
import { createQuotaRpcBridge, createQuotaRpcEvents } from "./helpers/quota-rpc-bridge.js";
import { writeSessionDatabase } from "./helpers/session-database.js";

const CANARIES = {
  teamKey: "v6-team-key-secret-canary",
  failingKey: "v6-failing-key-secret-canary",
  failureBody: "v6-private-http-body-canary",
};

const mocks = vi.hoisted(() => ({
  root: "",
  terminal: { width: 120, height: 40 },
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
  useTerminalDimensions: () => () => mocks.terminal,
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
function fakeProvider(id: string, name: string, rows: ProviderRow[]) {
  return { id, isAvailable: async () => true, fetch: async () => answer({ name, rows }) };
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

type Listener = (event: { data: Record<string, unknown> }) => void;
type ServerCommand = {
  name: string;
  execute(invocation: { sessionID: string; prompt: { text: string } }): Promise<void>;
};

/** The text lines with runs of spaces as one space, so layout tweaks don't break the checks. */
function words(node: unknown): string[] {
  return textLines(node).map((line) => line.replace(/\s+/gu, " ").trim());
}

/** The labels of the active choices: the tab, Cost or Tokens, the range, Model or Day. */
function activeLabels(node: unknown): string[] {
  return findAll(node, (item) => item.type === "text" && item.props.fg === "selected").map(
    (item) => textLines(item)[0] ?? "",
  );
}

/** The ids of the Usage tab's lit lines: a control line's box, or a model row's spans. */
function litUsageLines(node: unknown): string[] {
  return findAll(node, (item) => String(item.props?.id ?? "").startsWith("quota-usage-"))
    .filter(
      (item) =>
        item.props.backgroundColor === "action-bg" ||
        findAll(item.props.children, (child) => child.props?.style?.bg === "action-bg").length > 0,
    )
    .map((item) => String(item.props.id));
}

/** The local date `days` calendar days from today, like "2026-10-01". */
function localDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/** OpenTUI inputs as the Usage tab uses them: a value, and focus with its events. */
function fakeInputs(values: string[]) {
  type FakeInput = {
    value: string;
    focused: boolean;
    on(name: string, listener: () => void): void;
    focus(): void;
    moveCursorLeft(): void;
    moveCursorRight(): void;
  };
  const listeners = new Map<FakeInput, Map<string, () => void>>();
  const inputs: FakeInput[] = values.map((value) => {
    const input: FakeInput = {
      value,
      focused: false,
      on: (name, listener) => listeners.get(input)?.set(name, listener),
      focus: () => {
        for (const other of inputs) {
          if (other === input || !other.focused) continue;
          other.focused = false;
          listeners.get(other)?.get("blurred")?.();
        }
        input.focused = true;
        listeners.get(input)?.get("focused")?.();
      },
      moveCursorLeft: () => {},
      moveCursorRight: () => {},
    };
    listeners.set(input, new Map());
    return input;
  });
  return inputs;
}

/**
 * OpenCode's history for the Usage tab: this session a minute ago with `modelID`, and an older
 * session 10 days ago with an unpriced model.
 */
function writeUsageHistory(modelID = "claude-sonnet-4-5"): void {
  const now = Date.now();
  const old = now - 10 * 24 * 60 * 60_000;
  writeSessionDatabase(join(mocks.root, "data", "opencode.db"), {
    sessions: [
      { id: "ses_1", created: now - 3_600_000 },
      { id: "ses_old", created: old },
    ],
    messages: [
      {
        id: "msg_1",
        sessionID: "ses_1",
        created: now - 60_000,
        completed: now - 59_000,
        providerID: "anthropic",
        modelID,
        tokens: { input: 1_000_000, output: 100_000 },
      },
      {
        id: "msg_old",
        sessionID: "ses_old",
        created: old,
        completed: old + 1_000,
        providerID: "acme",
        modelID: "mystery-old",
        tokens: { output: 500_000 },
      },
    ],
  });
}

function expectNoCanary(...outputs: unknown[]): void {
  const text = JSON.stringify(outputs);
  for (const canary of Object.values(CANARIES)) expect(text).not.toContain(canary);
}

type KeyLayer = {
  mode?: string;
  priority?: number;
  enabled?: () => boolean;
  target?: () => unknown;
  commands: Array<{ bind?: string; run: () => unknown }>;
};

/** A line on a node that a click uses: its text is `text`. */
function clickable(tree: unknown, text: string): Node {
  return findAll(
    tree,
    (node) =>
      typeof node.props?.onMouseUp === "function" && textLines(node).join("").trim() === text,
  )[0]!;
}

/** The lines of the window's Settings line with this setting path (or id). */
function settingLine(tree: unknown, id: string): Node[] {
  return findAll(tree, (node) => node.props?.id === `quota-settings.${id}`);
}

async function startHosts() {
  const { default: serverPlugin } = await import("../src/plugin.js");
  const events = createQuotaRpcEvents();
  const register = vi.fn(async () => ({ dispose: async () => {}, events: { emit: events.emit } }));
  // The server's slash commands, and the messages they post (Web, Desktop, the TUI chat form).
  const serverCommands: ServerCommand[] = [];
  const posted = vi.fn(async (_message: { sessionID: string; text: string }) => ({}));
  const disposeServer = await serverPlugin.setup({
    location: { directory: process.cwd() },
    provider: {
      list: async () => ({ data: ["team-gateway", "failing-gateway"].map((id) => ({ id })) }),
    },
    session: {
      get: async () => ({ model: { id: "model-one", providerID: "github-copilot" } }),
      hook: vi.fn(),
      wait: async () => {},
      prompt: posted,
    },
    command: {
      transform: async (build: (editor: { add(command: ServerCommand): void }) => void) =>
        build({ add: (command) => serverCommands.push(command) }),
    },
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
  const listeners = new Map<string, Listener>();
  const renderers = new Map<string, (props?: { sessionID?: string }) => unknown>();
  let commands: Array<{ id: string; run: () => Promise<void> }> = [];
  // Every keymap layer, newest last: the Usage tab adds its own each time it renders.
  const layers: KeyLayer[] = [];
  let focused: unknown;
  const renderer: {
    currentFocusedEditor: { plainText: string; clear(): void } | null;
    width: number;
    on(): void;
    off(): void;
  } = { currentFocusedEditor: null, width: 120, on: () => {}, off: () => {} };
  const toast = vi.fn();
  const dispatch = vi.fn();
  const dialog = { show: vi.fn(), clear: vi.fn(), prompt: vi.fn(), set: vi.fn() };
  // Like OpenCode's prompt, the TUI client runs a server slash command in a session.
  const sessionCommand = vi.fn(async (input: { sessionID: string; name: string; text: string }) =>
    serverCommands
      .find((command) => command.name === input.name)
      ?.execute({ sessionID: input.sessionID, prompt: { text: input.text } }),
  );
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => {
      const all = { ...props, children: children.length > 1 ? children : children[0] };
      if (typeof type === "function") return type(all);
      // A renderable, enough for refs: it takes the keyboard (at once when `focused`). A test
      // hands an input its own renderable through `ref`.
      const node = {
        type,
        props: all,
        focus: () => {
          focused = node;
        },
        on: () => {},
        scrollTo: () => {},
        scrollBy: () => {},
        scrollChildIntoView: () => {},
      };
      if (typeof all.ref === "function" && type !== "input") all.ref(node);
      if (all.focused === true) node.focus();
      return node;
    },
  });
  const { default: tuiPlugin } = await import("../src/tui/index.tsx");
  const disposeTui = tuiPlugin.setup({
    location: { directory: process.cwd() },
    renderer,
    client: { rpc: createQuotaRpcBridge(handlers, events), session: { command: sessionCommand } },
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
      layer: (build: () => KeyLayer) => {
        const layer = build();
        layers.push(layer);
        if (layer.mode === "global") commands = layer.commands as typeof commands;
      },
      dispatch,
    },
    ui: {
      slot: (claim: { append: string; render: (props?: { sessionID?: string }) => unknown }) => {
        renderers.set(claim.append, claim.render);
        if (claim.append === "app") claim.render();
        return () => {};
      },
      toast: { show: toast },
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      dialog,
    },
  } as never);
  return {
    render: (slot: string, props?: { sessionID?: string }) => renderers.get(slot)?.(props),
    emit: (name: string, data: Record<string, unknown>) => listeners.get(name)?.({ data }),
    command: (id: string) => commands.find((command) => command.id === `quota.${id}`)!,
    /** The last layer registered with this priority. */
    layer: (priority: number) => layers.filter((layer) => layer.priority === priority).at(-1)!,
    focused: () => focused,
    /** The open dialog, drawn again. */
    renderDialog: () => (dialog.show.mock.calls.at(-1)?.[0] as () => unknown)(),
    /** Presses a key of the open dialog (its newest modal layer). */
    pressDialog: (bind: string) =>
      layers
        .findLast((layer) => layer.mode === "modal")
        ?.commands.find((key) => key.bind === bind)
        ?.run(),
    /** Types `text` in the message box and presses enter. */
    typed: (text: string) => {
      renderer.currentFocusedEditor = {
        plainText: text,
        clear: () => {
          renderer.currentFocusedEditor = null;
        },
      };
      return layers.find((layer) => layer.priority === 1)?.commands[0]?.run();
    },
    /** Presses `bind` in the newest layer of `priority`: the Usage tab's keys are 11. */
    press: (priority: number, bind: string) =>
      layers
        .findLast((layer) => layer.priority === priority)
        ?.commands.find((command) => command.bind === bind)
        ?.run(),
    /** The server's RPC handlers, looked up on each call: a test can wrap one. */
    handlers: handlers as Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
    /** Runs a Web and Desktop slash command; `posted` gets its chat message. */
    serverCommand: (name: string, sessionID: string, text = "") =>
      serverCommands
        .find((command) => command.name === name)!
        .execute({ sessionID, prompt: { text } }),
    dialog,
    sessionCommand,
    posted,
    toast,
    dispatch,
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
    mocks.terminal = { width: 120, height: 40 };
    process.env.V6_TEAM_KEY = CANARIES.teamKey;
    process.env.V6_FAILING_KEY = CANARIES.failingKey;
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    writePluginTestSettings(mocks.root, {
      toast: { afterReply: "always" },
      statusLine: { detail: "one", withSidebar: true },
      words: { sessionTokens: "current" },
      providers: {
        off: CONFIG_PROVIDER_IDS.filter(
          (id) => !["copilot", "minimax-coding-plan", "custom"].includes(id),
        ),
        custom: CUSTOM_SOURCES,
        checking: { minIntervalMs: 60_000 },
      },
      system: {
        exportFile: true,
        exportPath: join(mocks.root, "quota-export.json"),
        telemetry: true,
      },
    });
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: { totalInput: 1200, totalCachedInput: 300, totalOutput: 45 },
    });
    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([
      fakeProvider("copilot", "Copilot (pro)", [percentRow("allowance", "Plan", 81)]),
      fakeProvider("minimax-coding-plan", "MiniMax Token Plan", [
        percentRow("five_hour", "5h", -5, { window: "five_hour", resetsAt: RESET }),
        percentRow("weekly", "Weekly", 40, { window: "week" }),
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
    vi.unstubAllEnvs();
    await rm(mocks.root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("shows one snapshot in the sidebar, status line, toast, the window, export and gauges", async () => {
    const tui = await startHosts();
    const sidebar = () => tui.render("sidebar.content", { sessionID: "ses_1" });
    // The first look asks the server; the providers answer in the background and the
    // `changed` event brings their rows, the last of them the custom source's.
    await vi.waitFor(() => expect(words(sidebar())).toContain("Monthly █████░░░ 64% left 2h 14m"), {
      timeout: 10_000,
    });

    // Sidebar: every provider and its rows; an over-quota row shows 0% left. Each bar takes its
    // level's theme color: plenty, getting low, almost out.
    const expanded = sidebar();
    expect(words(expanded)).toEqual(
      expect.arrayContaining([
        "Plan ██████░░ 81% left",
        "5h ░░░░░░░░ 0% left 2h 14m",
        "Custom providers (Team) Provider e…",
        "Session 1.20K in · 45 out",
      ]),
    );
    const barColor = (start: string) => {
      const text = findAll(expanded, (node) => node.type === "text").find((node) =>
        textLines(node)[0]?.trim().startsWith(start),
      );
      return findAll(text, (node) => node.type === "span")[1]?.props.style.fg;
    };
    expect(["Plan", "Weekly", "5h"].map(barColor)).toEqual(["green", "yellow", "red"]);

    // Collapsed: a click on the title collapses the panel; plugin storage remembers it. A
    // provider with an error keeps its rows and shows the error next to them.
    findAll(
      expanded,
      (node) => typeof node.props?.onMouseDown === "function",
    )[0]?.props.onMouseDown();
    expect(tui.stored.get("sidebar")).toEqual({ open: false });
    expect(words(sidebar())).toEqual(
      expect.arrayContaining([
        "▶ Quota (3 providers, 1 error)",
        "Custom p… 30d █████░░░ 64% Provi…",
      ]),
    );

    // Status line under the message box, here "one provider, big bar".
    expect(words(tui.render("prompt.footer", { sessionID: "ses_1" }))).toEqual([
      "Copilot Plan ████████░░ 81% left",
    ]);

    // Toast after a reply.
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(tui.toast).toHaveBeenCalledOnce());
    const toast = tui.toast.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ variant: "info", title: "OpenCode Quota" });
    expect(toast.message).toContain("Custom providers (… Provider error 503\nSession  1.20K in");

    // /quota opens the window on Limits: every row with its bar, percent, reset and pace.
    await tui.command("limits").run();
    const quotaWindow = () => textLines(tui.render("session.composer.top", { sessionID: "ses_1" }));
    await vi.waitFor(() => expect(quotaWindow()).toContain("  Provider error 503"));
    expect(quotaWindow()).toEqual(
      expect.arrayContaining([
        "OpenCode Quota",
        "Usage",
        "Limits",
        "System",
        // Every tab and the Settings label fit in the 120 columns the window starts with.
        "Settings",
        "Layout",
        "Colors",
        "Words",
        "Providers",
        "esc",
        "Copilot  pro",
        expect.stringMatching(/^ {2}Plan +━+─+ {2}81% left$/u),
        expect.stringMatching(
          /^ {2}5h +─+┃─+ {3}0% left {3}resets in 2h 14m {3}faster than it refills$/u,
        ),
        "Custom providers  Team",
      ]),
    );
    expect(quotaWindow()).not.toContain("Close");

    // /quota_usage opens it on Usage (its ranges; the window starts without the keyboard, so no
    // key hint), /quota_status on System, /quota_settings on the first Settings tab.
    await tui.command("usage").run();
    const usageKeys = "Session + subagents";
    await vi.waitFor(() => expect(quotaWindow()).toContain(usageKeys));
    await tui.command("status").run();
    expect(quotaWindow()).toContainEqual(expect.stringContaining("Copy the report"));
    await tui.command("settings").run();
    expect(quotaWindow()).toContainEqual(
      expect.stringContaining("Show the Quota panel in the session sidebar"),
    );

    // The export file (version 3) and the gauges follow the snapshot without asking a provider
    // again.
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
        provider.entries.map((entry: any) => [entry.name, entry.percentRemaining]),
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
      ["quota-providers", "partial", [["Custom providers (Team) Monthly", 64]]],
    ]);
    expect(exported.providers["quota-providers"]).toMatchObject({
      entries: [{ window: "Monthly", ownership: "user_configured" }],
      sources: [
        { id: "team-accounting", status: "ok", entryCount: 1 },
        { id: "failing-accounting", status: "error", entryCount: 0 },
      ],
    });
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
      quotaWindow(),
      tui.posted.mock.calls,
      exported,
      gauges,
      savedSnapshot,
    );

    // Settings: the window's Sidebar tab edits a draft that the real sidebar shows at once (the
    // tab expands the panel collapsed above); Save writes settings.jsonc and closes.
    const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    clickable(windowTree(), "Sidebar").props.onMouseUp();
    expect(words(sidebar())).toContain("Session 1.20K in · 45 out");
    const sessionTokens = settingLine(windowTree(), "sidebar.sessionTokens");
    expect(words(sessionTokens)).toEqual(["Session tokens line", "‹", "shown", "›"]);
    clickable(sessionTokens, "›").props.onMouseUp();
    expect(words(sidebar())).not.toContain("Session 1.20K in · 45 out");
    expect(tui.stored.has("settings")).toBe(false);
    clickable(windowTree(), "Save").props.onMouseUp();
    await vi.waitFor(() => expect(windowTree()).toBe(""), { timeout: 5_000 });
    expect(
      parseJsonc(
        await readFile(join(mocks.root, "config", "opencode-quota", "settings.jsonc"), "utf8"),
      ),
    ).toMatchObject({ sidebar: { sessionTokens: false } });
    expect(tui.stored.has("settings")).toBe(false);
    expect(tui.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ variant: "success", title: "Quota settings saved" }),
    );
    await tui.dispose();
  });

  describe("the quota window's Settings tabs", () => {
    /** Opens Settings on `tab`, and on Layout on one of its pages ("Sidebar", "All places"). */
    async function openSettings(tab: string, page?: string) {
      const tui = await startHosts();
      await tui.command("settings").run();
      const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });
      // The tab bar shows the tabs around the current one; tab steps on to the others.
      for (let step = 0; step < 12 && !clickable(windowTree(), tab); step += 1) {
        tui
          .layer(10)
          .commands.find((command) => command.bind === "tab")
          ?.run();
      }
      clickable(windowTree(), tab).props.onMouseUp();
      if (page) clickable(windowTree(), page).props.onMouseUp();
      await vi.waitFor(() => expect(words(windowTree())).not.toContain("Loading settings…"));
      return { tui, windowTree };
    }

    it("checks found providers by default, saves unticks and checks a provider found later", async () => {
      writePluginTestSettings(mocks.root, {
        providers: { off: [], checking: { minIntervalMs: 1 } },
      });
      let cursorFound = false;
      const cursor = {
        ...fakeProvider("cursor", "Cursor", [percentRow("monthly", "Month", 60)]),
        isAvailable: async () => cursorFound,
      };
      mocks.getProviders.mockReturnValue([
        fakeProvider("copilot", "Copilot", [percentRow("allowance", "Plan", 81)]),
        cursor,
      ]);
      const { tui, windowTree } = await openSettings("Providers");
      try {
        // Only a ticked provider quota can't find has a word; the tick says the rest.
        await vi.waitFor(() =>
          expect(words(settingLine(windowTree(), "provider.cursor"))).toContain("not set up"),
        );
        expect(words(settingLine(windowTree(), "provider.copilot"))).toEqual([
          "[x] Copilot",
          "",
          "",
          "",
        ]);
        expect(words(windowTree())).not.toContain("Check");
        // A tick with a word keeps it lined up; without one a long name shows whole.
        const alibaba = () => settingLine(windowTree(), "provider.alibaba-token-plan");
        expect(words(alibaba())).toEqual(["[x] Alibaba Personal Toke…", "", "not set up", ""]);
        clickable(alibaba(), "[x] Alibaba Personal Toke…").props.onMouseUp();
        expect(words(alibaba())[0]).toBe("[ ] Alibaba Personal Token Plan");
        clickable(alibaba(), "[ ] Alibaba Personal Token Plan").props.onMouseUp();
        // The ticks are the tab's top lines, as far in as any other line.
        expect(textLines(settingLine(windowTree(), "provider.copilot"))[0]).toMatch(
          /^ {3}\[x\] Copilot/u,
        );
        clickable(settingLine(windowTree(), "provider.copilot"), "[x] Copilot").props.onMouseUp();
        expect(words(settingLine(windowTree(), "provider.copilot"))).toEqual([
          "[ ] Copilot",
          "",
          "",
          "",
        ]);
        clickable(windowTree(), "Save").props.onMouseUp();
        await vi.waitFor(() => expect(windowTree()).toBe(""), { timeout: 5_000 });
        expect(
          parseJsonc(
            await readFile(join(mocks.root, "config", "opencode-quota", "settings.jsonc"), "utf8"),
          ).providers.off,
        ).toEqual(["copilot"]);
        cursorFound = true;
        await tui.handlers.refresh!({ reason: "manual", sessionID: "ses_1" }, {});
        await tui.command("settings").run();
        for (let step = 0; step < 12 && !clickable(windowTree(), "Providers"); step += 1)
          tui.press(10, "tab");
        clickable(windowTree(), "Providers").props.onMouseUp();
        await vi.waitFor(() =>
          expect(words(settingLine(windowTree(), "provider.cursor"))).not.toContain("not set up"),
        );
        expect(words(settingLine(windowTree(), "provider.cursor"))).toContain("[x] Cursor");
        // A tick not saved yet is not checked yet, so it has no word either.
        clickable(settingLine(windowTree(), "provider.copilot"), "[ ] Copilot").props.onMouseUp();
        expect(words(settingLine(windowTree(), "provider.copilot"))).toEqual([
          "[x] Copilot",
          "",
          "",
          "",
        ]);
      } finally {
        await tui.dispose();
      }
    });

    it("a hand edit updates the real sidebar, footer, toast and Limits tab over a draft", async () => {
      const { tui, windowTree } = await openSettings("Layout", "Sidebar");
      try {
        const sidebar = () => words(tui.render("sidebar.content", { sessionID: "ses_1" }));
        await vi.waitFor(() => expect(sidebar()).toContain("Plan ██████░░ 81% left"));
        clickable(settingLine(windowTree(), "sidebar.sessionTokens"), "›").props.onMouseUp();
        const path = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
        const file = parseJsonc(await readFile(path, "utf8"));
        file.sidebar = { names: { "copilot.allowance": "Sidebar quota" } };
        file.toast = { afterReply: "always", names: { "copilot.allowance": "Reply" } };
        file.statusLine = { detail: "one", withSidebar: true, window: { copilot: "month" } };
        file.words = { percent: "used" };
        await writeFile(path, JSON.stringify(file));
        await vi.waitFor(() => expect(sidebar().join(" ")).toContain("Sidebar… ██████░░ 19% used"));
        expect(sidebar().join(" ")).not.toContain("Session 1.20K");
        const footer = () => words(tui.render("prompt.footer", { sessionID: "ses_1" })).join(" ");
        await vi.waitFor(() => expect(footer()).toContain("19%"));
        tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
        await vi.waitFor(() =>
          expect(tui.toast).toHaveBeenLastCalledWith(
            expect.objectContaining({ message: expect.stringContaining("Reply") }),
          ),
        );
        clickable(windowTree(), "Limits").props.onMouseUp();
        expect(words(windowTree()).join(" ")).toContain("Sidebar quota");
      } finally {
        await tui.dispose();
      }
    });

    it("hides the status line while a sidebar panel shows quota, except on its own tab", async () => {
      const path = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
      const file = parseJsonc(await readFile(path, "utf8"));
      file.statusLine = { detail: "one" };
      await writeFile(path, JSON.stringify(file));
      const tui = await startHosts();
      try {
        const footer = () => words(tui.render("prompt.footer", { sessionID: "ses_1" })).join(" ");
        // No sidebar on screen yet: the status line shows.
        await vi.waitFor(() => expect(footer()).toContain("81% left"));
        tui.render("sidebar.content", { sessionID: "ses_1" });
        expect(footer()).toBe("");

        // On the Status line tab it shows, so its changes can be seen.
        await tui.command("settings").run();
        const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });
        for (let step = 0; step < 12 && !clickable(windowTree(), "Status line"); step += 1) {
          tui
            .layer(10)
            .commands.find((command) => command.bind === "tab")
            ?.run();
        }
        clickable(windowTree(), "Status line").props.onMouseUp();
        await vi.waitFor(() => expect(words(windowTree())).not.toContain("Loading settings…"));
        expect(words(settingLine(windowTree(), "statusLine.withSidebar")).join(" ")).toContain(
          "Next to the sidebar ‹ hide the line ›",
        );
        expect(footer()).toContain("81% left");
        clickable(windowTree(), "esc").props.onMouseUp();
        expect(footer()).toBe("");

        // With the sidebar panel off, the sidebar shows no quota, so the status line does.
        file.sidebar = { show: false };
        await writeFile(path, JSON.stringify(file));
        await vi.waitFor(() => expect(footer()).toContain("81% left"));
      } finally {
        await tui.dispose();
      }
    });

    it("closes with unsaved changes only after Save or Discard", async () => {
      const { tui, windowTree } = await openSettings("Layout", "All places");
      clickable(settingLine(windowTree(), "layout.barWidth"), "›").props.onMouseUp();
      clickable(windowTree(), "esc").props.onMouseUp();
      clickable(windowTree(), "esc").props.onMouseUp();
      expect(words(windowTree())).toContain("Keep your changes?");
      expect(tui.stored.has("settings")).toBe(false);
      clickable(windowTree(), "Discard").props.onMouseUp();
      expect(windowTree()).toBe("");
      await tui.dispose();
    });

    it("gives the typed text's keys to its input, and the window its keys back on a tab change", async () => {
      const { tui, windowTree } = await openSettings("Colors");
      const press = () =>
        settingLine(windowTree(), "colors.good")[0]?.props.onMouseDown({ button: 0 });
      press();
      press();
      const input = findAll(windowTree(), (node) => node.type === "input")[0];
      input?.props.ref(input);
      expect([tui.layer(20).enabled?.(), tui.layer(20).target?.()]).toEqual([true, input]);
      expect(tui.layer(10).enabled?.()).toBe(false);

      // Each render makes new nodes, so the window box is "the focusable box".
      clickable(windowTree(), "Layout").props.onMouseUp();
      expect(tui.layer(10).enabled?.()).toBe(true);
      expect(tui.focused()).toMatchObject({ type: "box", props: { focusable: true } });
      await tui.dispose();
    });

    it("walks Layout's pages with ←/→ on its first line, and goes back to the last page", async () => {
      const { tui, windowTree } = await openSettings("Layout");
      // /quota_settings opens Layout on Sidebar, its page line lit.
      expect(activeLabels(windowTree())).toEqual(expect.arrayContaining(["Layout", "Sidebar"]));
      expect(findAll(windowTree(), (node) => node.props?.id === "quota-settings.pages")).toEqual([
        expect.objectContaining({
          props: expect.objectContaining({ backgroundColor: "action-bg" }),
        }),
      ]);
      tui.press(11, "right");
      expect(activeLabels(windowTree())).toContain("Collapsed");
      tui.press(11, "left");
      expect(activeLabels(windowTree())).toContain("Sidebar");
      // From the first page, ← goes round to the last.
      tui.press(11, "left");
      expect(activeLabels(windowTree())).toContain("All places");

      // All places has the What shows lines; Words keeps only numbers and reset times.
      await vi.waitFor(() => expect(settingLine(windowTree(), "words.detail")).not.toEqual([]));
      expect(settingLine(windowTree(), "layout.barWidth")).not.toEqual([]);
      clickable(windowTree(), "Words").props.onMouseUp();
      await vi.waitFor(() => expect(settingLine(windowTree(), "words.percent")).not.toEqual([]));
      expect(settingLine(windowTree(), "words.detail")).toEqual([]);

      // Back on Layout: the page shown last.
      clickable(windowTree(), "Layout").props.onMouseUp();
      expect(activeLabels(windowTree())).toContain("All places");
      expect(words(windowTree())).toContain("Reset page");
      await tui.dispose();
    });

    it("has no /quota form setting on the Layout tab", async () => {
      const { tui, windowTree } = await openSettings("Layout", "All places");
      expect(words(windowTree())).not.toContain("/quota shows");
      expect(tui.stored.has("settings")).toBe(false);
      await tui.dispose();
    });

    it("opens OpenCode's theme list from the theme line's ▸", async () => {
      const { tui, windowTree } = await openSettings("Colors");
      clickable(settingLine(windowTree(), "theme"), "▸").props.onMouseUp();
      expect(tui.dispatch).toHaveBeenCalledWith("theme.switch");
      await tui.dispose();
    });

    it("saves Words and a custom provider switched on in Providers to settings.jsonc, then fetches it", async () => {
      writePluginTestSettings(mocks.root, {
        providers: {
          off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "custom"].includes(id)),
          custom: [{ ...CUSTOM_SOURCES[0], enabled: false }],
          checking: { minIntervalMs: 1 },
        },
      });
      const teamUrl = CUSTOM_SOURCES[0]?.url;
      const fetchedTeam = () => vi.mocked(fetch).mock.calls.some(([url]) => url === teamUrl);
      const { tui, windowTree } = await openSettings("Words");
      const sidebar = () => words(tui.render("sidebar.content", { sessionID: "ses_1" }));
      await vi.waitFor(() => expect(sidebar()).toContain("Plan ██████░░ 81% left"));
      await vi.waitFor(() => expect(settingLine(windowTree(), "words.percent")).toHaveLength(1));

      // The sidebar shows the new words before they are saved.
      clickable(settingLine(windowTree(), "words.percent"), "‹").props.onMouseUp();
      expect(sidebar()).toContain("Plan ██████░░ 19% used");

      clickable(windowTree(), "Providers").props.onMouseUp();
      const team = () => settingLine(windowTree(), "custom.team-accounting");
      await vi.waitFor(() => expect(team()).toHaveLength(1));
      expect(words(windowTree())).toEqual(
        expect.arrayContaining([
          "Custom providers (added in settings.jsonc)",
          "Team",
          "off",
          "https://team-gateway.example/accounting",
          "key: V6_TEAM_KEY, else OpenCode's team-gateway key",
        ]),
      );
      expect(fetchedTeam()).toBe(false);

      clickable(team(), "›").props.onMouseUp();
      clickable(windowTree(), "Save").props.onMouseUp();
      const settingsFile = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
      await vi.waitFor(async () =>
        expect(parseJsonc(await readFile(settingsFile, "utf8"))).toMatchObject({
          words: { percent: "used" },
          providers: { custom: [{ id: "team-accounting", enabled: true }] },
        }),
      );
      // The window closes once the save's answer is back, a moment after the file changed.
      await vi.waitFor(() => expect(windowTree()).toBe(""), { timeout: 5_000 });

      // The plugin uses the saved settings at once: the next check asks the custom provider.
      await tui.command("settings").run();
      await vi.waitFor(() => expect(fetchedTeam()).toBe(true));
      await tui.dispose();
    });

    it("keeps a custom provider off when it changed after the Providers tab showed it", async () => {
      const settings = (url: string) =>
        writePluginTestSettings(mocks.root, {
          providers: {
            off: CONFIG_PROVIDER_IDS.filter((id) => !["copilot", "custom"].includes(id)),
            custom: [{ ...CUSTOM_SOURCES[0], url, enabled: false }],
            checking: { minIntervalMs: 1 },
          },
        });
      settings("https://team-gateway.example/accounting");
      const settingsFile = join(mocks.root, "config", "opencode-quota", "settings.jsonc");
      const custom = async () => parseJsonc(await readFile(settingsFile, "utf8")).providers.custom;
      const { tui, windowTree } = await openSettings("Providers");
      const team = () => settingLine(windowTree(), "custom.team-accounting");
      await vi.waitFor(() => expect(team()).toHaveLength(1));
      clickable(team(), "›").props.onMouseUp();

      // An agent points the provider somewhere else (saved switched off) before the user saves.
      settings("https://other.example/accounting");
      await vi.waitFor(() =>
        expect(words(team()).join(" ")).toContain("https://other.example/accounting"),
      );
      clickable(windowTree(), "Save").props.onMouseUp();

      // Too long to follow the value in 120 columns: the note goes on a line under it.
      await vi.waitFor(() =>
        expect(words(windowTree())).toContain(
          "changed since you reviewed it; look again · https://other.example/accounting",
        ),
      );
      expect(await custom()).toMatchObject([{ id: "team-accounting", enabled: false }]);
      expect(words(team())).toContain("off");
      expect(tui.toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ variant: "error", title: "Quota settings not saved" }),
      );
      await tui.dispose();
    });
  });

  it("shows OpenCode's usage in the Usage tab, its model popup and Web /quota_usage", async () => {
    const now = Date.now();
    const M = 1_000_000;
    writeSessionDatabase(join(mocks.root, "data", "opencode.db"), {
      sessions: [{ id: "ses_1", created: now - 3_600_000 }],
      messages: [
        {
          id: "msg_1",
          sessionID: "ses_1",
          created: now - 60_000,
          completed: now - 59_000,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          tokens: { input: M, cacheRead: 3 * M, output: M / 10 },
        },
        {
          id: "msg_2",
          sessionID: "ses_1",
          created: now - 30_000,
          completed: now - 29_000,
          providerID: "acme",
          modelID: "mystery-1",
          tokens: { output: M / 2 },
        },
      ],
    });
    const tui = await startHosts();

    // The palette's usage command opens the window on its Usage tab, on the last 7 days.
    await tui.command("usage").run();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    const tab = words(usageTab());
    expect(tab).toEqual(
      expect.arrayContaining([
        "Usage",
        "Last 7 days",
        // The daily chart sits beside the total when it gets 32 columns there.
        expect.stringMatching(/^\$\d+\.\d\d 1 session · API estimate Daily cost$/u),
        expect.stringMatching(/^Unpriced tokens excluded: 10\.9% \(mystery-1\) /u),
        "Totals",
        "Cost by type",
        "# Model Cost Share Tokens",
        expect.stringMatching(/^1 ● claude-sonnet-4-5 ━+ \$\d+\.\d\d 100\.0% 4\.10M ▸$/u),
        "2 ● mystery-1 no price 0% 500K ▸",
      ]),
    );

    // A click on a model row opens its details in OpenCode's dialog.
    const modelRow = findAll(
      usageTab(),
      (node) => node.type === "text" && textLines(node)[0]?.includes("claude-sonnet-4-5") === true,
    ).find((node) => typeof node.props.onMouseUp === "function");
    modelRow?.props.onMouseUp();
    expect(tui.dialog.show).toHaveBeenCalledOnce();
    const popup = words(tui.dialog.show.mock.calls[0]?.[0]());
    expect(popup).toEqual(
      expect.arrayContaining([
        "● claude-sonnet-4-5",
        "Anthropic · 100.0% of cost",
        "Cost Tokens Per 1M tokens Cache hit",
        expect.stringMatching(/^\$\d+\.\d\d 4\.10M \$\d+\.\d\d 75\.0%$/u),
        "esc",
      ]),
    );

    // Web and Desktop: /quota_usage posts the same report as text, here for this session.
    await tui.serverCommand("quota_usage", "ses_1", "session");
    const message = tui.posted.mock.calls[0]?.[0].text ?? "";
    expect(message).toContain("Usage · This session\n$");
    expect(message).toContain("1 session · API estimate");
    expect(message).toMatch(/1 {2}● claude-sonnet-4-5 .+4\.10M/u);
    await tui.dispose();
  });

  it("starts the Usage tab on the range typed after /quota_usage, and says why one is wrong", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });

    tui.typed("/quota_usage 30d");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    expect(activeLabels(usageTab())).toContain("Last 30 days");
    expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · API estimate/u));

    tui.typed(`/quota_usage between ${localDate(-12)} ${localDate(-8)}`);
    await vi.waitFor(() => expect(activeLabels(usageTab())).toContain("Between"));
    expect(
      findAll(usageTab(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-12), localDate(-8)]);
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/^1 ● mystery-old /u)),
    );

    // A wrong range leaves the tab as it was and says how to type one.
    tui.typed("/quota_usage 90d");
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        message: expect.stringMatching(/^Unknown range "90d"\.\nUsage: \/quota_usage \[today/u),
      }),
    );
    expect(activeLabels(usageTab())).toContain("Between");
    await tui.dispose();
  });

  it("runs the 4.x and 5.x /tokens_* names, on by default, names the new command while the System switch is off, and runs them again once it is back on", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const windowTree = () => tui.render("session.composer.top", { sessionID: "ses_1" });

    // On by default: /tokens_monthly opens Usage on the last 30 days, /tokens_between on its dates.
    tui.typed("/tokens_monthly");
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("Last 30 days"));
    tui.typed(`/tokens_between ${localDate(-12)} ${localDate(-8)}`);
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("Between"));
    expect(
      findAll(windowTree(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-12), localDate(-8)]);

    // System's switch saves it at once.
    tui.typed("/quota_status");
    const oldCommands = () => settingLine(windowTree(), "system.oldCommands");
    await vi.waitFor(() =>
      expect(words(oldCommands())).toEqual(expect.arrayContaining(["Old command names", "on"])),
    );
    clickable(oldCommands(), "›").props.onMouseUp();
    await vi.waitFor(() => expect(words(oldCommands())).toContain("off"), { timeout: 5_000 });

    // While off (an open TUI's "/" list can still name them until OpenCode restarts), an old name
    // says what to type now, and nothing reaches the chat.
    tui.typed("/tokens_monthly");
    expect(tui.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Use /quota_usage 30d. The old /tokens_* names turn on in /quota_status.",
      }),
    );
    tui.typed("/tokens_between 2026-01-01 2026-01-31");
    expect(tui.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          "Use /quota_usage between YYYY-MM-DD YYYY-MM-DD. The old /tokens_* names turn on in /quota_status.",
      }),
    );
    expect(tui.posted).not.toHaveBeenCalled();

    // Switched back on, both names open Usage again.
    tui.typed("/quota_status");
    await vi.waitFor(() => expect(words(oldCommands())).toContain("off"));
    clickable(oldCommands(), "›").props.onMouseUp();
    await vi.waitFor(() => expect(words(oldCommands())).toContain("on"), { timeout: 5_000 });
    tui.typed("/tokens_monthly");
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("Last 30 days"));
    tui.typed(`/tokens_between ${localDate(-6)} ${localDate(-3)}`);
    await vi.waitFor(() => expect(activeLabels(windowTree())).toContain("Between"));
    expect(
      findAll(windowTree(), (node) => node.type === "input").map((node) => node.props.value),
    ).toEqual([localDate(-6), localDate(-3)]);
    await tui.dispose();
  });

  it("keeps the newest range when an older answer arrives last", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    const usage = tui.handlers.usage;
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    tui.handlers.usage = async (input, context) => {
      calls += 1;
      const answer = await usage(input, context);
      if (calls === 1) await firstHeld;
      return answer;
    };

    await tui.command("usage").run();
    clickable(usageTab(), "Last 30 days").props.onMouseUp();
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u)),
    );
    // The last 7 days answer, asked first, arrives now; the tab keeps the last 30 days.
    releaseFirst();
    await vi.waitFor(() => expect(calls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(words(usageTab())).toContainEqual(expect.stringMatching(/ 2 sessions · /u));
    expect(activeLabels(usageTab())).toContain("Last 30 days");
    await tui.dispose();
  });

  it("applies two Between dates typed in the tab, and warns about dates out of order", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    clickable(usageTab(), "Between").props.onMouseUp();
    const [from, to] = fakeInputs([localDate(-12), localDate(-14)]);
    for (const [index, node] of findAll(usageTab(), (item) => item.type === "input").entries()) {
      node.props.ref([from, to][index]);
    }
    await vi.waitFor(() => expect(from?.focused).toBe(true));
    // While a date has the keyboard, the window's hint says what the keys do there.
    expect(words(usageTab())).toContain(
      "Typing a date: enter next date, then apply · tab other date · esc back to the window",
    );

    tui.press(11, "return");
    expect(to?.focused).toBe(true);
    tui.press(11, "return");
    expect(tui.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        message: "Type two dates like 2026-09-01, the first one not after the second.",
      }),
    );

    if (to) to.value = localDate(-8);
    tui.press(11, "return");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringMatching(/^1 ● mystery-old /u)),
    );
    expect(words(usageTab())).not.toContainEqual(expect.stringContaining("claude-sonnet-4-5"));
    expect(words(usageTab())).toContain("enter or click a date to change it");
    await tui.dispose();
  });

  it("walks the Usage tab's lines with ↑↓ like a Settings tab, one lit at a time, and changes them with ←/→", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    tui.typed("/quota_usage 30d");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    // Opened on a range: the Range line is lit; ↑ goes to Show, and → shows tokens.
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-range"]);
    tui.press(11, "up");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-show"]);
    tui.press(11, "right");
    expect(activeLabels(usageTab())).toContain("Tokens");

    // Down past Range and Prices to Breakdown: ←/→ pick Day, then Model again.
    tui.press(11, "down");
    tui.press(11, "down");
    tui.press(11, "down");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-breakdown"]);
    tui.press(11, "right");
    expect(activeLabels(usageTab())).toContain("Day");
    tui.press(11, "left");
    expect(activeLabels(usageTab())).toContain("Model");

    // Then the model rows, each lit alone; enter opens the lit one's details.
    tui.press(11, "down");
    tui.press(11, "down");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-1"]);
    expect(tui.press(11, "down")).toBe(false);
    tui.press(11, "return");
    expect(tui.dialog.show).toHaveBeenCalledOnce();
    expect(words(tui.dialog.show.mock.calls[0]?.[0]())).toContain("● mystery-old");
    await tui.dispose();
  });

  it("lights the nearest line above when the lit model row is gone after a reload fails", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    tui.typed("/quota_usage 30d");
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    tui.press(11, "down");
    tui.press(11, "down");
    tui.press(11, "down");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-model-0"]);

    // Away to Limits and back: the reload fails, so there is no Breakdown line nor model rows.
    tui.handlers.usage = async () => {
      throw new Error("usage history unreadable");
    };
    tui.press(10, "tab");
    usageTab();
    tui.press(10, "shift+tab");
    await vi.waitFor(() =>
      expect(words(usageTab())).toContainEqual(expect.stringContaining("Couldn't load the usage")),
    );
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-prices"]);
    tui.press(11, "up");
    expect(litUsageLines(usageTab())).toEqual(["quota-usage-range"]);
    await tui.dispose();
  });

  it("keeps the model popup's esc whole on a 32 × 16 terminal", async () => {
    mocks.terminal = { width: 32, height: 16 };
    writeUsageHistory("claude-sonnet-4-5-with-a-very-long-model-name");
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));

    findAll(
      usageTab(),
      (node) => node.type === "text" && textLines(node)[0]?.includes("claude-sonnet-4-5") === true,
    )
      .find((node) => typeof node.props.onMouseUp === "function")
      ?.props.onMouseUp();
    const popup = tui.dialog.show.mock.calls[0]?.[0]();
    const header = findAll(
      popup,
      (node) => node.type === "box" && node.props.flexDirection === "row",
    )[0];
    const [title = "", close] = textLines(header);
    // The dialog is 30 columns on this terminal; its paddings leave 26 for the title and " esc".
    expect(close).toBe("esc");
    expect(title).toMatch(/^● claude-sonnet-4-5-.*…$/u);
    expect([...title].length + " esc".length).toBeLessThanOrEqual(26);
    await tui.dispose();
  });

  it("says why a price download failed", async () => {
    writeUsageHistory();
    const tui = await startHosts();
    const usageTab = () => tui.render("session.composer.top", { sessionID: "ses_1" });
    await tui.command("usage").run();
    await vi.waitFor(() => expect(words(usageTab())).toContain("Breakdown"));
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: false,
      reason: "fetch_failed",
      error: "network down",
      state: { version: 1, updatedAt: 1 },
    });

    clickable(usageTab(), "Update ▸").props.onMouseUp();

    await vi.waitFor(() =>
      expect(tui.toast).toHaveBeenCalledWith({
        variant: "error",
        title: "Prices",
        message: "Couldn't download new prices: network down.",
        duration: 6_000,
      }),
    );
    await tui.dispose();
  });
});

const OLD_TEAM_KEY = "v6-replaced-team-key-canary";
const NEW_TEAM_KEY = "v6-replacement-team-key-canary";

/** A custom provider that is on (no `enabled`), as the user wrote it. */
const ACTIVE_SOURCE = {
  id: "team-quota",
  providerId: "team-gateway",
  label: "Team",
  mode: "remote-api",
  url: "https://old-gateway.example/quota",
  format: "quota-v1",
  apiKeyEnv: "V6_OLD_TEAM_KEY",
};

/** What an agent sends to replace it: another address and another key. */
const REPLACEMENT = {
  ...ACTIVE_SOURCE,
  url: "https://new-gateway.example/quota",
  apiKeyEnv: "V6_NEW_TEAM_KEY",
};

type AgentTool = { name: string; execute(input: unknown): Promise<{ content: string }> };
type ChangedEvent = { snapshot: { providers: Array<{ providerId: string }> } };

/** The real server plugin alone: its agent tools, a manual refresh, and its `changed` events. */
async function startServer() {
  const { default: serverPlugin } = await import("../src/plugin.js");
  const changed: ChangedEvent[] = [];
  const register = vi.fn(async () => ({
    dispose: async () => {},
    events: {
      emit: async (name: string, data: ChangedEvent) => {
        if (name === "changed") changed.push(structuredClone(data));
      },
    },
  }));
  const tools: AgentTool[] = [];
  const dispose = await serverPlugin.setup({
    location: { directory: process.cwd() },
    provider: { list: async () => ({ data: [{ id: "team-gateway" }] }) },
    session: { get: async () => ({}), hook: vi.fn() },
    command: { transform: vi.fn() },
    rpc: { register },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    tool: {
      transform: async (build: (editor: { add(tool: AgentTool): void }) => void) =>
        build({ add: (tool) => tools.push(tool) }),
    },
  } as never);
  const [, handlers] = register.mock.calls[0] as unknown as [
    unknown,
    { refresh(input: { reason: string }): Promise<unknown> },
  ];
  return {
    changed,
    // "manual" waits for no interval: every provider that is on is asked now.
    refresh: () => handlers.refresh({ reason: "manual" }),
    tool: (name: string) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
    dispose: dispose as unknown as () => Promise<void>,
  };
}

describe("an agent tool replacing an active custom provider", () => {
  const savedEnv = {
    V6_OLD_TEAM_KEY: process.env.V6_OLD_TEAM_KEY,
    V6_NEW_TEAM_KEY: process.env.V6_NEW_TEAM_KEY,
  };
  let requests: Array<{ url: string; authorization: string | null }>;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  beforeEach(async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "opencode-quota-v6-tool-reload-"));
    process.env.V6_OLD_TEAM_KEY = OLD_TEAM_KEY;
    process.env.V6_NEW_TEAM_KEY = NEW_TEAM_KEY;
    seedDefaultPluginBootstrapMocks(mocks, { resetPluginState: true });
    writePluginTestSettings(mocks.root, {
      providers: {
        off: CONFIG_PROVIDER_IDS.filter((id) => !["custom"].includes(id)),
        custom: [ACTIVE_SOURCE],
        checking: { minIntervalMs: 3_600_000 },
      },
    });
    const { quotaProvidersProvider } = await import("../src/providers/quota-providers.js");
    mocks.getProviders.mockReturnValue([quotaProvidersProvider]);
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ version: "quota-v1", entries: [] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    await rm(mocks.root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("sends no further request with the old definition or key once the settings reload", async () => {
    server = await startServer();
    await server.refresh();
    expect(requests).toEqual([{ url: ACTIVE_SOURCE.url, authorization: `Bearer ${OLD_TEAM_KEY}` }]);

    const { content } = await server.tool("quota_provider_add").execute({
      definition: REPLACEMENT,
    });
    expect(JSON.parse(content)).toMatchObject({
      ok: true,
      replaced: ACTIVE_SOURCE.id,
      enabled: false,
    });
    expect(content).not.toContain(OLD_TEAM_KEY);
    expect(content).not.toContain(NEW_TEAM_KEY);
    const sentBefore = requests.length;
    const changedBefore = server.changed.length;

    // The same server, no restart: the settings watch reads the saved file, and the next
    // snapshot has no custom provider left to check.
    await vi.waitFor(
      () =>
        expect(
          server?.changed
            .slice(changedBefore)
            .some(({ snapshot }) => snapshot.providers.length === 0),
        ).toBe(true),
      { timeout: 10_000 },
    );
    await server.refresh();
    await server.refresh();

    // The replacement is switched off: neither the old address and key nor the new ones.
    expect(requests.slice(sentBefore)).toEqual([]);
  });
});
