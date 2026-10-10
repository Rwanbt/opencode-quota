import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  JsonV1Mapping,
  RemoteApiQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";
import {
  fetchRemoteQuotaProvider,
  QUOTA_PROVIDER_MAX_BODY_BYTES,
} from "../src/lib/quota-providers-remote.js";
import {
  NEURALWATT_LIKE_ADAPTER,
  NEURALWATT_LIKE_RESPONSE,
} from "./fixtures/quota-provider-json-v1.js";

type JsonV1Source = Extract<RemoteApiQuotaProviderDefinition, { format: "json-v1" }>;

function source(
  overrides: Partial<RemoteApiQuotaProviderDefinition> = {},
): RemoteApiQuotaProviderDefinition {
  return {
    id: "source-one",
    providerId: "provider-one",
    label: "Source One",
    url: "https://provider.example/accounting",
    mode: "remote-api",
    format: "quota-v1",
    ...overrides,
  };
}

const OPENROUTER = source({ format: "openrouter-key-v1" });

function jsonSource(adapter: JsonV1Source["adapter"] = NEURALWATT_LIKE_ADAPTER): JsonV1Source {
  return {
    id: "json-source",
    providerId: "provider-one",
    label: "JSON Source",
    url: "https://provider.example/quota",
    mode: "remote-api",
    format: "json-v1",
    adapter,
  };
}

/** One json-v1 mapping per metric, so each table row stays one line. */
function mappings(...metrics: JsonV1Mapping["metric"][]): JsonV1Source["adapter"] {
  return {
    mappings: metrics.map((metric) => ({ resultType: "usage", name: "Usage", metric })),
  };
}

function usedValue(path = "used"): JsonV1Mapping["metric"] {
  return { type: "value", valueType: "used", value: { path: [path] } };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Stubs fetch with one JSON body and runs the source against it. */
function fetchBody(body: unknown, definition = source()) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
  return fetchRemoteQuotaProvider(definition, "secret");
}

/** A json-v1 body nested `levels` objects deep around `{ used: 1 }`. */
function nested(levels: number): unknown {
  let body: unknown = { used: 1 };
  for (let index = 0; index < levels; index += 1) body = { nested: body };
  return body;
}

function remoteAccounting(resultType: string) {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "user_configured",
    authority: "provider_reported",
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("quota provider remote transport", () => {
  const json = { "content-type": "application/json" };
  const reply = (body: string | null, init: ResponseInit) => () => new Response(body, init);
  it.each([
    [
      "redirect",
      reply(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      "Redirect rejected",
    ],
    [
      "non-json",
      reply("ok", { headers: { "content-type": "text/plain" } }),
      "Expected a JSON response",
    ],
    [
      "invalid-json",
      reply("{", { headers: { "content-type": "application/problem+json" } }),
      "Invalid JSON response",
    ],
    [
      "HTTP error",
      reply("private response", { status: 401, headers: { "content-type": "text/plain" } }),
      "HTTP 401",
    ],
    [
      "network error",
      () => Promise.reject(new Error("https://internal.example/?token=secret failed")),
      "Failed to read accounting data",
    ],
    [
      "oversized Content-Length",
      reply("{}", {
        headers: { ...json, "content-length": String(QUOTA_PROVIDER_MAX_BODY_BYTES + 1) },
      }),
      "Response exceeded 262144 bytes",
    ],
    [
      "oversized body",
      reply("x".repeat(QUOTA_PROVIDER_MAX_BODY_BYTES + 1), { headers: json }),
      "Response exceeded 262144 bytes",
    ],
  ])("rejects %s responses with a fixed message", async (_name, respond, error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => respond()),
    );
    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
      success: false,
      error,
    });
  });

  it.each([
    [
      "before headers",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(abortError()));
        }),
    ],
    [
      "while reading the body",
      (_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener("abort", () => controller.error(abortError()));
              },
            }),
            { headers: json },
          ),
        ),
    ],
  ])("uses the configured timeout %s and never retries", async (_name, implementation) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(implementation);
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchRemoteQuotaProvider(source(), "secret", 10);
    await vi.advanceTimersByTimeAsync(11);

    await expect(pending).resolves.toEqual({
      success: false,
      error: "Request timeout after 0s",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("quota-v1", () => {
  it("maps strict percent and value rows with local metadata and grouping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        version: "quota-v1",
        entries: [
          {
            kind: "percent",
            name: "Monthly",
            resultType: "quota",
            percentRemaining: -8,
            label: "Remaining:",
            right: "108/100",
          },
          { kind: "value", name: "Balance", resultType: "balance", value: "$12.00" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRemoteQuotaProvider(source(), "secret")).resolves.toEqual({
      success: true,
      entries: [
        {
          accounting: remoteAccounting("quota"),
          kind: "percent",
          name: "Source One Monthly",
          group: "Source One",
          label: "Remaining:",
          right: "108/100",
          percentRemaining: -8,
        },
        {
          accounting: remoteAccounting("balance"),
          kind: "value",
          name: "Source One Balance",
          group: "Source One",
          value: "$12.00",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      source().url,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: { Authorization: "Bearer secret", Accept: "application/json" },
      }),
    );
  });

  it("sanitizes and bounds remote display text", async () => {
    const result = await fetchBody({
      version: "quota-v1",
      entries: [
        {
          kind: "value",
          name: "  Usage\u001b[31m  ",
          resultType: "usage",
          value: "  12\u0007 tokens  ",
          label: "  Used\u001b[31m:  ",
          right: "  12\u0007/100  ",
        },
      ],
    });
    expect(result.success && result.entries[0]).toEqual(
      expect.objectContaining({
        name: "Source One Usage",
        label: "Used:",
        right: "12/100",
        value: "12 tokens",
      }),
    );
  });

  const percentRow = {
    kind: "percent",
    name: "Monthly",
    resultType: "quota",
    percentRemaining: 42,
  };
  const valueRow = { kind: "value", name: "Usage", resultType: "usage", value: "1" };
  const exactBoundsRow = {
    kind: "value",
    name: "n".repeat(80),
    resultType: "usage",
    value: "v".repeat(160),
    label: "l".repeat(80),
    right: "r".repeat(80),
  };

  it.each([
    [
      "exactly 100 rows",
      Array.from({ length: 100 }, (_, i) => ({ ...valueRow, name: `Usage ${i}` })),
    ],
    ["exact display bounds", [exactBoundsRow]],
  ])("accepts %s", async (_name, entries) => {
    const result = await fetchBody({ version: "quota-v1", entries });
    expect(result.success && result.entries).toHaveLength(entries.length);
  });

  const quotaV1 = (...entries: unknown[]) => ({ version: "quota-v1", entries });
  it.each([
    ["unknown envelope fields", { ...quotaV1(), extra: true }],
    ["unknown row fields", quotaV1({ ...percentRow, group: "remote-owned" })],
    ["numeric strings", quotaV1({ ...percentRow, percentRemaining: "42" })],
    ["empty rows", quotaV1()],
    ["percent above 100", quotaV1({ ...percentRow, percentRemaining: 100.01 })],
    ["too many rows", quotaV1(...Array.from({ length: 101 }, () => valueRow))],
    ["percent rows for spend", quotaV1({ ...percentRow, resultType: "spend" })],
    ["an overlong name", quotaV1({ ...exactBoundsRow, name: "x".repeat(81) })],
    ["an overlong value", quotaV1({ ...exactBoundsRow, value: "x".repeat(161) })],
    ["an overlong label", quotaV1({ ...exactBoundsRow, label: "x".repeat(81) })],
    ["an overlong right", quotaV1({ ...exactBoundsRow, right: "x".repeat(161) })],
  ])("rejects the complete response for %s", async (_name, body) => {
    await expect(fetchBody(body)).resolves.toEqual({
      success: false,
      error: "Invalid quota-v1 response",
    });
  });
});

describe("openrouter-key-v1", () => {
  it("maps a positive limit to a budget percent row", async () => {
    await expect(
      fetchBody({ data: { usage: 2, limit: 10, limit_remaining: 8 } }, OPENROUTER),
    ).resolves.toEqual({
      success: true,
      entries: [
        {
          accounting: remoteAccounting("budget"),
          kind: "percent",
          name: "Source One budget",
          group: "Source One",
          label: "Budget:",
          right: "$2.00/$10.00",
          percentRemaining: 80,
        },
      ],
    });
  });

  it.each([
    [
      "limit-window usage when lifetime usage exceeds it",
      { usage: 140.7, limit: 100, limit_remaining: 87.459170905 },
      { right: "$12.54/$100.00", percentRemaining: 87.459170905 },
    ],
    [
      "lifetime usage when no limit window is reported",
      { usage: 13, limit: 100 },
      { right: "$13.00/$100.00" },
    ],
    ["derived remaining", { usage: 2, limit: 10 }, { percentRemaining: 80 }],
    [
      "explicit negative remaining without clamping",
      { usage: 12, limit: 10, limit_remaining: -2 },
      { right: "$12.00/$10.00", percentRemaining: -20 },
    ],
    [
      "derived negative remaining without clamping",
      { usage: 12, limit: 10 },
      { right: "$12.00/$10.00", percentRemaining: -20 },
    ],
  ])("shows %s in the budget row", async (_name, data, expected) => {
    await expect(fetchBody({ data }, OPENROUTER)).resolves.toEqual({
      success: true,
      entries: [expect.objectContaining({ kind: "percent", ...expected })],
    });
  });

  it.each([
    [{ usage: 2, limit: undefined }, "$2.00"],
    [{ usage: 2, limit: null }, "$2.00"],
    [{ usage: 2, limit: 0 }, "$2.00"],
    [{ usage: 0.106921435, limit: null, limit_remaining: null }, "$0.11"],
  ])("maps %j to a spend value", async (data, value) => {
    await expect(fetchBody({ data }, OPENROUTER)).resolves.toEqual({
      success: true,
      entries: [
        {
          accounting: remoteAccounting("spend"),
          kind: "value",
          name: "Source One spend",
          group: "Source One",
          label: "Spend:",
          value,
        },
      ],
    });
  });

  // Raw JSON text, so non-finite numbers such as 1e400 reach the parser.
  it.each([
    ["missing usage", '{"data":{"limit":10}}'],
    ["negative usage", '{"data":{"usage":-1,"limit":null}}'],
    ["negative limit", '{"data":{"usage":2,"limit":-1}}'],
    ["numeric usage", '{"data":{"usage":"2","limit":10}}'],
    ["numeric limit", '{"data":{"usage":2,"limit":"10"}}'],
    ["numeric remaining", '{"data":{"usage":2,"limit":10,"limit_remaining":"8"}}'],
    ["remaining above the limit", '{"data":{"usage":0,"limit":10,"limit_remaining":11}}'],
    [
      "null remaining for a positive limit",
      '{"data":{"usage":2,"limit":10,"limit_remaining":null}}',
    ],
    ["non-finite usage", '{"data":{"usage":1e400,"limit":10,"limit_remaining":8}}'],
    ["non-finite limit", '{"data":{"usage":2,"limit":1e400,"limit_remaining":8}}'],
    ["non-finite remaining", '{"data":{"usage":2,"limit":10,"limit_remaining":1e400}}'],
  ])("rejects %s", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } })),
    );
    await expect(fetchRemoteQuotaProvider(OPENROUTER, "secret")).resolves.toEqual({
      success: false,
      error: "Invalid openrouter-key-v1 response",
    });
  });
});

describe("json-v1", () => {
  it("maps the sanitized Neuralwatt-like fixture with zero, units, timestamps, and partial errors", async () => {
    const result = await fetchBody(NEURALWATT_LIKE_RESPONSE, jsonSource());
    if (!result.success) throw new Error(result.error);

    expect(result.entries).toHaveLength(21);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "JSON Source Tokens",
          percentRemaining: 100,
          right: "0/10 tokens",
          resetTimeIso: "2026-07-31T22:00:00.000Z",
          accounting: expect.objectContaining({
            observedAtIso: new Date(1_784_678_400_000).toISOString(),
          }),
        }),
        expect.objectContaining({ name: "JSON Source Used percent", percentRemaining: -25 }),
        expect.objectContaining({
          name: "JSON Source Spend budget",
          percentRemaining: -20,
          right: "$30/$25",
        }),
        expect.objectContaining({ name: "JSON Source Balance", value: "$-3.5" }),
        expect.objectContaining({ name: "JSON Source Status", value: "Ready" }),
      ]),
    );
    expect(result.rowErrors).toHaveLength(15);
    expect(result.rowErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("did not resolve to a valid timestamp at row 2"),
        expect.stringContaining("was null at row 2"),
        expect.stringContaining("was missing at row 2"),
        expect.stringContaining("had wrong type at row 2"),
        expect.stringContaining("requires an object row at row 3"),
      ]),
    );
  });

  it("supports object and array roots, literals, and all numeric value variants", async () => {
    const adapter: JsonV1Source["adapter"] = {
      mappings: [
        { resultType: "usage", name: "Used", metric: usedValue() },
        {
          resultType: "quota",
          name: "Limit",
          metric: { type: "value", valueType: "limit", value: { path: ["limit"] } },
        },
        {
          resultType: "quota",
          name: "Remaining",
          metric: { type: "value", valueType: "remaining", value: { path: ["remaining"] } },
        },
        {
          resultType: "quota",
          name: "Literal percent",
          resetTime: { literal: 0, encoding: "unix-milliseconds" },
          metric: { type: "percentage", percentage: { literal: -5 }, meaning: "remaining" },
        },
        {
          resultType: "status",
          name: "Literal status",
          metric: { type: "status", value: { literal: "Ready" } },
        },
      ],
    };

    for (const body of [
      { used: 0, limit: 10, remaining: -2 },
      [
        { used: 0, limit: 10, remaining: -2 },
        { used: 2, limit: 10, remaining: 8 },
      ],
    ]) {
      const result = await fetchBody(body, jsonSource(adapter));
      expect(result.success && result.entries.slice(0, 5)).toEqual([
        expect.objectContaining({ value: "0" }),
        expect.objectContaining({ value: "10" }),
        expect.objectContaining({ value: "-2" }),
        expect.objectContaining({ percentRemaining: -5, resetTimeIso: "1970-01-01T00:00:00.000Z" }),
        expect.objectContaining({ value: "Ready" }),
      ]);
    }
  });

  it("fails safely when no candidate succeeds without exposing response data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ value: "SUPER_SECRET_BODY_VALUE" })),
    );
    const result = await fetchRemoteQuotaProvider(
      jsonSource(mappings(usedValue("value"))),
      "secret-key",
    );
    expect(result).toEqual({
      success: false,
      error: "Invalid json-v1 response: adapter.mappings[0].metric.value had wrong type at row 0",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SUPER_SECRET_BODY_VALUE|secret-key|provider\.example/,
    );
  });

  it.each([
    ["95.50", "450", ["95.5 USD", "4.5"]],
    [" -3 ", "0", ["-3 USD", "0"]],
    ["0.25", 450, ["0.25 USD", "4.5"]],
  ] as const)("reads plain decimal text %j as a number", async (balance, totalUsed, expected) => {
    const adapter: JsonV1Source["adapter"] = {
      mappings: [
        {
          resultType: "balance",
          name: "Balance",
          unit: "USD",
          unitPosition: "suffix",
          metric: { type: "value", valueType: "balance", value: { path: ["balance"] } },
        },
        {
          resultType: "spend",
          name: "Spend",
          metric: {
            type: "value",
            valueType: "spend",
            value: { path: ["total_used"], divideBy: 100 },
          },
        },
      ],
    };
    await expect(
      fetchBody({ balance, total_used: totalUsed }, jsonSource(adapter)),
    ).resolves.toEqual({
      success: true,
      entries: [
        expect.objectContaining({ name: "JSON Source Balance", value: expected[0] }),
        expect.objectContaining({ name: "JSON Source Spend", value: expected[1] }),
      ],
    });
  });

  it.each([
    ...["95.50 USD", "1e3", "", "  ", "NaN", "Infinity", "0x10", "+5", ".5", "5."].map(
      (balance) => [balance, "had wrong type"] as const,
    ),
    ["1".repeat(17), "exceeded the numeric magnitude limit"] as const,
  ])("rejects number text %j", async (balance, issue) => {
    const adapter = mappings({ type: "value", valueType: "balance", value: { path: ["balance"] } });
    await expect(fetchBody({ balance }, jsonSource(adapter))).resolves.toEqual({
      success: false,
      error: `Invalid json-v1 response: adapter.mappings[0].metric.value ${issue} at row 0`,
    });
  });

  it("caps detailed partial errors and adds one fixed omission summary", async () => {
    const body = [{ used: 0 }, ...Array.from({ length: 99 }, () => null)];
    const result = await fetchBody(body, jsonSource(mappings(usedValue())));
    if (!result.success) throw new Error(result.error);
    expect(result.entries).toHaveLength(1);
    expect(result.rowErrors).toHaveLength(17);
    expect(result.rowErrors?.at(-1)).toBe("Additional json-v1 mapping errors omitted");
  });

  it.each([
    [
      "exactly 100 successful entries",
      mappings(usedValue()),
      Array.from({ length: 100 }, (_, used) => ({ used })),
      100,
    ],
    [
      "exactly 32 container levels",
      mappings({ type: "value", valueType: "used", value: { literal: 1 } }),
      nested(31),
      1,
    ],
  ])("accepts %s", async (_name, adapter, body, count) => {
    const result = await fetchBody(body, jsonSource(adapter));
    expect(result.success && result.entries).toHaveLength(count);
  });

  const rowsAt = (...rowsPath: string[]) => ({
    rowsPath,
    mappings: mappings(usedValue()).mappings,
  });
  it.each([
    [
      "an empty selected row array",
      rowsAt("data", "rows"),
      { data: { rows: [] } },
      "selected rows must contain 1-100 elements",
    ],
    [
      "a 101-element selected row array",
      rowsAt("data", "rows"),
      { data: { rows: Array.from({ length: 101 }, () => ({ used: 0 })) } },
      "selected rows must contain 1-100 elements",
    ],
    [
      "a 101st successful entry instead of truncating",
      mappings(usedValue(), { type: "value", valueType: "limit", value: { path: ["limit"] } }),
      Array.from({ length: 51 }, () => ({ used: 0, limit: 10 })),
      "more than 100 entries were produced",
    ],
    [
      "non-finite percentages derived from finite operands",
      mappings({ type: "used-limit", used: { literal: 1 }, limit: { literal: Number.MIN_VALUE } }),
      {},
      "adapter.mappings[0].metric.limit produced a non-finite percentage at row 0",
    ],
    [
      "finite derived percentages beyond the numeric magnitude limit",
      mappings({ type: "spend-budget", spend: { literal: 1e15 }, budget: { literal: 1e-10 } }),
      {},
      "adapter.mappings[0].metric.budget produced a percentage beyond the numeric magnitude limit at row 0",
    ],
    [
      "nesting beyond 32 container levels",
      mappings({ type: "value", valueType: "used", value: { literal: 1 } }),
      nested(32),
      "nesting depth exceeded 32",
    ],
    ["a rowsPath on an array root", rowsAt("rows"), [], "adapter.rowsPath requires an object root"],
    ["a missing rowsPath", rowsAt("rows"), {}, "adapter.rowsPath was missing"],
    [
      "a rowsPath through a non-object",
      rowsAt("rows", "list"),
      { rows: 5 },
      "adapter.rowsPath had wrong type",
    ],
    [
      "a rowsPath that is not an array",
      rowsAt("rows"),
      { rows: {} },
      "adapter.rowsPath did not resolve to an array",
    ],
    ["a scalar root", mappings(usedValue()), 5, "expected an object or array root"],
  ])("rejects %s", async (_name, adapter, body, message) => {
    await expect(fetchBody(body, jsonSource(adapter as JsonV1Source["adapter"]))).resolves.toEqual({
      success: false,
      error: `Invalid json-v1 response: ${message}`,
    });
  });

  const lit = (literal: number) => ({ literal });
  it.each([
    [{ type: "used-limit", used: lit(-1), limit: lit(10) }, "metric.used must be non-negative"],
    [{ type: "used-limit", used: lit(1), limit: lit(0) }, "metric.limit must be greater than zero"],
    [{ type: "spend-budget", spend: lit(-1), budget: lit(5) }, "metric.spend must be non-negative"],
    [
      { type: "remaining-limit", remaining: lit(11), limit: lit(10) },
      "metric.remaining must not exceed limit",
    ],
    [
      { type: "remaining-budget", remaining: lit(1), budget: lit(0) },
      "metric.budget must be greater than zero",
    ],
    [
      { type: "percentage", percentage: lit(101), meaning: "remaining" },
      "metric.percentage must not exceed 100 for remaining meaning",
    ],
    [
      { type: "percentage", percentage: lit(-1), meaning: "used" },
      "metric.percentage must be non-negative for used meaning",
    ],
    [{ type: "value", valueType: "spend", value: lit(-1) }, "metric.value must be non-negative"],
    [{ type: "status", value: { path: ["count"] } }, "metric.value had wrong type"],
    [
      { type: "status", value: { path: ["blank"] } },
      "metric.value did not resolve to bounded display text",
    ],
  ] as const)("rejects the metric %j", async (metric, issue) => {
    const adapter = mappings(metric as JsonV1Mapping["metric"]);
    await expect(fetchBody({ count: 1, blank: "  " }, jsonSource(adapter))).resolves.toEqual({
      success: false,
      error: `Invalid json-v1 response: adapter.mappings[0].${issue} at row 0`,
    });
  });
});
