import { describe, expect, it, vi } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

const mocks = vi.hoisted(() => ({
  queryGoogleAgyQuota: vi.fn(),
}));

vi.mock("../src/lib/google-agy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/google-agy.js")>()),
  queryGoogleAgyQuota: mocks.queryGoogleAgyQuota,
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "missing",
    accountCount: 0,
    validAccountCount: 0,
  })),
  inspectAgyCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
}));

// percentRemaining per account, in input order: Gemini 5h, Gemini weekly, Claude/GPT 5h, Claude/GPT weekly.
const ACCOUNTS = [
  { accountEmail: "alice@example.com", percents: [100, 99, 100, 82] },
  { accountEmail: "bob@example.com", percents: [90, 75, 80, 60] },
];
const SLOTS = [
  { family: "Gemini Models", window: "five_hour", windowLabel: "5h" },
  { family: "Gemini Models", window: "weekly", windowLabel: "Weekly" },
  { family: "Claude and GPT models", window: "five_hour", windowLabel: "5h" },
  { family: "Claude and GPT models", window: "weekly", windowLabel: "Weekly" },
];

describe("Google AGY provider surfaces", () => {
  it("keeps two accounts, both families, and both windows distinct on every surface", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: ACCOUNTS.flatMap(({ accountEmail, percents }, accountIndex) =>
        SLOTS.map((slot, slotIndex) => ({
          ...slot,
          percentRemaining: percents[slotIndex],
          accountEmail,
          accountIndex,
          sourceKey: "google-agy",
        })),
      ),
      errors: [],
    });

    const { entries, errors } = await googleAgyProvider.fetch({ client: {} } as never);
    const headers = [
      "[AGY (ali…): Gemini]",
      "[AGY (ali…): Claude/GPT]",
      "[AGY (bob…): Gemini]",
      "[AGY (bob…): Claude/GPT]",
    ];

    const toast = formatQuotaRowsGrouped({
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries,
      errors,
    });
    const sidebar = formatQuotaRowsGrouped({
      layout: { maxWidth: 36, narrowAt: 36, tinyAt: 20 },
      entries,
      errors,
    });
    const command = formatQuotaCommand({ entries, errors });
    const compact = buildCompactQuotaStatusLine({
      data: { entries, errors },
      maxWidth: 400,
    });

    for (const output of [toast, sidebar]) {
      for (const header of headers) expect(output).toContain(header);
      expect(output).toContain("Weekly");
      expect(output).toContain("5h");
      expect(output.indexOf("Weekly")).toBeLessThan(output.indexOf("5h"));
    }
    for (const header of headers) expect(command).toContain(header);
    expect(command.indexOf("Week quota")).toBeLessThan(command.indexOf("5h quota"));
    expect(compact).toBe(
      "AGY (ali…): Gemini 7d 99%, 5h 100% | " +
        "AGY (ali…): Claude/GPT 7d 82%, 5h 100% | " +
        "AGY (bob…): Gemini 7d 75%, 5h 90% | " +
        "AGY (bob…): Claude/GPT 7d 60%, 5h 80%",
    );
    expect(entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "account-1",
      "account-1",
      "account-1",
      "account-1",
      "account-2",
      "account-2",
      "account-2",
      "account-2",
    ]);
  });
});
