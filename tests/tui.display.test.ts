import { describe, expect, it } from "vitest";
import {
  applyDisplayImport,
  createDisplayStore,
  cycleField,
  cyclePreset,
  type DisplaySettings,
  defaultDisplaySettings,
  FIELDS,
  type Field,
  NEWER_SETTINGS,
  presetChoice,
  readDisplaySettings,
  renameRow,
  resetTab,
  SETTINGS_VERSION,
  type StoredDisplay,
  setIn,
  typedColor,
  valueAt,
} from "../src/tui/display.js";

const stored = (settings: unknown) => ({ version: SETTINGS_VERSION, settings });

describe("display settings in plugin storage", () => {
  it.each([
    undefined,
    null,
    "text",
    [],
    { version: 1 },
    stored("text"),
  ])("uses the defaults for %j", (value) => {
    expect(readDisplaySettings(value)).toEqual(defaultDisplaySettings());
  });

  it.each<{
    name: string;
    settings: unknown;
    pick: (d: DisplaySettings) => unknown;
    expected: unknown;
  }>([
    {
      name: "a bar width out of range",
      settings: { layout: { barWidth: 99, bar: "dots" } },
      pick: (d) => [d.layout.barWidth, d.layout.bar],
      expected: [8, "dots"],
    },
    {
      name: "an unknown bar shape",
      settings: { layout: { bar: "zigzag" } },
      pick: (d) => d.layout.bar,
      expected: "blocks",
    },
    {
      name: "colors that are not a theme name or #rrggbb",
      settings: { colors: { good: "#00ff00", low: "pink", reset: "accent" } },
      pick: (d) => d.colors,
      expected: { good: "#00ff00", reset: "accent" },
    },
    {
      name: "a warning level below the low level",
      settings: { thresholds: { warningBelow: 10, lowBelow: 30 } },
      pick: (d) => d.thresholds,
      expected: { warningBelow: 30, lowBelow: 30 },
    },
    {
      name: "hidden ids that are not a list, and a row order with a bad entry",
      settings: { surfaces: { sidebar: { hidden: "claude", rowOrder: { claude: ["a"], x: 3 } } } },
      pick: (d) => [d.surfaces.sidebar.hidden, d.surfaces.sidebar.rowOrder],
      expected: [[], { claude: ["a"] }],
    },
    {
      name: "an unknown preferred window",
      settings: { window: { anthropic: "week", openai: "fortnight" } },
      pick: (d) => d.window,
      expected: { anthropic: "week" },
    },
    {
      name: "an unknown toast choice",
      settings: { toast: { afterReply: "sometimes", seconds: 0, afterQuestion: true } },
      pick: (d) => [d.toast.afterReply, d.toast.seconds, d.toast.afterQuestion],
      expected: ["off", 9, true],
    },
  ])("keeps the rest and takes the default for $name", ({ settings, pick, expected }) => {
    expect(pick(readDisplaySettings(stored(settings)))).toEqual(expected);
  });

  /**
   * A plugin store like OpenCode's: one live value that every TUI shares, changed only through
   * `update`, which waits for `gate` when set.
   */
  function fakeStorage(initial?: unknown) {
    const live: { value?: StoredDisplay; gate?: Promise<void> } = {};
    const storage = {
      store: <Value extends object>(key: string, options: { readonly initial: Value }) => {
        expect(key).toBe("settings");
        live.value ??= structuredClone((initial ?? options.initial) as StoredDisplay);
        const update = async (mutation: (draft: Value) => void) => {
          await live.gate;
          mutation(live.value as unknown as Value);
        };
        return [live.value as unknown as Value, update] as const;
      },
    };
    return { storage, live };
  }

  it("reads the live store, so an edit from another TUI shows at once", () => {
    const { storage, live } = fakeStorage();
    const display = createDisplayStore(storage);
    expect(display.saved().statusLine.home).toBe(false);
    live.value!.settings = setIn(defaultDisplaySettings(), ["statusLine", "home"], true);
    expect(display.saved().statusLine.home).toBe(true);
  });

  it("shows a draft until Save stores it, and Discard drops it", async () => {
    const { storage, live } = fakeStorage();
    const display = createDisplayStore(storage);
    display.edit((settings) => setIn(settings, ["layout", "barWidth"], 12));
    expect([display.shown().layout.barWidth, display.saved().layout.barWidth]).toEqual([12, 8]);
    expect(display.dirty()).toBe(true);
    await display.save();
    expect([live.value?.settings?.layout.barWidth, display.dirty()]).toEqual([12, false]);

    display.edit((settings) => setIn(settings, ["layout", "barWidth"], 4));
    display.discard();
    expect([display.shown().layout.barWidth, display.dirty()]).toEqual([12, false]);
    // A change made and then undone leaves nothing to save.
    display.edit((settings) => setIn(settings, ["colors", "good"], "#00ff00"));
    display.edit((settings) => setIn(settings, ["colors", "good"], undefined));
    expect(display.dirty()).toBe(false);
  });

  it("saves only this window's changes, so another TUI's saved settings stay", async () => {
    const { storage, live } = fakeStorage();
    const first = createDisplayStore(storage);
    const second = createDisplayStore(storage);
    first.edit((settings) => setIn(settings, ["layout", "barWidth"], 12));
    second.edit((settings) => setIn(settings, ["statusLine", "home"], true));
    await second.save();
    expect([first.shown().statusLine.home, first.shown().layout.barWidth]).toEqual([true, 12]);
    await first.save();
    const saved = live.value?.settings;
    expect([saved?.statusLine.home, saved?.layout.barWidth, first.dirty()]).toEqual([
      true,
      12,
      false,
    ]);
  });

  it("keeps a change made while Save writes, unsaved", async () => {
    const { storage, live } = fakeStorage();
    const display = createDisplayStore(storage);
    let write = () => {};
    live.gate = new Promise((resolve) => {
      write = resolve;
    });
    display.edit((settings) => setIn(settings, ["layout", "barWidth"], 12));
    const saving = display.save();
    display.edit((settings) => setIn(settings, ["layout", "bar"], "dots"));
    write();
    await saving;
    expect([live.value?.settings?.layout.barWidth, live.value?.settings?.layout.bar]).toEqual([
      12,
      "blocks",
    ]);
    expect([display.shown().layout.bar, display.dirty()]).toEqual(["dots", true]);
  });

  it("stays live after an edit that changes nothing", () => {
    const { storage, live } = fakeStorage();
    const display = createDisplayStore(storage);
    display.edit((settings) => setIn(settings, ["layout", "barWidth"], 8));
    live.value!.settings = setIn(defaultDisplaySettings(), ["statusLine", "home"], true);
    expect([display.shown().statusLine.home, display.dirty()]).toEqual([true, false]);
  });

  it("keeps what still fits from settings of an older version, and saves the current one", async () => {
    const { storage, live } = fakeStorage({
      version: SETTINGS_VERSION - 1,
      settings: { layout: { barWidth: 10, bar: "zigzag" }, runsOut: { toast: true }, extra: 1 },
    });
    const display = createDisplayStore(storage);
    expect([display.saved().layout.barWidth, display.saved().runsOut.toast]).toEqual([10, true]);
    display.edit((settings) => setIn(settings, ["statusLine", "home"], true));
    await display.save();
    expect(live.value).toEqual({
      version: SETTINGS_VERSION,
      settings: readDisplaySettings({
        settings: {
          layout: { barWidth: 10 },
          runsOut: { toast: true },
          statusLine: { home: true },
        },
      }),
    });
  });

  it("refuses to save over settings of a newer version and leaves them as they are", async () => {
    const newer = {
      version: SETTINGS_VERSION + 1,
      settings: { layout: { barWidth: 10, bar: "zigzag" }, runsOut: { toast: true }, extra: 1 },
    };
    const { storage, live } = fakeStorage(newer);
    const display = createDisplayStore(storage);
    expect([display.saved().layout.barWidth, display.saved().runsOut.toast]).toEqual([10, true]);
    display.edit((settings) => setIn(settings, ["statusLine", "home"], true));
    await expect(display.save()).rejects.toThrow(NEWER_SETTINGS);
    expect([live.value, display.dirty()]).toEqual([newer, true]);
  });

  it.each([
    {
      name: "saves the v5 looks over the defaults while nothing is saved",
      saved: undefined,
      displayImport: {
        statusLine: { detail: "one" as const },
        toast: { afterReply: "always" as const },
        // v5's quotaProjection "runway": every runs-out estimate on.
        runsOut: { sidebar: true, collapsed: true, statusLine: true, toast: true },
      },
      expected: { detail: "one", afterReply: "always", afterCompaction: true, runsOut: 4 },
    },
    {
      name: "never overwrites settings saved before",
      saved: { version: 1, settings: { toast: { afterReply: "low" } } },
      displayImport: {
        statusLine: { detail: "one" as const },
        toast: { afterReply: "always" as const },
      },
      expected: { detail: "auto", afterReply: "low", afterCompaction: true, runsOut: 0 },
    },
    {
      name: "saves nothing for an empty import",
      saved: undefined,
      displayImport: {},
      expected: { detail: "auto", afterReply: "off", afterCompaction: true, runsOut: 0 },
    },
  ])("applyDisplayImport $name", async ({ saved, displayImport, expected }) => {
    const { storage, live } = fakeStorage(saved);
    await applyDisplayImport(storage, displayImport);
    const display = createDisplayStore(storage).saved();
    expect({
      detail: display.statusLine.detail,
      afterReply: display.toast.afterReply,
      afterCompaction: display.toast.afterCompaction,
      runsOut: Object.values(display.runsOut).filter(Boolean).length,
    }).toEqual(expected);
    if (Object.keys(displayImport).length === 0 && !saved) {
      expect(live.value).toEqual({ version: 1 });
    }
  });
});

describe("the Settings tabs' field table", () => {
  const field = (path: string) => FIELDS.find((item) => item.path === path) as Field;

  it.each(
    FIELDS.map((item) => [item.path, item] as const),
  )("%s starts at one of its values", (_path, item) => {
    expect(item.values).toContain(valueAt(defaultDisplaySettings(), item.path));
  });

  it.each([
    { path: "layout.barWidth", delta: 1, expected: 10 },
    { path: "layout.barWidth", delta: -1, expected: 6 },
    { path: "layout.separator", delta: -1, expected: "  " },
    { path: "statusLine.detail", delta: 1, expected: "one" },
    { path: "runsOut.statusLine", delta: 1, expected: true },
    { path: "colors.reset", delta: 1, expected: "text" },
    { path: "colors.reset", delta: -1, expected: "bar" },
    { path: "colors.good", delta: -1, expected: "blue" },
    // Warning stays at or above low, so each goes round through the levels that keep it so.
    { path: "thresholds.warningBelow", delta: -1, expected: 60, from: 20 },
    { path: "thresholds.lowBelow", delta: 1, expected: 10, from: 20 },
  ])("‹ › on $path by $delta gives $expected", ({ path, delta, expected, from }) => {
    const start =
      from === undefined
        ? defaultDisplaySettings()
        : setIn(defaultDisplaySettings(), ["thresholds"], { warningBelow: from, lowBelow: from });
    const next = cycleField(start, field(path), delta);
    expect(valueAt(next, path)).toBe(expected);
    // The rest stays as it was.
    expect(setIn(next, path.split("."), valueAt(start, path))).toEqual(start);
  });

  it.each([
    { text: "#89B4FA", expected: "#89b4fa" },
    { text: " 89b4fa ", expected: "#89b4fa" },
    { text: "", expected: undefined },
    { text: "pink", expected: "#112233" },
  ])("a typed color $text gives $expected", ({ text, expected }) => {
    const before = setIn(defaultDisplaySettings(), ["colors", "reset"], "#112233");
    expect(typedColor(before, field("colors.reset"), text).colors.reset).toBe(expected);
  });

  it("names the preset the lines match, else your own, and a preset sets its lines", () => {
    const defaults = defaultDisplaySettings();
    expect([presetChoice(defaults, "layout"), presetChoice(defaults, "toast")]).toEqual([
      "comfortable",
      "normal",
    ]);
    const own = cycleField(defaults, field("layout.indent"), 1);
    expect(presetChoice(own, "layout")).toBeUndefined();
    expect(presetChoice(cyclePreset(own, "layout", 1), "layout")).toBe("compact");
    const roomy = cyclePreset(defaults, "layout", 1);
    expect([presetChoice(roomy, "layout"), roomy.layout]).toEqual([
      "roomy",
      { ...defaults.layout, barWidth: 10, indent: 2, providerGap: 1 },
    ]);
    expect(cyclePreset(defaults, "toast", -1).toast.afterCompaction).toBe(false);
  });

  it("renames a row whose id holds a dot, and its own name or nothing puts it back", () => {
    const renamed = renameRow(defaultDisplaySettings(), "anthropic.five_hour", "5h", " Session ");
    expect(renamed.labels).toEqual({ "anthropic.five_hour": "Session" });
    expect(renameRow(renamed, "anthropic.five_hour", "5h", "5h").labels).toEqual({});
    expect(renameRow(renamed, "anthropic.five_hour", "5h", "").labels).toEqual({});
  });

  it("resets only the tab's lines, its surface and its windows; row names stay", () => {
    let changed = defaultDisplaySettings();
    changed = setIn(changed, ["runsOut", "collapsed"], true);
    changed = setIn(changed, ["surfaces", "collapsed", "providerOrder"], ["openai", "anthropic"]);
    changed = setIn(changed, ["window", "anthropic"], "week");
    changed = setIn(changed, ["runsOut", "sidebar"], true);
    changed = setIn(changed, ["labels", "anthropic.five_hour"], "Session");
    const reset = resetTab(changed, "collapsed");
    expect(reset).toEqual(
      setIn(
        setIn(defaultDisplaySettings(), ["runsOut", "sidebar"], true),
        ["labels", "anthropic.five_hour"],
        "Session",
      ),
    );
    expect(resetTab(changed, "layout")).toEqual(changed);
  });
});
