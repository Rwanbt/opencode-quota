import { describe, expect, it } from "vitest";
import {
  type DisplaySettings,
  defaultDisplaySettings,
  loadDisplaySettings,
  readDisplaySettings,
  SETTINGS_VERSION,
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

  it("reads the live store, so an edit from another TUI shows at once", () => {
    let value: { version: number; settings: Partial<DisplaySettings> } | undefined;
    const read = loadDisplaySettings({
      store: <Value extends object>(key: string, options: { readonly initial: Value }) => {
        expect(key).toBe("settings");
        value = structuredClone(options.initial) as never;
        return [value as unknown as Value, async () => {}] as const;
      },
    });
    expect(read().statusLine.home).toBe(false);
    value!.settings.statusLine = { ...defaultDisplaySettings().statusLine, home: true };
    expect(read().statusLine.home).toBe(true);
  });
});
