import { expect } from "vitest";

import { rowsFromLegacyResult } from "../../src/core/rows.js";
import type { QuotaProviderResult, QuotaToastEntry } from "../../src/lib/entries.js";

export function expectNotAttempted(out: QuotaProviderResult): void {
  expect(out.attempted).toBe(false);
  expect(out.entries).toEqual([]);
  expect(out.errors).toEqual([]);
}

export const PROVIDER_ACCOUNTING_LEDGER: Record<string, Array<QuotaToastEntry["accounting"]>> = {
  anthropic: [
    {
      resultType: "quota",
      acquisitionMethod: "local_cli",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  copilot: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "usage",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "usage",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  openai: [
    {
      resultType: "rate_limit",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "status",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  openrouter: [
    {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "spend",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  kilo: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  cursor: [
    {
      resultType: "budget",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "spend",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  "alibaba-coding-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "local_estimation",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  "alibaba-token-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "local_cli",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  synthetic: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  chutes: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "google-gemini-cli": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "google-agy": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  zai: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  zhipu: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  nanogpt: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "minimax-coding-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "minimax-china-coding-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "kimi-code-plan-global": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "kimi-code-plan-cn": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  deepseek: [
    {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "status",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  xai: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  xiaomi: [
    {
      resultType: "quota",
      acquisitionMethod: "dashboard_scrape",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "balance",
      acquisitionMethod: "dashboard_scrape",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "opencode-go": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  opencode: [
    {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "spend",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "status",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "ollama-cloud": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "quota-providers": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
    {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
    {
      resultType: "spend",
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
  ],
};

/**
 * The v6 row keys each provider may emit (`${providerId}.${key}` is the row id that hide,
 * rename and order settings use). `*` stands for one segment taken from provider data, such
 * as a model, a window family or a currency. Changing a key breaks users' settings.
 */
export const PROVIDER_ROW_KEYS: Record<string, readonly string[]> = {
  anthropic: ["five_hour", "weekly", "weekly_fable", "extra_usage"],
  copilot: ["allowance", "additional_budget"],
  // `status`: an OpenAI login without a ChatGPT plan ("unavailable for API key").
  openai: ["five_hour", "weekly", "monthly", "code_review", "status"],
  openrouter: ["key"],
  kilo: ["pass_credits", "balance"],
  cursor: ["api", "auto_composer"],
  "alibaba-coding-plan": ["five_hour", "weekly", "monthly"],
  "alibaba-token-plan": ["five_hour", "weekly"],
  synthetic: ["five_hour", "weekly"],
  chutes: ["daily"],
  "google-gemini-cli": ["pro", "flash", "flash_lite", "model.*"],
  "google-agy": [
    "gemini.weekly",
    "gemini.five_hour",
    "claude_gpt.weekly",
    "claude_gpt.five_hour",
    "*.weekly",
    "*.five_hour",
  ],
  zai: ["five_hour", "weekly", "mcp"],
  zhipu: ["five_hour", "weekly", "mcp"],
  nanogpt: ["daily", "monthly", "balance.usd", "balance.nano"],
  "minimax-coding-plan": ["five_hour", "weekly"],
  "minimax-china-coding-plan": ["five_hour", "weekly"],
  "kimi-code-plan-global": ["weekly", "limit.*"],
  "kimi-code-plan-cn": ["weekly", "limit.*"],
  deepseek: ["total_balance.*", "granted_balance.*", "topped_up_balance.*", "available"],
  xai: ["credits"],
  xiaomi: ["monthly_tokens", "total_balance", "cash_balance", "gift_balance"],
  "opencode-go": ["five_hour", "weekly", "monthly"],
  opencode: ["monthly", "balance", "auto_reload"],
  "ollama-cloud": ["session", "weekly", "monthly"],
  "quota-providers": ["custom.*.*"],
};

/** True when `key` is one of the provider's ledger keys. */
export function isLedgerRowKey(providerId: string, key: string): boolean {
  return (PROVIDER_ROW_KEYS[providerId] ?? []).some((pattern) =>
    new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[A-Za-z0-9_-]+")}$`).test(key),
  );
}

/** The v6 row keys the shim gives these entries, checked against the ledger. */
export function expectLedgerRowKeys(providerId: string, entries: QuotaToastEntry[]): string[] {
  const { rows } = rowsFromLegacyResult(providerId, { attempted: true, entries, errors: [] });
  const keys = rows.map((row) => row.id.slice(providerId.length + 1));
  for (const key of keys) {
    expect(
      isLedgerRowKey(providerId, key),
      `${providerId}.${key} is not in PROVIDER_ROW_KEYS`,
    ).toBe(true);
  }
  return keys;
}

export function visibleEntries(
  entries: QuotaToastEntry[],
  providerId?: string,
): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    expect(entry.accounting).toEqual(
      expect.objectContaining({
        resultType: expect.stringMatching(/^(quota|rate_limit|usage|spend|budget|balance|status)$/),
        acquisitionMethod: expect.stringMatching(
          /^(remote_api|dashboard_scrape|local_cli|local_runtime_accounting|local_estimation)$/,
        ),
        ownership: expect.stringMatching(/^(maintained|user_configured)$/),
        authority: expect.stringMatching(/^(provider_reported|locally_derived)$/),
      }),
    );
    if (providerId) {
      const {
        sourceId: _sourceId,
        observedAtIso: _observedAtIso,
        ...ledgerAccounting
      } = entry.accounting;
      expect(PROVIDER_ACCOUNTING_LEDGER[providerId]).toContainEqual(ledgerAccounting);
      // Every sample row also becomes exactly one v6 row with a ledger key.
      expect(expectLedgerRowKeys(providerId, [entry]), `${providerId}: ${entry.name}`).toHaveLength(
        1,
      );
    }
    const { accounting: _accounting, ...visible } = entry;
    return visible;
  });
}

export function expectAttemptedWithNoErrors(out: QuotaProviderResult): void {
  expect(out.attempted).toBe(true);
  expect(out.errors).toEqual([]);
  visibleEntries(out.entries);
}

export function expectAttemptedWithErrorLabel(out: QuotaProviderResult, label: string): void {
  expect(out.attempted).toBe(true);
  expect(out.entries).toEqual([]);
  expect(out.errors[0]?.label).toBe(label);
}
