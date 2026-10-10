import { describe, expect, it } from "vitest";

import {
  legacyResultFromFetch,
  rowsFromLegacyResult,
  rowsFromProviderResult,
} from "../src/core/rows.js";
import type { CredentialRow } from "../src/lib/opencode-auth.js";
import { normalizeQuotaProviderResult } from "../src/lib/quota-state-codec.js";
import {
  FIVE_HOUR,
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "../src/providers/contract.js";

const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");

function login(id: string, label: string, active = false): { row: CredentialRow } {
  return { row: { id, integrationId: "openai", label, active, value: { type: "oauth" } } };
}

const FIVE_HOUR_ROW = quotaRow({
  ...FIVE_HOUR,
  percentRemaining: 40,
  resetsAt: "2026-01-01T15:00:00.000Z",
  windowStartedAt: "2026-01-01T10:00:00.000Z",
});

describe("fetchEachLogin", () => {
  it("fetches every login, names each account like OpenCode lists it, and skips empty ones", async () => {
    const accounts = await fetchEachLogin({
      providerName: "OpenAI",
      logins: [login("a", "Work", true), login("b", "Work"), login("c", ""), login("d", "")],
      async fetchLogin({ row }) {
        if (row.id === "c") return null;
        return {
          rows: [FIVE_HOUR_ROW],
          errors: row.id === "b" ? [{ message: "partial" }] : [],
          ...(row.id === "a" ? { fallbackName: "OpenAI (Pro)" } : {}),
        };
      },
    });

    expect(accounts.map(({ name, login, errors }) => [name, login, errors])).toEqual([
      ["[OpenAI Work] (Pro) (active)", "a", []],
      ["[OpenAI Work 2]", "b", [{ message: "partial" }]],
      ["[OpenAI]", "d", []],
    ]);
  });
});

describe("rowsFromProviderResult on the row contract", () => {
  it("adds ids, accounts and logins, then reads the errors", () => {
    const result: ProviderFetchResult = {
      attempted: true,
      accounts: [
        { name: "[Claude Work] (active)", login: "work-id", rows: [FIVE_HOUR_ROW], errors: [] },
        {
          name: "[Claude Home]",
          login: "home-id",
          rows: [FIVE_HOUR_ROW, FIVE_HOUR_ROW, { ...FIVE_HOUR_ROW, key: "Bad Key" }],
          errors: [{ message: "HTTP 429 slow down" }],
        },
      ],
      debug: [{ key: "api_key", value: "sk-secret" }],
    };

    const fetched = rowsFromProviderResult("anthropic", result, NOW_MS);

    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["anthropic.five_hour", "Work"],
      ["anthropic.five_hour", "Home"],
    ]);
    expect(fetched.rowLogins).toEqual(["work-id", "home-id"]);
    expect(fetched.error).toMatchObject({ code: "rate_limited" });
    expect(fetched.debug).toEqual([
      { key: "api_key", value: "[redacted]" },
      { key: "dropped_row", value: "anthropic.five_hour: repeated row" },
      { key: "dropped_row", value: "anthropic.Bad Key: invalid id" },
      { key: "error", value: "[Claude Home]: HTTP 429 slow down" },
    ]);
  });

  it("reports a provider that had nothing to query as not set up", () => {
    expect(
      rowsFromProviderResult("anthropic", { attempted: false, accounts: [], debug: [] }, NOW_MS),
    ).toEqual({ rows: [], error: { code: "not_configured" }, debug: [] });
  });
});

describe("legacyResultFromFetch", () => {
  const ROWS: Array<[string, ProviderRow]> = [
    ["a percent row with its window start", FIVE_HOUR_ROW],
    [
      "a budget with used and limit",
      {
        ...quotaRow({
          key: "additional_budget",
          label: "Budget",
          window: "month",
          percentRemaining: 80,
        }),
        type: "budget",
        authority: "locally_derived",
        used: { decimal: "0.2", unit: { kind: "currency", code: "USD" } },
        limit: { decimal: "1", unit: { kind: "currency", code: "USD" } },
      },
    ],
    [
      "a text row without a window",
      {
        key: "status",
        label: "Status",
        type: "status",
        method: "local_estimation",
        authority: "locally_derived",
        prominence: "primary",
        text: "ChatGPT quota unavailable for API key",
      },
    ],
    [
      "an amount",
      {
        key: "balance",
        label: "Balance",
        type: "balance",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "supplementary",
        amount: { decimal: "8.25", unit: { kind: "currency", code: "USD" } },
      },
    ],
    [
      "a flag",
      {
        key: "available",
        label: "Available",
        type: "status",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        flag: true,
      },
    ],
  ];

  it.each(ROWS)("keeps %s through the legacy pipeline", (_name, row) => {
    const result: ProviderFetchResult = {
      attempted: true,
      accounts: [
        { name: "[Copilot alice] (pro)", login: "alice-id", rows: [row], errors: [] },
        {
          name: "Copilot",
          rows: [{ ...quotaRow({ ...WEEKLY, percentRemaining: 5 }) }],
          errors: [],
        },
      ],
      debug: [{ key: "billing_scope", value: "user" }],
    };

    const legacy = normalizeQuotaProviderResult(legacyResultFromFetch(result, NOW_MS));

    if (legacy === null) throw new Error("the legacy result did not validate");
    expect(rowsFromLegacyResult("copilot", legacy, NOW_MS)).toEqual(
      rowsFromProviderResult("copilot", result, NOW_MS),
    );
  });

  it("keeps errors, with their account names, and not-set-up", () => {
    const result: ProviderFetchResult = {
      attempted: true,
      accounts: [{ name: "Copilot", rows: [], errors: [{ message: "HTTP 503", retryable: true }] }],
      debug: [],
    };

    expect(legacyResultFromFetch(result, NOW_MS)).toEqual({
      attempted: true,
      entries: [],
      errors: [{ label: "Copilot", message: "HTTP 503", retryable: true }],
      statusDetails: [],
    });
    expect(legacyResultFromFetch({ attempted: false, accounts: [], debug: [] })).toMatchObject({
      attempted: false,
    });
  });
});
