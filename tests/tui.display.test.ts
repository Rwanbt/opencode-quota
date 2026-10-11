import { describe, expect, it } from "vitest";
import {
  type DisplaySettings,
  defaultDisplaySettings,
  FIELDS,
  type Field,
  type PresetName,
  presetChoice,
  presetValues,
  renameRow,
  resetTab,
  setIn,
  stepIn,
  typedColor,
  valueAt,
} from "../src/tui/display.js";

describe("the Settings tabs' field table", () => {
  const field = (path: string) => FIELDS.find((item) => item.path === path) as Field;
  /** ‹ or › on a line, as the Settings tab does it. */
  const cycled = (settings: DisplaySettings, item: Field, delta: number) => {
    const values = item.choices?.(settings) ?? item.values;
    return setIn(
      settings,
      item.path.split("."),
      stepIn(values, valueAt(settings, item.path), delta),
    );
  };
  const choiceOf = (settings: DisplaySettings, name: PresetName) =>
    presetChoice(name, (path) => valueAt(settings, path));
  /** ‹ or › on a preset line. */
  const withPreset = (settings: DisplaySettings, name: PresetName, delta: number) =>
    Object.entries(presetValues(name, choiceOf(settings, name), delta)).reduce(
      (next, [path, value]) => setIn(next, path.split("."), value),
      settings,
    );

  it.each(
    FIELDS.filter((item) => item.values.length > 0).map((item) => [item.path, item] as const),
  )("%s starts at one of its values", (_path, item) => {
    expect(item.values).toContain(valueAt(defaultDisplaySettings(), item.path));
  });

  it.each([
    { path: "layout.barWidth", delta: 1, expected: 10 },
    { path: "layout.barWidth", delta: -1, expected: 6 },
    { path: "layout.separator", delta: -1, expected: "  " },
    { path: "statusLine.detail", delta: 1, expected: "one" },
    { path: "statusLine.runsOut", delta: 1, expected: true },
    { path: "colors.reset", delta: 1, expected: "text" },
    { path: "colors.reset", delta: -1, expected: "bar" },
    { path: "colors.good", delta: -1, expected: "blue" },
    // Warning stays at or above low, so each goes round through the levels that keep it so.
    { path: "colors.warningBelow", delta: -1, expected: 60, from: 20 },
    { path: "colors.lowBelow", delta: 1, expected: 10, from: 20 },
  ])("‹ › on $path by $delta gives $expected", ({ path, delta, expected, from }) => {
    const start =
      from === undefined
        ? defaultDisplaySettings()
        : setIn(defaultDisplaySettings(), ["colors"], {
            ...defaultDisplaySettings().colors,
            warningBelow: from,
            lowBelow: from,
          });
    const next = cycled(start, field(path), delta);
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
    expect([choiceOf(defaults, "layout"), choiceOf(defaults, "toast")]).toEqual([
      "comfortable",
      "normal",
    ]);
    const own = cycled(defaults, field("layout.indent"), 1);
    expect(choiceOf(own, "layout")).toBeUndefined();
    expect(choiceOf(withPreset(own, "layout", 1), "layout")).toBe("compact");
    const roomy = withPreset(defaults, "layout", 1);
    expect([choiceOf(roomy, "layout"), roomy.layout]).toEqual([
      "roomy",
      { ...defaults.layout, barWidth: 10, indent: 2, providerGap: 1 },
    ]);
    expect(withPreset(defaults, "toast", -1).toast.afterCompaction).toBe(false);
  });

  it("renames a row whose id holds a dot, and its own name or nothing puts it back", () => {
    const renamed = renameRow(
      defaultDisplaySettings(),
      "sidebar",
      "anthropic.five_hour",
      "5h",
      " Session ",
    );
    expect(renamed.labels).toEqual({ "anthropic.five_hour": "Session" });
    expect(renameRow(renamed, "sidebar", "anthropic.five_hour", "5h", "5h").labels).toEqual({});
    expect(renameRow(renamed, "sidebar", "anthropic.five_hour", "5h", "").labels).toEqual({});
  });

  it("resets only the tab's lines, its surface and its windows; row names stay", () => {
    let changed = defaultDisplaySettings();
    changed = setIn(changed, ["collapsed", "runsOut"], true);
    changed = setIn(changed, ["collapsed", "providerOrder"], ["openai", "anthropic"]);
    changed = setIn(changed, ["collapsed", "window", "anthropic"], "week");
    changed = setIn(changed, ["sidebar", "runsOut"], true);
    changed = setIn(changed, ["sidebar", "names", "anthropic.five_hour"], "Session");
    const reset = resetTab(changed, "collapsed");
    expect(reset).toEqual(
      setIn(
        setIn(defaultDisplaySettings(), ["sidebar", "runsOut"], true),
        ["sidebar", "names", "anthropic.five_hour"],
        "Session",
      ),
    );
    expect(resetTab(changed, "layout")).toEqual(changed);
  });
});
