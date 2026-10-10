import { beforeEach, describe, expect, it, vi } from "vitest";
import { rowsFromLegacyResult } from "../src/core/rows.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";
import { hasOpenAIOAuthCached, queryOpenAIQuota } from "../src/lib/openai.js";
import { type CredentialRow, readCredentialRows } from "../src/lib/opencode-auth.js";
import { quotaReportLines } from "../src/lib/quota-dialog-commands.js";
import { openaiProvider } from "../src/providers/openai.js";
import { expectNotAttempted, visibleEntries } from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/openai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/openai.js")>()),
  hasOpenAIOAuthCached: vi.fn(),
  queryOpenAIQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));

const readRows = vi.mocked(readCredentialRows);
const query = vi.mocked(queryOpenAIQuota);

function oauthRow(id: string, overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id,
    integrationId: "openai",
    label: "default",
    active: false,
    value: { type: "oauth", access: "token" },
    ...overrides,
  };
}

function keyRow(id: string, overrides: Partial<CredentialRow> = {}): CredentialRow {
  return oauthRow(id, { value: { type: "api", key: "sk-test" }, ...overrides });
}

function hourlyQuota(label: string) {
  return { success: true as const, label, windows: { hourly: { percentRemaining: 42 } } };
}

async function fetchRows(rows: CredentialRow[], config: Record<string, unknown> = {}) {
  readRows.mockResolvedValueOnce(rows);
  return openaiProvider.fetch({ config } as never);
}

function groupsAndSources(out: QuotaProviderResult) {
  return out.entries.map((entry) => [entry.group, entry.accounting.sourceId]);
}

/** The quota lines `opencode-quota show` prints for this result. */
function quotaCommandText(out: QuotaProviderResult): string {
  const { rows } = rowsFromLegacyResult("openai", out);
  const provider = { providerId: "openai", label: "OpenAI", rows, refreshing: false, debug: [] };
  const snapshot = {
    version: 6 as const,
    providers: [provider],
    resetNotices: [],
    generatedAtMs: 0,
  };
  return quotaReportLines(snapshot, 0).join("\n");
}

beforeEach(() => {
  readRows.mockReset().mockResolvedValue([]);
  query.mockReset();
  vi.mocked(hasOpenAIOAuthCached).mockReset().mockResolvedValue(false);
});

describe("openai provider", () => {
  it("returns attempted:false without a stored login", async () => {
    const out = await fetchRows([]);

    expectNotAttempted(out);
    expect(query).not.toHaveBeenCalled();
    expect(out.statusDetails).toEqual([
      { key: "auth_configured", value: "false" },
      { key: "auth_source", value: "(none)" },
      { key: "auth_method", value: "(none)" },
      { key: "token_status", value: "(none)" },
      { key: "token_expires_at", value: "(none)" },
    ]);
  });

  it("queries and labels every stored login independently", async () => {
    query.mockResolvedValue({
      success: true,
      label: "OpenAI (Business)",
      windows: {
        hourly: { percentRemaining: 42, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 80, resetTimeIso: "2026-01-07T00:00:00.000Z" },
        monthly: { percentRemaining: 67, resetTimeIso: "2026-02-01T00:00:00.000Z" },
        codeReview: { percentRemaining: 55, resetTimeIso: "2026-01-02T00:00:00.000Z" },
      },
    });

    const out = await fetchRows(
      [
        oauthRow("active-id", {
          label: "Work",
          active: true,
          value: { type: "oauth", access: "a" },
        }),
        oauthRow("other-id", { label: "Work", value: { type: "oauth", access: "o" } }),
      ],
      { requestTimeoutMs: 12000 },
    );

    expect(query.mock.calls.map(([options]) => options)).toEqual([
      {
        requestTimeoutMs: 12000,
        auth: { state: "configured", sourceKey: "openai", accessToken: "a" },
        loginLabel: "Work",
      },
      {
        requestTimeoutMs: 12000,
        auth: { state: "configured", sourceKey: "openai", accessToken: "o" },
        loginLabel: "Work",
      },
    ]);
    expect(out.errors).toEqual([]);
    const group = "[OpenAI Work] (Business) (active)";
    expect(
      visibleEntries(out.entries, "openai")
        .slice(0, 4)
        .map(({ name, label, percentRemaining, resetTimeIso }) => [
          name,
          label,
          percentRemaining,
          resetTimeIso,
        ]),
    ).toEqual([
      [`${group} 5h`, "5h:", 42, "2026-01-01T00:00:00.000Z"],
      [`${group} Weekly`, "Weekly:", 80, "2026-01-07T00:00:00.000Z"],
      [`${group} Monthly`, "Monthly:", 67, "2026-02-01T00:00:00.000Z"],
      [`${group} Code Review`, "Code Review:", 55, "2026-01-02T00:00:00.000Z"],
    ]);
    expect(out.entries.at(-1)?.accounting.resultType).toBe("rate_limit");
    expect(groupsAndSources(out)).toEqual([
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
    ]);
  });

  it("shows a login OpenCode could not return as its own error row next to working ones", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/openai.js")>("../src/lib/openai.js");
    query
      .mockImplementationOnce(actual.queryOpenAIQuota)
      .mockResolvedValueOnce(hourlyQuota("OpenAI (Pro)"));

    const out = await fetchRows([
      oauthRow("work-id", {
        label: "Work",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 400",
      }),
      oauthRow("home-id", { label: "Home", value: { type: "oauth", access: "home-token" } }),
    ]);

    expect(readRows).toHaveBeenLastCalledWith(["openai", "codex", "chatgpt"], {
      methods: ["oauth", "key"],
    });
    expect(out.errors).toEqual([
      {
        label: "[OpenAI Work] (active)",
        message:
          "OpenAI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth logout openai Work`, then `opencode auth login openai`.",
      },
    ]);
    expect(groupsAndSources(out)).toEqual([["[OpenAI Home] (Pro)", "home-id"]]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "failed" },
      ]),
    );
  });

  it("reports a stored API key without querying ChatGPT, on /quota", async () => {
    const out = await fetchRows([keyRow("key-id", { label: "Key", active: true })]);

    expect(query).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([]);
    expect(visibleEntries(out.entries, "openai")).toEqual([
      {
        kind: "value",
        name: "[OpenAI Key]",
        group: "[OpenAI Key]",
        value: "ChatGPT quota unavailable for API key",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "api key" },
        { key: "token_expires_at", value: "(none)" },
      ]),
    );

    // Narrow dialogs wrap the sentence; collapsing whitespace keeps the phrase checkable.
    const collapsed = quotaCommandText(out).replace(/\s+/gu, " ");
    expect(collapsed).toContain("OpenAI (Key)");
    expect(collapsed).toContain("ChatGPT quota unavailable for API key");
  });

  it("reports a Sign in with ChatGPT login without querying ChatGPT (#316)", async () => {
    const expires = Date.now() + 60 * 60_000;
    const out = await fetchRows([
      oauthRow("sharing-id", {
        label: "OpenAI",
        active: true,
        value: {
          type: "oauth",
          methodID: "chatgpt-token-sharing",
          access: "a.b.c",
          refresh: "refresh",
          expires,
        },
      }),
    ]);

    expect(query).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([]);
    expect(visibleEntries(out.entries, "openai")).toEqual([
      {
        kind: "value",
        name: "[OpenAI]",
        group: "[OpenAI]",
        value: "ChatGPT quota unavailable for Sign in with ChatGPT",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "auth_method", value: "chatgpt-token-sharing" },
        { key: "token_status", value: "valid" },
        { key: "token_expires_at", value: new Date(expires).toISOString() },
      ]),
    );
  });

  it("shows an active API key next to an inactive OAuth account with one ChatGPT query", async () => {
    query.mockResolvedValueOnce(hourlyQuota("OpenAI (Pro)"));

    const out = await fetchRows([
      keyRow("key-id", { label: "API key", active: true }),
      oauthRow("oauth-id", { label: "Work" }),
    ]);

    expect(query.mock.calls.map(([options]) => options.auth)).toEqual([
      { state: "configured", sourceKey: "openai", accessToken: "token" },
    ]);
    expect(out.errors).toEqual([]);
    expect(groupsAndSources(out)).toEqual([
      ["[OpenAI] (active)", "key-id"],
      ["[OpenAI Work] (Pro)", "oauth-id"],
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "api key" },
      ]),
    );
  });

  it.each([
    true,
    false,
  ])("lists the active API-key account first among mixed credentials (key first: %s)", async (keyFirst) => {
    const key = keyRow("key-id", { label: "API key", active: true });
    const oauth = oauthRow("oauth-id", { label: "OAuth" });
    query.mockResolvedValueOnce({
      success: true,
      label: "OpenAI",
      windows: { hourly: { percentRemaining: 42 }, weekly: { percentRemaining: 74 } },
    });

    const out = await fetchRows(keyFirst ? [key, oauth] : [oauth, key]);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "key-id",
      "oauth-id",
      "oauth-id",
    ]);
  });

  it.each([
    { config: { currentModel: "codex/gpt-5-codex" }, firstId: "oauth-id" },
    {
      config: { currentProviderID: "codex", currentModel: "gpt-5-codex" },
      firstId: "oauth-id",
    },
    { config: { currentProviderID: "codex" }, firstId: "oauth-id" },
    {
      config: { currentProviderID: "openai", currentModel: "codex/gpt-5-codex" },
      firstId: "key-id",
    },
    // Unknown session (e.g. onlyCurrentModel off): the OAuth login with quota numbers goes first.
    { config: {}, firstId: "oauth-id" },
  ])("prefers the session's active integration when OpenAI and Codex are both active ($config)", async ({
    config,
    firstId,
  }) => {
    query.mockResolvedValueOnce(hourlyQuota("OpenAI"));

    const out = await fetchRows(
      [
        keyRow("key-id", { label: "API key", active: true }),
        oauthRow("oauth-id", { integrationId: "codex", label: "Work", active: true }),
      ],
      config,
    );

    const expectedIds = firstId === "oauth-id" ? ["oauth-id", "key-id"] : ["key-id", "oauth-id"];
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(expectedIds);
    expect(query).toHaveBeenCalledOnce();
    expect(out.errors).toEqual([]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_source", value: firstId === "oauth-id" ? "codex" : "openai" },
        { key: "token_status", value: firstId === "oauth-id" ? "valid" : "api key" },
      ]),
    );
  });

  it("keeps other active rows and inactive rows in source order after the session's active row", async () => {
    const out = await fetchRows(
      [
        { id: "inactive-openai", integrationId: "openai", active: false },
        { id: "active-openai", integrationId: "openai", active: true },
        { id: "inactive-codex", integrationId: "codex", active: false },
        { id: "active-chatgpt", integrationId: "chatgpt", active: true },
        { id: "active-codex", integrationId: "codex", active: true },
      ].map((row) => keyRow(row.id, { ...row, label: row.id })),
      { currentProviderID: "codex" },
    );

    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "active-codex",
      "active-openai",
      "active-chatgpt",
      "inactive-openai",
      "inactive-codex",
    ]);
  });

  it.each([
    {
      labels: ["API key", "default", "OpenAI"],
      names: ["[OpenAI] (active)", "[OpenAI 2]", "[OpenAI 3]"],
    },
    { labels: ["", "API key"], names: ["[OpenAI]", "[OpenAI 2]"], noneActive: true },
    // An explicit numeric alias stays separate from the numbered unnamed accounts.
    {
      labels: ["API key", "default", "2"],
      names: ["[OpenAI] (active)", "[OpenAI 3]", "[OpenAI 2]"],
    },
  ])("keeps unnamed API-key accounts distinct on /quota ($labels)", async ({
    labels,
    names,
    noneActive,
  }) => {
    const out = await fetchRows(
      labels.map((label, index) =>
        keyRow(`key-${index}`, { label, active: !noneActive && index === 0 }),
      ),
    );

    expect(query).not.toHaveBeenCalled();
    expect(out.entries.map((entry) => entry.name)).toEqual(names);
    expect(out.entries.map((entry) => entry.group)).toEqual(names);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(
      labels.map((_, index) => `key-${index}`),
    );
    // One line per account, each named differently ("OpenAI", "OpenAI (2)", …).
    const lines = quotaCommandText(out).split("\n");
    expect(lines).toHaveLength(labels.length);
    expect(new Set(lines.map((line) => line.split(" Status")[0]!.trim())).size).toBe(labels.length);
    for (const line of lines) expect(line).toContain("ChatGPT quota unavailable for API key");
    expect(out.entries.map((entry) => (entry as { value?: string }).value)).toEqual(
      labels.map(() => "ChatGPT quota unavailable for API key"),
    );
  });

  it("reports unknown active auth when no stored row is marked active", async () => {
    const out = await fetchRows([
      keyRow("key-id", { label: "Key" }),
      oauthRow("oauth-id", {
        label: "Work",
        value: { type: "oauth", access: "token", expires: Date.now() + 60_000 },
      }),
    ]);

    expect(out.attempted).toBe(true);
    expect(out.statusDetails).toEqual([
      { key: "auth_configured", value: "true" },
      { key: "auth_source", value: "unknown" },
      { key: "auth_method", value: "unknown" },
      { key: "token_status", value: "unknown" },
      { key: "token_expires_at", value: "unknown" },
    ]);
  });

  it("shows an API key OpenCode could not read as an auth error", async () => {
    const out = await fetchRows([
      keyRow("key-id", {
        label: "Key",
        active: true,
        value: { type: "api" },
        resolveError: "refresh_failed: HTTP 400",
      }),
    ]);

    expect(query).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "[OpenAI Key]",
        message: "OpenAI API key could not be read: refresh_failed: HTTP 400",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "token_status", value: "failed" },
      ]),
    );
  });

  it.each([
    { providerIds: ["openai"], expected: true },
    { providerIds: ["chatgpt"], expected: true },
    { providerIds: ["codex"], expected: true },
    { providerIds: ["opencode"], expected: false },
    { providerIds: ["zai"], expected: false },
    // Without an OpenAI provider id, a stored OAuth login or API key still counts.
    { providerIds: ["zai"], oauth: true, expected: true },
    { providerIds: ["zai"], keyRows: [keyRow("key-id", { active: true })], expected: true },
    // Provider lookup failure falls back to available.
    { providersError: new Error("boom"), expected: true },
  ])("isAvailable is $expected for $providerIds (oauth: $oauth)", async ({
    providerIds,
    providersError,
    oauth,
    keyRows,
    expected,
  }) => {
    vi.mocked(hasOpenAIOAuthCached).mockResolvedValue(Boolean(oauth));
    readRows.mockResolvedValue(keyRows ?? []);

    await expect(
      openaiProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds, providersError }),
      ),
    ).resolves.toBe(expected);
    if (keyRows) {
      expect(readRows).toHaveBeenLastCalledWith(["openai", "codex", "chatgpt"], {
        methods: ["key"],
        firstOnly: true,
      });
    }
  });
});
