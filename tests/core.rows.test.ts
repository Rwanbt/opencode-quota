import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountFromGroup,
  rowsFromLegacyResult,
  rowsFromProviderResult,
} from "../src/core/rows.js";
import type { DebugDetail, QuotaRow } from "../src/core/types.js";
import type { AccountingMetadata, QuotaToastEntry } from "../src/lib/entries.js";
import type {
  JsonV1Mapping,
  LocalEstimateQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";
import { computeLocalQuotaProviderEstimate } from "../src/lib/quota-providers-local.js";
import { fetchRemoteQuotaProvider } from "../src/lib/quota-providers-remote.js";
import type { ProviderFetchResult } from "../src/providers/contract.js";
import { answer, NOT_SET_UP, percentRow, textRow } from "./helpers/fake-answers.js";

const NOW_MS = Date.parse("2026-10-10T12:00:00.000Z");
const RESET = "2026-10-11T00:00:00.000Z";

function contractRows(providerId: string, result: ProviderFetchResult) {
  return rowsFromProviderResult(providerId, result, NOW_MS);
}

/** A failed check: one account with these errors, plus the provider's debug details. */
function failedCheck(
  name: string,
  errors: string[],
  debug: DebugDetail[] = [],
): ProviderFetchResult {
  return { ...answer({ name, errors }), debug };
}

/** [id, account, label, window] per row: the parts users' settings and the TUI rely on. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [row.id, row.account ?? null, row.label, row.window ?? null]);
}

/** A custom definition's accounting, as the custom providers stamp it. */
function custom(overrides: Partial<AccountingMetadata> = {}): AccountingMetadata {
  return {
    resultType: "quota",
    acquisitionMethod: "remote_api",
    ownership: "user_configured",
    authority: "provider_reported",
    sourceId: "source-one",
    ...overrides,
  };
}

function usd(decimal: string) {
  return { decimal, unit: { kind: "currency" as const, code: "USD" } };
}

function customRows(entries: QuotaToastEntry[]) {
  return rowsFromLegacyResult("quota-providers", { attempted: true, entries, errors: [] }, NOW_MS);
}

describe("rowsFromProviderResult", () => {
  it("gives each row its id, provider and its account's account text", () => {
    const result = contractRows(
      "openai",
      answer(
        {
          name: "OpenAI (Pro)",
          rows: [
            percentRow("five_hour", "5h", 50, { window: "five_hour", resetsAt: RESET }),
            percentRow("weekly", "Weekly", 80, {
              window: "week",
              windowStartedAt: "2026-10-04T00:00:00.000Z",
            }),
          ],
        },
        { name: "[OpenAI Work] (Business)", rows: [percentRow("five_hour", "5h", 10)] },
      ),
    );
    expect(result.rows[0]).toEqual({
      id: "openai.five_hour",
      providerId: "openai",
      account: "Pro",
      label: "5h",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      window: "five_hour",
      prominence: "primary",
      percentRemaining: 50,
      resetsAt: RESET,
    });
    expect(result.rows[1]?.windowStartedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(summary(result.rows).slice(2)).toEqual([
      ["openai.five_hour", "Work (Business)", "5h", null],
    ]);
    expect(result).not.toHaveProperty("rowLogins");
    expect(result).not.toHaveProperty("error");
  });

  it("keeps each row's login for the store and drops a row repeated for one login", () => {
    const fiveHour = percentRow("five_hour", "5h", 50, { window: "five_hour" });
    const weekly = percentRow("weekly", "Weekly", 50, { window: "week" });
    const result = contractRows(
      "opencode-go",
      answer(
        { name: "[OpenCode Go] (active)", login: "a", rows: [fiveHour] },
        { name: "[OpenCode Go]", login: "b", rows: [fiveHour, weekly, weekly] },
      ),
    );
    // Both logins have no name; the store numbers them, as it also sees logins that failed.
    expect(summary(result.rows)).toEqual([
      ["opencode-go.five_hour", null, "5h", "five_hour"],
      ["opencode-go.five_hour", null, "5h", "five_hour"],
      ["opencode-go.weekly", null, "Weekly", "week"],
    ]);
    expect(result.rowLogins).toEqual(["a", "b", "b"]);
    expect(result.debug).toEqual([
      { key: "dropped_row", value: "opencode-go.weekly: repeated row" },
    ]);
  });

  it("drops rows it can't validate and keeps the rest", () => {
    const result = contractRows(
      "zai",
      answer({
        name: "Z.ai",
        rows: [
          percentRow("five_hour", "5h", 50, { window: "five_hour" }),
          percentRow("weekly", "Weekly", Number.NaN, { window: "week" }),
          percentRow("mcp", "MCP", 50, { resetsAt: "tomorrow" }),
        ],
      }),
    );
    expect(result.rows.map((row) => row.id)).toEqual(["zai.five_hour"]);
    expect(result.debug).toEqual([
      { key: "dropped_row", value: "zai.weekly: invalid percentRemaining" },
      { key: "dropped_row", value: "zai.mcp: invalid resetsAt" },
    ]);
    expect(result.error).toBeUndefined();
  });

  it("classifies the first error and keeps every message for /quota_status", () => {
    const fetched = contractRows("anthropic", {
      ...answer(
        { name: "[Claude Home]", rows: [percentRow("five_hour", "5h", 50)] },
        { name: "[Claude Work]", errors: ["Token expired"] },
        { name: "[Claude Other]", errors: ["HTTP 500"] },
      ),
      debug: [{ key: "auth_source", value: "opencode_db" }],
    });
    expect(fetched.rows.map((row) => row.account)).toEqual(["Home"]);
    expect(fetched.error).toEqual({ code: "login_expired", detail: "Token expired" });
    expect(fetched.debug).toEqual([
      { key: "auth_source", value: "opencode_db" },
      { key: "error", value: "[Claude Work]: Token expired" },
      { key: "error", value: "[Claude Other]: HTTP 500" },
    ]);
  });

  it("reports a provider that could not even try as not set up", () => {
    expect(contractRows("chutes", NOT_SET_UP)).toEqual({
      rows: [],
      error: { code: "not_configured" },
      debug: [],
    });
    expect(contractRows("chutes", answer())).toEqual({ rows: [], debug: [] });
  });

  it("scrubs control characters from provider text", () => {
    const [row] = contractRows(
      "kilo",
      answer({
        name: "Kilo Gateway (Evil\u001b[31m)",
        rows: [textRow("balance", "Evil\u001b[31m Note", "red\u001b[0m text\nnext")],
      }),
    ).rows;
    expect(row?.account).toBe("Evil");
    expect(row?.label).toBe("Evil Note");
    expect(row?.text).toBe("red text next");
  });

  it("redacts credentials a provider echoes in errors and debug details", () => {
    const secrets = [
      "sk-proj-CANARY0secret0value0123",
      "CANARY1bearer0token",
      "Q0FOQVJZMjpiYXNpYw==",
      "CANARY3query0key",
      "CANARY4json0api0key",
      "eyJhbGciOiJIUzI1NiJ9.eyJDQU5BUlk1Ijp0cnVlfQ.c2lnbmF0dXJl",
      "ghp_CANARY6github0token0value",
    ];
    const message = [
      `401 for key ${secrets[0]}`,
      `Authorization: Bearer ${secrets[1]}`,
      `"authorization":"Basic ${secrets[2]}"`,
      `GET https://api.example/v1/quota?key=${secrets[3]}&x=1`,
      `{"api_key":"${secrets[4]}"}`,
      `token ${secrets[5]}`,
      `${secrets[6]}`,
    ].join(" | ");
    const result = contractRows(
      "chutes",
      failedCheck("Chutes", [message], [{ key: "request", value: message }]),
    );
    const text = JSON.stringify(result);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain("CANARY");
    expect(result.error?.detail).toContain("[redacted]");
  });

  it("redacts whole cookie headers, quoted secrets and values whose key names a secret", () => {
    const message = [
      "HTTP 401 Cookie: session=one; xsrf=CANARYcookie",
      `{"password":"my CANARY quoted pass","user":"bob"}`,
      "client_secret='CANARY single quoted'",
    ].join(" | ");
    const result = contractRows(
      "chutes",
      failedCheck(
        "Chutes",
        [message],
        [
          { key: "session_token", value: "CANARYsplit" },
          { key: "Set-Cookie", value: "a=CANARYheader" },
          { key: "apiKey", value: "CANARYkey" },
          { key: "token_expires_at", value: "2026-11-01T00:00:00.000Z" },
          { key: "api_key_source", value: "env" },
        ],
      ),
    );
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(result.debug.slice(0, 5)).toEqual([
      { key: "session_token", value: "[redacted]" },
      { key: "Set-Cookie", value: "[redacted]" },
      { key: "apiKey", value: "[redacted]" },
      { key: "token_expires_at", value: "2026-11-01T00:00:00.000Z" },
      { key: "api_key_source", value: "env" },
    ]);
  });

  it("hides email addresses and account, team, org, user and session ids in debug details", () => {
    const result = contractRows(
      "xai",
      failedCheck(
        "bob.CANARY@example.com",
        ["HTTP 401"],
        [
          { key: "account_id", value: "acct_CANARY1" },
          { key: "teamId", value: "CANARY2" },
          { key: "session_id", value: "s9" },
          { key: "connection", value: "alice.CANARY@example.co.uk" },
          { key: "request", value: 'org_id=CANARY4 "user_id":"CANARY5" accountId: 7' },
          { key: "account_count", value: "2" },
        ],
      ),
    );
    expect(JSON.stringify(result.debug)).not.toContain("CANARY");
    expect(result.debug).toEqual([
      { key: "account_id", value: "[id]" },
      { key: "teamId", value: "[id]" },
      { key: "session_id", value: "[id]" },
      { key: "connection", value: "[email]" },
      { key: "request", value: 'org_id=[id] "user_id":[id] accountId: [id]' },
      { key: "account_count", value: "2" },
      { key: "error", value: "[email]: HTTP 401" },
    ]);
  });

  it.each([
    {
      name: "a home path",
      home: "/Users/alice",
      value: "/Users/alice/.local/bin/claude",
      cutUnhidden: "/Users/ali",
      shown: "~/.local",
      hidden: "ali",
    },
    {
      name: "a JSON-quoted Windows home path",
      home: "C:\\Users\\Alice Smith",
      value: JSON.stringify("C:\\Users\\Alice Smith\\.local\\bin\\claude.exe"),
      cutUnhidden: '"C:\\\\Users\\\\Alic',
      shown: '"~\\\\.local',
      hidden: "Alic",
    },
    {
      name: "a Windows home path",
      home: "C:\\Users\\Alice Smith",
      value: "C:\\Users\\Alice Smith\\.local\\bin\\claude.exe",
      cutUnhidden: "C:\\Users\\Alic",
      shown: "~\\.local",
      hidden: "Alic",
    },
    {
      name: "an email address",
      home: "/Users/alice",
      value: "alice.smith@example.com",
      cutUnhidden: "alice.smith@exam",
      shown: "[email]",
      hidden: "smith",
    },
  ])("hides $name before it cuts a long detail", ({ home, value, cutUnhidden, shown, hidden }) => {
    vi.stubEnv("HOME", home);
    // Unhidden, the cut at 300 characters would keep `cutUnhidden`: part of the value.
    const filler = "1234567.".repeat(40).slice(0, 300 - " | ".length - cutUnhidden.length);
    const result = contractRows("anthropic", {
      ...answer(),
      debug: [{ key: "checked_commands", value: `${filler} | ${value}` }],
    });
    const [detail] = result.debug;
    expect(detail?.value.length).toBeLessThanOrEqual(300);
    expect(detail?.value).toContain(`${filler} | ${shown}`);
    expect(detail?.value).not.toContain(hidden);
  });
});

describe("rowsFromLegacyResult: the custom providers", () => {
  it("keys rows custom.<definition id>.<key>, takes the source label as account, maps ADR 0001 values", () => {
    const result = customRows([
      {
        kind: "percent",
        accounting: custom(),
        name: "Source One Monthly",
        group: "Source One",
        label: "Remaining:",
        right: "108/100",
        percentRemaining: -8,
        resetTimeIso: RESET,
      },
      {
        kind: "value",
        accounting: custom({ resultType: "balance" }),
        name: "Source One Balance",
        group: "Source One",
        value: "$12.00",
      },
      {
        accounting: custom({ resultType: "rate_limit" }),
        name: "Source One Requests",
        group: "Source One",
        percentRemaining: 40,
      },
      {
        kind: "value",
        accounting: custom({ resultType: "spend" }),
        name: "Source One Spent",
        group: "Source One",
        value: "$3.00",
      },
    ]);
    expect(summary(result.rows)).toEqual([
      ["quota-providers.custom.source-one.Monthly", "Source One", "Remaining", "month"],
      ["quota-providers.custom.source-one.Balance", "Source One", "Balance", null],
      ["quota-providers.custom.source-one.Requests", "Source One", "Requests", null],
      ["quota-providers.custom.source-one.Spent", "Source One", "Spent", null],
    ]);
    expect(result.rows.map((row) => row.type)).toEqual(["quota", "balance", "quota", "usage"]);
    expect(result.rows[0]).toEqual({
      id: "quota-providers.custom.source-one.Monthly",
      providerId: "quota-providers",
      account: "Source One",
      label: "Remaining",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      window: "month",
      prominence: "primary",
      percentRemaining: -8,
      resetsAt: RESET,
    });
    expect(result.rows[1]?.text).toBe("$12.00");
    expect(result.rowLogins).toEqual(["source-one", "source-one", "source-one", "source-one"]);
    expect(result.debug).toEqual([]);
  });

  it("drops entries it can't key and keeps the rest", () => {
    const result = customRows([
      { accounting: custom(), name: "Source One Daily", group: "Source One", percentRemaining: 5 },
      { accounting: custom({ sourceId: undefined }), name: "No Source", percentRemaining: 5 },
    ]);
    expect(result.rows.map((row) => row.id)).toEqual(["quota-providers.custom.source-one.Daily"]);
    expect(result.debug).toEqual([{ key: "dropped_row", value: "No Source: no row key" }]);

    // Only the custom providers still return entries; a built-in provider's are not read.
    const builtIn = rowsFromLegacyResult(
      "chutes",
      {
        attempted: true,
        entries: [{ accounting: custom(), name: "Chutes Daily", percentRemaining: 5 }],
        errors: [],
      },
      NOW_MS,
    );
    expect(builtIn.rows).toEqual([]);
    expect(builtIn.debug).toEqual([
      { key: "dropped_row", value: "Chutes Daily: unknown provider" },
    ]);
  });

  it("keeps a local window's start for the pace marker", () => {
    const [row] = customRows([
      {
        accounting: custom({ acquisitionMethod: "local_estimation" }),
        name: "Source One Weekly",
        group: "Source One",
        rowKey: "weekly",
        percentRemaining: 50,
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2026-10-04T00:00:00.000Z",
          observedAtIso: "2026-10-10T00:00:00.000Z",
          endsAtIso: RESET,
          fullReset: true,
        },
      },
    ]).rows;
    expect(row?.windowStartedAt).toBe("2026-10-04T00:00:00.000Z");
  });

  describe("custom sources through their real adapters", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** What the json-v1 adapter returns for `mappings`, stamped like the aggregate does. */
    async function remoteEntries(mappings: JsonV1Mapping[]): Promise<QuotaToastEntry[]> {
      const body = new Response("{}", { headers: { "content-type": "application/json" } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(body));
      const result = await fetchRemoteQuotaProvider(
        {
          id: "my-gateway",
          providerId: "gateway",
          label: "My Gateway",
          url: "https://gateway.example/quota",
          mode: "remote-api",
          format: "json-v1",
          adapter: { mappings },
        },
        "test-key",
      );
      if (!result.success) throw new Error(result.error);
      return result.entries.map((entry) => ({
        ...entry,
        accounting: { ...entry.accounting, sourceId: "my-gateway" },
      }));
    }

    it("gives remote rows no amounts: a pair may be remaining/limit or used/limit", async () => {
      const entries = await remoteEntries([
        {
          resultType: "quota",
          name: "Requests left",
          metric: { type: "remaining-limit", remaining: { literal: 30 }, limit: { literal: 100 } },
        },
        {
          resultType: "quota",
          name: "Requests used",
          metric: { type: "used-limit", used: { literal: 70 }, limit: { literal: 100 } },
        },
        {
          resultType: "budget",
          name: "Budget left",
          unit: "$",
          unitPosition: "prefix",
          metric: { type: "remaining-budget", remaining: { literal: 3 }, budget: { literal: 10 } },
        },
      ]);
      expect(entries.map((entry) => entry.right)).toEqual(["30/100", "70/100", "$3/$10"]);

      const result = customRows(entries);
      expect(result.rows.map((row) => [row.id, row.percentRemaining])).toEqual([
        ["quota-providers.custom.my-gateway.Requests_left", 30],
        ["quota-providers.custom.my-gateway.Requests_used", 30],
        ["quota-providers.custom.my-gateway.Budget_left", 30],
      ]);
      for (const row of result.rows) {
        expect(row).not.toHaveProperty("used");
        expect(row).not.toHaveProperty("limit");
        expect(row).not.toHaveProperty("remaining");
      }
    });

    it("keys remote mappings apart by name, also names without ASCII letters", async () => {
      const mapping = (name: string, percentage: number): JsonV1Mapping => ({
        resultType: "quota",
        name,
        metric: { type: "percentage", percentage: { literal: percentage }, meaning: "remaining" },
      });
      const entries = await remoteEntries([
        mapping("Daily limit", 10),
        mapping("Daily-limit", 20),
        mapping("日次上限", 30),
        mapping("月次上限", 40),
      ]);
      const result = customRows(entries);
      const ids = result.rows.map((row) => row.id);
      expect(result.rows.map((row) => row.percentRemaining)).toEqual([10, 20, 30, 40]);
      expect(ids.slice(0, 2)).toEqual([
        "quota-providers.custom.my-gateway.Daily_limit",
        "quota-providers.custom.my-gateway.Daily-limit",
      ]);
      expect(new Set(ids).size).toBe(4);
      expect(result.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
      // The same name always gives the same id.
      const again = customRows(await remoteEntries([mapping("日次上限", 50)]));
      expect(again.rows[0]?.id).toBe(ids[2]);
    });

    function localDefinition(
      windows: LocalEstimateQuotaProviderDefinition["windows"],
    ): LocalEstimateQuotaProviderDefinition {
      return {
        id: "private-gateway",
        providerId: "private-gateway",
        label: "Private Gateway",
        mode: "local-estimate",
        windows,
      };
    }

    function localRows(definition: LocalEstimateQuotaProviderDefinition) {
      const { entries } = computeLocalQuotaProviderEstimate({
        definition,
        state: {
          version: 1,
          definitionId: definition.id,
          providerId: definition.providerId,
          updatedAt: NOW_MS,
          messages: [],
        },
        nowMs: NOW_MS,
      });
      return customRows(entries).rows;
    }

    it("keys local windows by their ids and reads their used requests and dollars", () => {
      const rows = localRows(
        localDefinition([
          { id: "daily", label: "Daily", type: "utc-day", requestLimit: 10, usdBudget: 5 },
          { id: "hourly", label: "Daily", type: "rolling", durationMinutes: 60, requestLimit: 4 },
        ]),
      );
      const requests = (decimal: string) => ({
        decimal,
        unit: { kind: "count", unit: "request" },
      });
      expect(rows.map((row) => [row.id, row.label, row.used, row.limit])).toEqual([
        ["quota-providers.custom.private-gateway.daily", "Daily", requests("0"), requests("10")],
        ["quota-providers.custom.private-gateway.daily_budget", "Daily budget", usd("0"), usd("5")],
        ["quota-providers.custom.private-gateway.hourly", "Daily", requests("0"), requests("4")],
      ]);

      // Renaming a window keeps its row id, so hide/rename/order settings still apply.
      const renamed = localRows(
        localDefinition([
          { id: "daily", label: "Per day", type: "utc-day", requestLimit: 10, usdBudget: 5 },
        ]),
      );
      expect(renamed.map((row) => row.id)).toEqual([
        "quota-providers.custom.private-gateway.daily",
        "quota-providers.custom.private-gateway.daily_budget",
      ]);
    });
  });

  it("keeps each custom definition's check under its whole name, without its URL or key", () => {
    vi.stubEnv("HOME", "/Users/alice");
    const identity = { providerId: "gateway", modelIds: null, apiKeyEnv: null, selected: true };
    const result = rowsFromLegacyResult(
      "quota-providers",
      {
        attempted: true,
        entries: [],
        errors: [{ label: "Team", message: "HTTP 503" }],
        diagnostics: [
          {
            ...identity,
            sourceId: "production-gateway-us",
            mode: "remote-api",
            format: "json-v1",
            apiKeyEnv: "TEAM_KEY",
            attempted: true,
            credentialSource: "explicit_env",
            outcome: "http_error",
            httpStatus: 503,
            entryCount: 0,
            checkedPaths: ["/Users/alice/.config/opencode/opencode.json"],
            credentialDatabasePaths: ["/Users/alice/.local/share/opencode/opencode.db"],
          },
          {
            ...identity,
            sourceId: "seats",
            mode: "local-estimate",
            attempted: true,
            credentialSource: null,
            outcome: "success",
            entryCount: 1,
            checkedPaths: [],
            credentialDatabasePaths: [],
            statePath:
              "/Users/alice/.local/state/opencode/opencode-quota/quota-providers/seats.json",
            stateHealth: "healthy",
            stateVersion: 1,
            stateLastUpdatedAt: NOW_MS,
          },
        ],
      },
      NOW_MS,
    );
    expect(result.debug).toEqual([
      {
        key: "custom_production-gateway-us_check",
        value:
          "outcome=http_error http_status=503 credential_source=explicit_env checked_paths=~/.config/opencode/opencode.json | ~/.local/share/opencode/opencode.db",
      },
      {
        key: "custom_seats_check",
        value: `outcome=success state_health=healthy state_version=1 state_last_update=${new Date(NOW_MS).toISOString()}`,
      },
      { key: "error", value: "Team: HTTP 503" },
    ]);
  });

  it("scrubs control characters from custom text", () => {
    const [row] = customRows([
      {
        kind: "value",
        accounting: custom({ sourceId: "src" }),
        name: "Evil\u001b[31m Note",
        group: "Evil\u001b[31m",
        value: "red\u001b[0m text\nnext",
      },
    ]).rows;
    expect(row?.account).toBe("Evil");
    expect(row?.text).toBe("red text next");
  });
});

describe("accountFromGroup", () => {
  it.each([
    ["openai", "OpenAI", undefined],
    ["openai", "OpenAI (Business)", "Business"],
    ["openai", "[OpenAI] (active)", undefined],
    ["openai", "[OpenAI Work 2] (Business)", "Work 2 (Business)"],
    ["anthropic", "[Claude Work] (active)", "Work"],
    ["copilot", "Copilot (personal)", "personal"],
    ["google-agy", "AGY (Account 2)", "Account 2"],
    ["kimi-code-plan-cn", "[Kimi Code (CN) Work]", "Work"],
    ["xiaomi", "Xiaomi MiMo: standard_monthly", "standard_monthly"],
    ["quota-providers", "Team Gateway (active)", "Team Gateway"],
    ["chutes", undefined, undefined],
  ] as const)("%s %s → %s", (providerId, group, account) => {
    expect(accountFromGroup(providerId, group)).toBe(account);
  });
});
