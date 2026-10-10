import { describe, expect, it, vi } from "vitest";
import type { QuotaRpcSaveSettingsInput, QuotaRpcSettingsOutput } from "../src/rpc.js";
import { checkSetting, SETTINGS_SCHEMA } from "../src/settings/index.js";
import { CHANGED_SINCE_REVIEW } from "../src/settings/schema.js";
import { FIELDS, type Field, presetChoice, presetValues, typedNumber } from "../src/tui/display.js";
import {
  createServerSettings,
  isTicked,
  settingsPatch,
  withTick,
} from "../src/tui/server-settings.js";

const SERVER_FIELDS = FIELDS.filter((item) => item.store === "server");
const field = (path: string) => SERVER_FIELDS.find((item) => item.path === path) as Field;

describe("the Words and Providers tabs' lines", () => {
  it("starts every line at the server's default and steps only through values it accepts", () => {
    for (const item of SERVER_FIELDS) {
      const rule = SETTINGS_SCHEMA[item.path as keyof typeof SETTINGS_SCHEMA];
      expect([item.path, item.initial]).toEqual([item.path, rule.default]);
      expect("fileOnly" in rule).toBe(false);
      for (const value of item.values) expect(checkSetting(item.path, value).issues).toEqual([]);
    }
  });

  it("has a line for every setting a client may change but the notices'", () => {
    const shown = new Set([...SERVER_FIELDS.map((item) => item.path), "providers.enabled"]);
    const editable = Object.entries(SETTINGS_SCHEMA)
      .filter(([key, rule]) => key !== "version" && !("fileOnly" in rule))
      .map(([key]) => key)
      .filter((key) => !key.startsWith("announcements."));
    expect(editable.filter((key) => !shown.has(key))).toEqual([]);
  });

  it.each([
    { key: "providers.cursor.includedApiUsd", text: "$25", value: 25 },
    { key: "providers.cursor.includedApiUsd", text: " ", value: null },
    { key: "providers.cursor.includedApiUsd", text: "-3", value: undefined },
    { key: "providers.cursor.includedApiUsd", text: "lots", value: undefined },
    { key: "providers.cursor.billingCycleStartDay", text: "28", value: 28 },
    { key: "providers.cursor.billingCycleStartDay", text: "29", value: undefined },
    { key: "providers.cursor.billingCycleStartDay", text: "1.5", value: undefined },
    { key: "providers.opencode.monthlyLimitUsd", text: "40.5", value: 40.5 },
  ])("reads $text typed into $key as $value", ({ key, text, value }) => {
    const parsed = typedNumber(field(key), text);
    expect(parsed).toBe(value);
    if (parsed !== undefined) expect(checkSetting(key, parsed).issues).toEqual([]);
  });

  it("shows each value in words", () => {
    expect(field("words.percent").values.map(field("words.percent").show)).toEqual([
      "58% left",
      "58% remaining",
      "58%",
      "42% used",
    ]);
    expect(field("words.reset").show("compact")).toBe("2h14m · 5d3h20m");
    expect(field("checking.minIntervalMs").show(300_000)).toBe("every 5 min");
    expect(field("providers.cursor.includedApiUsd").show(null)).toBe("from the plan");
  });

  it.each([
    {
      values: { "words.percent": "bare", "words.reset": "compact" },
      choice: "short",
      next: "spelled out",
    },
    {
      values: { "words.percent": "used", "words.reset": "exact" },
      choice: undefined,
      next: "normal",
    },
  ])("matches the Wording choice $choice and steps to $next", ({ values, choice, next }) => {
    const value = (key: string) => values[key as keyof typeof values];
    expect(presetChoice("words", value)).toBe(choice);
    const stepped = presetValues("words", choice, 1);
    expect(presetChoice("words", (key) => stepped[key])).toBe(next);
  });
});

describe("provider ticks", () => {
  const ids = ["copilot", "cursor", "openai", "custom"];
  const found = ["copilot", "custom"];

  it.each([
    { enabled: "auto" as const, id: "cursor", on: true, list: ["copilot", "cursor", "custom"] },
    { enabled: "auto" as const, id: "copilot", on: false, list: ["custom"] },
    { enabled: ["openai"], id: "cursor", on: true, list: ["cursor", "openai"] },
    { enabled: ["openai"], id: "openai", on: false, list: [] },
  ])("ticks $id $on from $enabled", ({ enabled, id, on, list }) => {
    expect(isTicked(enabled, id, found)).toBe(!on);
    expect(withTick(enabled, ids, found, id, on)).toEqual(list);
  });

  it("nests the changes into the patch saveSettings takes", () => {
    expect(
      settingsPatch({
        "words.percent": "used",
        "providers.enabled": ["copilot"],
        "providers.cursor.includedApiUsd": null,
      }),
    ).toEqual({
      words: { percent: "used" },
      providers: { enabled: ["copilot"], cursor: { includedApiUsd: null } },
    });
  });
});

describe("the server settings this window edits", () => {
  const SAVED: QuotaRpcSettingsOutput = {
    values: { "words.percent": "left", "providers.enabled": "auto" },
    providers: [{ id: "copilot", label: "Copilot" }],
    custom: [{ id: "gw", label: "Gateway", enabled: false, request: null, fingerprint: "fp-a" }],
  };

  /** The server; a save waits for `gate` when set. */
  function fakeRpc(
    answer = { ok: true, issues: [] as Array<{ key: string; message: string }> },
    gate?: Promise<void>,
  ) {
    let saved = structuredClone(SAVED);
    const rpc = {
      settings: vi.fn(async () => structuredClone(saved)),
      saveSettings: vi.fn(async (input: QuotaRpcSaveSettingsInput) => {
        await gate;
        if (!answer.ok) return answer;
        const words = input.patch.words as { percent?: string } | undefined;
        saved = {
          ...saved,
          values: { ...saved.values, "words.percent": words?.percent },
          custom: saved.custom.map((entry) => ({ ...entry, enabled: true })),
        };
        return answer;
      }),
    };
    return rpc;
  }

  it("counts only values that differ from the saved ones, and saves them with the switches", async () => {
    const rpc = fakeRpc();
    const server = createServerSettings(rpc);
    await server.load();

    server.set("words.percent", "used");
    server.set("words.percent", "left");
    expect(server.dirty()).toBe(false);
    server.set("words.percent", "used");
    server.switchCustom("gw", true);
    expect([server.dirty(), server.customOn("gw"), server.draftWords()]).toEqual([
      true,
      true,
      { percent: "used" },
    ]);

    await server.save();

    expect(rpc.saveSettings).toHaveBeenCalledWith({
      patch: { words: { percent: "used" } },
      customEnabled: { gw: { enabled: true, fingerprint: "fp-a" } },
    });
    expect([server.dirty(), server.value("words.percent"), server.customOn("gw")]).toEqual([
      false,
      "used",
      true,
    ]);
  });

  it("keeps the changes and says why when the server refuses them", async () => {
    const rpc = fakeRpc({ ok: false, issues: [{ key: "words.percent", message: "expected …" }] });
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");

    await expect(server.save()).rejects.toThrow("words.percent: expected …");
    expect(server.value("words.percent")).toBe("used");
    server.discard();
    expect([server.dirty(), server.value("words.percent")]).toEqual([false, "left"]);
  });

  it("keeps a change back to the saved value made while Save waits, unsaved", async () => {
    let answer = () => {};
    const rpc = fakeRpc(
      undefined,
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");

    const saving = server.save();
    server.set("words.percent", "left");
    answer();
    await saving;

    expect(server.saved()?.values["words.percent"]).toBe("used");
    expect([server.value("words.percent"), server.dirty()]).toEqual(["left", true]);
  });

  it("reloads and marks a custom provider whose definition changed since the window showed it", async () => {
    const issue = { key: "providers.custom.gw", message: CHANGED_SINCE_REVIEW };
    const rpc = fakeRpc({ ok: false, issues: [issue] });
    const server = createServerSettings(rpc);
    await server.load();
    server.switchCustom("gw", true);
    const now = {
      url: "https://other.example/quota",
      key: "environment variable OTHER",
      insecure: false,
    };
    rpc.settings.mockResolvedValue({
      ...SAVED,
      custom: [{ id: "gw", label: "Gateway", enabled: false, request: now, fingerprint: "fp-b" }],
    });

    await expect(server.save()).rejects.toThrow(CHANGED_SINCE_REVIEW);

    expect(rpc.saveSettings).toHaveBeenCalledWith({
      patch: {},
      customEnabled: { gw: { enabled: true, fingerprint: "fp-a" } },
    });
    expect(server.saved()?.custom[0]?.request).toEqual(now);
    expect([server.customOn("gw"), server.changedSinceReview("gw"), server.dirty()]).toEqual([
      false,
      true,
      false,
    ]);
    // Switching it on again, after looking at the new details, sends their fingerprint.
    server.switchCustom("gw", true);
    expect(server.changedSinceReview("gw")).toBe(false);
    await expect(server.save()).rejects.toThrow();
    expect(rpc.saveSettings).toHaveBeenLastCalledWith({
      patch: {},
      customEnabled: { gw: { enabled: true, fingerprint: "fp-b" } },
    });
  });
});
