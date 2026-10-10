import { describe, expect, it } from "vitest";

import {
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
  getQuotaProviderRuntimeIds,
  getQuotaProviderShape,
  QUOTA_PROVIDER_CATALOG,
} from "../src/lib/provider-metadata.js";
import { QUOTA_PROVIDER_REGISTRATION_SOURCE } from "../src/lib/provider-registration.js";

const COPILOT = ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"];
const GEMINI_CLI = ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth", "google"];
const ZHIPU = ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"];
const MINIMAX_CN = [
  "minimax-china-coding-plan",
  "minimax-cn-coding-plan",
  "minimax-cn",
  "minimax-china",
];
const KIMI_CN = ["kimi-code-plan-cn", "kimi-for-coding", "kimi", "kimi-code"];
const XIAOMI = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"];

describe("provider-metadata", () => {
  it("lists every registered provider in order, each shape under its own id", () => {
    const ids = QUOTA_PROVIDER_REGISTRATION_SOURCE.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(QUOTA_PROVIDER_CATALOG)).toEqual(ids);
    for (const [id, entry] of Object.entries(QUOTA_PROVIDER_CATALOG)) {
      expect(entry.shape.id).toBe(id);
      if (entry.shape.recommendedReplacementId) {
        expect(ids).toContain(entry.shape.recommendedReplacementId);
      }
    }
    expect(getQuotaProviderShape("alibaba")).toEqual({
      id: "alibaba-coding-plan",
      autoSetup: "yes",
      authentication: "opencode_auth_api_key",
      authFallbacks: ["env_api_key", "global_opencode_config"],
      quota: "local_estimation",
    });
    expect(getQuotaProviderShape("gemini-cli")?.recommendedReplacementId).toBe("google-agy");
  });

  // Synonyms name the provider; runtime ids are only the OpenCode ids that count as it.
  it.each([
    ["  OpenAI  ", "openai", "OpenAI", ["openai", "chatgpt", "codex"]],
    ["claude", "anthropic", "Anthropic", ["anthropic"]],
    ["github-copilot", "copilot", "Copilot", COPILOT],
    ["open-cursor", "cursor", "Cursor", ["cursor", "cursor-acp"]],
    ["gemini-cli", "google-gemini-cli", "Gemini CLI", GEMINI_CLI],
    [
      "alibaba-token-plan",
      "alibaba-token-plan",
      "Alibaba Personal Token Plan",
      ["alibaba-token-plan"],
    ],
    ["glm-coding-plan", "zhipu", "Zhipu", ZHIPU],
    ["nano-gpt", "nanogpt", "NanoGPT", ["nanogpt", "nano-gpt"]],
    ["minimax-cn-coding-plan", "minimax-china-coding-plan", "MiniMax Token Plan (CN)", MINIMAX_CN],
    ["kimi-code-plan-global", "kimi-code-plan-global", "Kimi Code", ["kimi-code-plan-global"]],
    ["kimi", "kimi-code-plan-cn", "Kimi Code (CN)", KIMI_CN],
    ["deep-seek", "deepseek", "DeepSeek", ["deepseek"]],
    ["opencode-zen", "opencode", "OpenCode Zen", ["opencode", "opencode-zen"]],
    ["xiaomi-token-plan-ams", "xiaomi", "Xiaomi MiMo", XIAOMI],
    ["quota-providers", "quota-providers", "Quota providers", []],
    ["kilo-gateway", undefined, "kilo-gateway", []],
    ["google-antigravity", undefined, "google-antigravity", []],
    ["mimo", undefined, "mimo", []],
    ["grok", undefined, "grok", []],
  ])("knows %j as %s (%s)", (input, id, label, runtimeIds) => {
    expect(getQuotaProviderShape(input)?.id).toBe(id);
    expect(getQuotaProviderDisplayLabel(input)).toBe(label);
    expect(getQuotaProviderRuntimeIds(input)).toEqual(runtimeIds);
  });

  it.each([
    ["kimi", ["kimi-code-plan-cn"]],
    [" KIMI-CODE-PLAN-GLOBAL ", ["kimi-code-plan-global"]],
    ["google", ["google-gemini-cli"]],
    ["claude", []],
  ])("finds the provider owning the runtime id %j", (runtimeId, ids) => {
    expect(getQuotaProviderIdsForRuntimeId(runtimeId)).toEqual(ids);
  });
});
