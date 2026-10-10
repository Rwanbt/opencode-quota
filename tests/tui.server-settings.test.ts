import { describe, expect, it, vi } from "vitest";
import type { QuotaRpcSaveSettingsInput, QuotaRpcSettingsOutput } from "../src/rpc.js";
import { checkSetting, SETTINGS_SCHEMA } from "../src/settings/index.js";
import {
  createServerSettings,
  isTicked,
  SERVER_FIELDS,
  type ServerField,
  settingsPatch,
  steppedWording,
  withTick,
  wordingChoice,
} from "../src/tui/server-settings.js";

const field = (key: string) => SERVER_FIELDS.find((item) => item.key === key) as ServerField;

describe("the Words and Providers tabs' field table", () => {
  it("starts every line at the server's default and steps only through values it accepts", () => {
    for (const item of SERVER_FIELDS) {
      const rule = SETTINGS_SCHEMA[item.key as keyof typeof SETTINGS_SCHEMA];
      expect([item.key, item.initial]).toEqual([item.key, rule.default]);
      expect("fileOnly" in rule).toBe(false);
      for (const value of item.values) expect(checkSetting(item.key, value).issues).toEqual([]);
    }
  });

  it("has a line for every setting a client may change but the notices'", () => {
    const shown = new Set([...SERVER_FIELDS.map((item) => item.key), "providers.enabled"]);
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
    const parsed = field(key).typed?.parse(text);
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
    expect(wordingChoice(value)).toBe(choice);
    const stepped = steppedWording(value, 1);
    expect(wordingChoice((key) => stepped[key])).toBe(next);
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
    custom: [{ id: "gw", label: "Gateway", enabled: false, request: null }],
  };

  function fakeRpc(answer = { ok: true, issues: [] as Array<{ key: string; message: string }> }) {
    let saved = structuredClone(SAVED);
    const rpc = {
      settings: vi.fn(async () => structuredClone(saved)),
      saveSettings: vi.fn(async (input: QuotaRpcSaveSettingsInput) => {
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
      customEnabled: { gw: true },
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
});
