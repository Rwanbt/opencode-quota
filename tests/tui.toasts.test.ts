import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot, QuotaSnapshot, ResetNotice } from "../src/core/types.js";
import type { QuotaClient } from "../src/tui/client.js";
import { type DisplaySettings, defaultDisplaySettings } from "../src/tui/display.js";
import plugin from "../src/tui/index.tsx";
import { createToasts, type TurnEnd } from "../src/tui/toasts.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

/** The cleanups the TUI registers with Solid (on the server build they never run by themselves). */
const cleanups = vi.hoisted(() => [] as Array<() => void>);
vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onCleanup: (cleanup: () => void) => {
    cleanups.push(cleanup);
  },
}));

function provider(label: string, percentRemaining?: number): ProviderSnapshot {
  const providerId = label.toLowerCase();
  return {
    providerId,
    label,
    rows:
      percentRemaining === undefined
        ? []
        : [
            {
              id: `${providerId}.weekly`,
              providerId,
              label: "Weekly",
              type: "quota",
              method: "remote_api",
              authority: "provider_reported",
              window: "week",
              prominence: "primary",
              percentRemaining,
            },
          ],
    okAtMs: NOW,
    checkedAtMs: NOW,
    ...(percentRemaining === undefined ? { error: { code: "timeout" as const } } : {}),
    refreshing: false,
    debug: [],
  };
}

function snapshot(providers: ProviderSnapshot[], resetNotices: ResetNotice[] = []): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices,
    generatedAtMs: NOW,
    serverId: "server",
    revision: NOW,
  };
}

function startToasts(answer: QuotaSnapshot | undefined, change: (d: DisplaySettings) => void) {
  const display = defaultDisplaySettings();
  change(display);
  const show = vi.fn();
  const refresh = vi.fn(async () => answer);
  const toasts = createToasts({
    show,
    display: () => display,
    quota: { refresh } as unknown as QuotaClient,
    isChildSession: (sessionID) => sessionID === "child",
    now: () => NOW,
  });
  return { toasts, show, refresh };
}

const OK = snapshot([provider("Claude", 80)]);
const LOW = snapshot([provider("Claude", 10)]);

describe("quota toasts", () => {
  it.each<{
    name: string;
    trigger: TurnEnd;
    answer: QuotaSnapshot;
    change?: (display: DisplaySettings) => void;
    shown: boolean;
  }>([
    { name: "after compaction by default", trigger: "compaction", answer: OK, shown: true },
    { name: "not after a reply by default", trigger: "reply", answer: OK, shown: false },
    { name: "not after a question by default", trigger: "question", answer: OK, shown: false },
    {
      name: "after every reply when turned on",
      trigger: "reply",
      answer: OK,
      change: (display) => {
        display.toast.afterReply = "always";
      },
      shown: true,
    },
    {
      name: "after a reply only when quota is low, with the low setting",
      trigger: "reply",
      answer: LOW,
      change: (display) => {
        display.toast.afterReply = "low";
      },
      shown: true,
    },
    {
      name: "not after a reply with plenty left, with the low setting",
      trigger: "reply",
      answer: OK,
      change: (display) => {
        display.toast.afterReply = "low";
      },
      shown: false,
    },
    {
      name: "never when the toast surface is off",
      trigger: "compaction",
      answer: OK,
      change: (display) => {
        display.surfaces.toast.enabled = false;
      },
      shown: false,
    },
  ])("shows a toast $name", async ({ trigger, answer, change, shown }) => {
    const { toasts, show, refresh } = startToasts(answer, change ?? (() => {}));
    await toasts.afterTurn(trigger, "ses_1");
    expect(refresh).toHaveBeenCalledWith("turn", "ses_1");
    expect(show.mock.calls.map(([toast]) => toast.message)).toEqual(
      shown ? [`Claude Weekly       ${answer === LOW ? "10" : "80"}% left`] : [],
    );
  });

  it("never asks or shows anything for a subagent session", async () => {
    const { toasts, show, refresh } = startToasts(OK, (display) => {
      display.toast.afterReply = "always";
    });
    await toasts.afterTurn("reply", "child");
    expect(refresh).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("says once that every provider fails, until one answers again", async () => {
    const failing = snapshot([provider("Claude"), provider("Copilot")]);
    let answer = failing;
    const show = vi.fn();
    const toasts = createToasts({
      show,
      display: defaultDisplaySettings,
      quota: { refresh: async () => answer } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    for (const next of [failing, failing, OK, failing]) {
      answer = next;
      await toasts.afterTurn("reply", "ses_1");
    }
    expect(show.mock.calls.map(([toast]) => [toast.variant, toast.message])).toEqual([
      ["error", "Claude              Timed out\nCopilot             Timed out"],
      ["error", "Claude              Timed out\nCopilot             Timed out"],
    ]);
  });

  it.each([
    { setting: "off", expected: [] },
    {
      setting: "weekly",
      expected: ["Weekly quota reset: Claude (work) Weekly is available again (100% left)."],
    },
    {
      setting: "all",
      expected: [
        [
          "Weekly quota reset: Claude (work) Weekly is available again (100% left).",
          "5h quota reset: Claude 5h is available again (97% left).",
        ].join("\n"),
      ],
    },
  ] as const)("shows new reset notices once, in one toast, with the $setting setting", ({
    setting,
    expected,
  }) => {
    const notice = (id: string, fields: Partial<ResetNotice>): ResetNotice => ({
      id,
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      atMs: NOW,
      ...fields,
    });
    const notices = [
      notice("weekly", { account: "work" }),
      notice("five-hour", {
        rowId: "claude.five_hour",
        label: "5h",
        window: "five_hour",
        percentRemaining: 96.6,
      }),
      // A reset from before this TUI started was news to the TUI that saw it then.
      notice("old", { atMs: NOW - 1 }),
    ];
    const { toasts, show } = startToasts(undefined, (display) => {
      display.toast.resetNotice = setting;
    });
    toasts.showResetNotices(snapshot([provider("Claude", 100)], notices));
    toasts.showResetNotices(snapshot([provider("Claude", 100)], notices));
    expect(show.mock.calls.map(([toast]) => toast.message)).toEqual(expected);
  });

  /** Reset notices turned on, and a compaction turn whose refresh the test answers. */
  function turnWaitingForQuota() {
    let answer: (snapshot: QuotaSnapshot | undefined) => void = () => {};
    const show = vi.fn();
    const toasts = createToasts({
      show,
      display: () => {
        const display = defaultDisplaySettings();
        display.toast.resetNotice = "all";
        return display;
      },
      quota: {
        refresh: () =>
          new Promise<QuotaSnapshot | undefined>((resolve) => {
            answer = resolve;
          }),
      } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    const turn = toasts.afterTurn("compaction", "ses_1");
    const notice: ResetNotice = {
      id: "weekly",
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      atMs: NOW,
    };
    const withNotice = snapshot([provider("Claude", 100)], [notice]);
    const titles = () => show.mock.calls.map(([toast]) => toast.title);
    return { toasts, turn, answer: (value?: QuotaSnapshot) => answer(value), withNotice, titles };
  }

  it("shows a reset notice that comes during a turn after the turn's toast", async () => {
    const { toasts, turn, answer, withNotice, titles } = turnWaitingForQuota();
    toasts.showResetNotices(withNotice);
    expect(titles()).toEqual([]);
    answer(OK);
    await turn;
    expect(titles()).toEqual(["OpenCode Quota", "Quota available"]);
  });

  it("drops the reset notices still waiting when the TUI leaves its server", async () => {
    const { toasts, turn, answer, withNotice, titles } = turnWaitingForQuota();
    toasts.showResetNotices(withNotice);
    toasts.cancel();
    // A stopped client answers nothing.
    answer(undefined);
    await turn;
    expect(titles()).toEqual([]);
    // Unshown, the notice shows when a snapshot brings it again.
    toasts.showResetNotices(withNotice);
    expect(titles()).toEqual(["Quota available"]);
  });
});

describe("turn events of the TUI plugin", () => {
  const handlers = new Map<string, (event: { data: Record<string, unknown> }) => void>();
  const rpc = {
    command: vi.fn(),
    snapshot: vi.fn(),
    refresh: vi.fn(),
    notices: vi.fn(),
    acknowledgeDisplayImport: vi.fn(),
    events: { on: vi.fn(() => () => {}) },
  };
  const session = { get: vi.fn() };
  const toast = vi.fn();

  beforeEach(() => {
    handlers.clear();
    cleanups.length = 0;
    for (const mock of [rpc.notices, session.get, toast]) mock.mockReset();
    rpc.snapshot.mockReset().mockResolvedValue({ snapshot: snapshot([]) });
    rpc.acknowledgeDisplayImport.mockReset().mockResolvedValue({});
    rpc.refresh.mockReset().mockResolvedValue({ snapshot: OK });
    plugin.setup({
      client: { rpc: () => rpc },
      location: { directory: process.cwd() },
      storage: {
        store: (_key: string, options: { initial: unknown }) => [options.initial, vi.fn()],
      },
      data: {
        session,
        on: (name: string, handler: (event: { data: Record<string, unknown> }) => void) => {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
      keymap: { layer: vi.fn() },
      ui: {
        slot: (claim: { append: string; render: () => unknown }) => {
          if (claim.append === "app") claim.render();
          return vi.fn();
        },
        toast: { show: toast },
      },
    } as never);
  });

  const emit = (name: string, data: Record<string, unknown>) => handlers.get(name)?.({ data });

  it("refreshes quota after a question is answered, with no toast by default", async () => {
    emit("session.tool.input.started", { name: "question", id: "call-1" });
    emit("session.tool.success", { sessionID: "ses_1", id: "call-1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    expect(rpc.refresh).toHaveBeenCalledWith(
      { reason: "turn", sessionID: "ses_1" },
      expect.anything(),
    );
    // Only the subagent check reads the session.
    expect(session.get).toHaveBeenCalledExactlyOnceWith("ses_1");
    expect(toast).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a failed question", tool: "question", end: "session.tool.failed" },
    { name: "another tool", tool: "bash", end: "session.tool.success" },
  ])("does nothing after $name", ({ tool, end }) => {
    emit("session.tool.input.started", { name: tool, id: "call-2" });
    emit(end, { sessionID: "ses_1", id: "call-2" });
    expect(rpc.refresh).not.toHaveBeenCalled();
    expect(session.get).not.toHaveBeenCalled();
  });

  it("asks for the snapshot once mounted, so Home gets the converted looks too", () => {
    expect(rpc.snapshot).toHaveBeenCalledWith({}, expect.anything());
  });

  it("says once that the settings were converted, then applies and acknowledges the looks", async () => {
    const displayImport = { id: "import-1", display: { toast: { afterReply: "always" as const } } };
    rpc.refresh.mockResolvedValue({ snapshot: { ...OK, displayImport } });
    emit("session.step.ended", { sessionID: "ses_1" });
    emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(rpc.acknowledgeDisplayImport).toHaveBeenCalledExactlyOnceWith(
        { id: "import-1" },
        expect.anything(),
      ),
    );
    expect(toast.mock.calls.map(([shown]) => shown.message)).toEqual([
      "Settings converted from v5 to settings.jsonc, details in /quota_status",
    ]);
  });

  it("stops listening when OpenCode unmounts the app slot", () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    emit("session.step.ended", { sessionID: "ses_1" });
    expect(handlers.size).toBe(0);
    expect(rpc.refresh).not.toHaveBeenCalled();
  });

  it("refreshes after each step of a session, never of a subagent", () => {
    session.get.mockImplementation((id: string) => (id === "child" ? { parentID: "ses_1" } : {}));
    emit("session.step.ended", { sessionID: "child" });
    emit("session.step.ended", { sessionID: "ses_1" });
    expect(rpc.refresh.mock.calls.map(([input]) => input)).toEqual([
      { reason: "turn", sessionID: "ses_1" },
    ]);
  });
});
