import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../src/lib/opencode-go.js";

type WindowKey = "rolling" | "weekly" | "monthly";

const TOKEN = "distinctive-secret-token";

function validPayload(): Record<string, unknown> {
  return {
    usage: {
      rolling: {
        status: "ok",
        percent: 12.5,
        resetsAt: "2026-08-12T12:30:00Z",
      },
      weekly: {
        status: "ok",
        percent: 45,
        resetsAt: "2026-08-16T18:00:00+02:00",
      },
      monthly: {
        status: "ok",
        percent: 80,
        resetsAt: "2026-09-01T00:00:00-04:00",
      },
    },
    ignored: true,
  };
}

function windowFrom(payload: Record<string, unknown>, key: WindowKey): Record<string, unknown> {
  return ((payload.usage as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;
}

function mockSuccess(payload: unknown): void {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue(payload),
  });
}

function mockHttpFailure(status: number, text: string): void {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(text),
  });
}

/** Query with one window field changed. */
async function queryWith(key: WindowKey, field: string, value: unknown) {
  const payload = validPayload();
  windowFrom(payload, key)[field] = value;
  mockSuccess(payload);
  return await queryOpenCodeGoQuota("token");
}

describe("queryOpenCodeGoQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixed Bearer JSON request and normalizes all windows", async () => {
    const token = "go-test-token";
    mockSuccess(validPayload());

    const result = await queryOpenCodeGoQuota(token, { requestTimeoutMs: 4321 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      timeoutMs: 4321,
      consume: expect.any(Function),
    });
    expect(result).toEqual({
      success: true,
      rolling: {
        status: "ok",
        usagePercent: 12.5,
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      weekly: {
        status: "ok",
        usagePercent: 45,
        percentRemaining: 55,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      monthly: {
        status: "ok",
        usagePercent: 80,
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    });
  });

  it("accepts 0 and 100 percent plus valid past timestamps", async () => {
    const payload = validPayload();
    windowFrom(payload, "rolling").percent = 0;
    windowFrom(payload, "rolling").resetsAt = "2020-01-01T00:00:00Z";
    windowFrom(payload, "weekly").percent = 100;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({
      success: true,
      rolling: { usagePercent: 0, percentRemaining: 100 },
      weekly: { usagePercent: 100, percentRemaining: 0 },
    });
  });

  it("treats a rate-limited window as exhausted regardless of percent and keeps its siblings", async () => {
    const payload = validPayload();
    windowFrom(payload, "rolling").percent = 17;
    windowFrom(payload, "weekly").status = "rate-limited";
    windowFrom(payload, "weekly").percent = 42;
    windowFrom(payload, "monthly").percent = 91;
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toMatchObject({
      success: true,
      rolling: { status: "ok", usagePercent: 17, percentRemaining: 83 },
      weekly: {
        status: "rate-limited",
        usagePercent: 100,
        percentRemaining: 0,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      monthly: { status: "ok", usagePercent: 91, percentRemaining: 9 },
    });
  });

  it("still validates percent and resetsAt on a rate-limited window", async () => {
    const payload = validPayload();
    windowFrom(payload, "weekly").status = "rate-limited";
    windowFrom(payload, "weekly").percent = 101;
    mockSuccess(payload);
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: weekly percent must be a finite number from 0 to 100",
    });

    windowFrom(payload, "weekly").percent = 42;
    windowFrom(payload, "weekly").resetsAt = "2026-08-12T12:30:00";
    mockSuccess(payload);
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: weekly resetsAt must be an offset-qualified ISO timestamp",
    });
  });

  it.each([
    [null, "root must be an object"],
    [[], "root must be an object"],
    [{ usage: null }, "usage must be an object"],
    [{ usage: [] }, "usage must be an object"],
  ])("rejects payload %j", async (payload, message) => {
    mockSuccess(payload);
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: `Invalid OpenCode Go API response: ${message}`,
    });
  });

  it.each(["rolling", "weekly", "monthly"] as const)("requires the %s window", async (window) => {
    const payload = validPayload();
    delete (payload.usage as Record<string, unknown>)[window];
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: `Invalid OpenCode Go API response: ${window} window is missing or malformed`,
    });
  });

  it.each(["OK", " ok", null])("requires exact raw status ok: %j", async (status) => {
    const result = await queryWith("weekly", "status", status);
    expect(result).toMatchObject({ success: false });
    expect(result).toHaveProperty(
      "error",
      expect.stringContaining("Invalid OpenCode Go API response: weekly status is not ok"),
    );
  });

  it.each([-1, 101, "10", null])("rejects invalid percent %j", async (percent) => {
    await expect(queryWith("monthly", "percent", percent)).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: monthly percent must be a finite number from 0 to 100",
    });
  });

  it.each([
    "2026-08-12",
    "2026-08-12T12:30:00",
    "Wed, 12 Aug 2026 12:30:00 GMT",
    "2026-08-12T12:30:00+0200",
    "2026-08-12T12:30:00+24:00",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    null,
  ])("rejects non-offset-qualified resetsAt %j", async (resetsAt) => {
    await expect(queryWith("rolling", "resetsAt", resetsAt)).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: rolling resetsAt must be an offset-qualified ISO timestamp",
    });
  });

  it("returns a stable malformed JSON error with token redaction", async () => {
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      json: vi
        .fn()
        .mockRejectedValue(new SyntaxError(`Unexpected ${TOKEN}\nend ${TOKEN} of JSON input`)),
    });

    const result = await queryOpenCodeGoQuota(TOKEN);

    expect(result).toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: body is not valid JSON: Unexpected [redacted] end [redacted] of JSON input",
    });
  });

  it("redacts repeated tokens before sanitizing and bounding HTTP bodies", async () => {
    mockHttpFailure(401, `\u001b[31m${TOKEN}\n${"x".repeat(140)} ${TOKEN}\u001b[0m`);

    const result = await queryOpenCodeGoQuota(TOKEN);

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect((result as { error: string }).error).toContain("OpenCode Go API error 401: [redacted]");
    expect((result as { error: string }).error.length).toBeLessThanOrEqual(
      "OpenCode Go API error 401: ".length + 120,
    );
  });

  it("flags a 403 EntitlementError body as not subscribed", async () => {
    mockHttpFailure(
      403,
      '{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}',
    );

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });
  });

  it.each([
    [403, '{"error":"forbidden"}'],
    [403, '{"error":{"type":"EntitlementError"}}'],
    [403, '{"type":"error","error":{"type":"entitlementerror"}}'],
    [403, "not-json EntitlementError"],
    [401, '{"type":"error","error":{"type":"EntitlementError"}}'],
  ])("keeps unrelated HTTP %s body %s as an ordinary error", async (status, body) => {
    mockHttpFailure(status, body);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({ success: false, retryable: false });
    expect((result as { error: string }).error).toContain(`OpenCode Go API error ${status}`);
    expect((result as { notSubscribed?: true }).notSubscribed).toBeUndefined();
  });

  it("retains the HTTP status when reading a non-success body fails", async () => {
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi
        .fn()
        .mockRejectedValue(new Error(`body ${TOKEN}\n${"x".repeat(140)} ${TOKEN} failed`)),
    });

    const result = await queryOpenCodeGoQuota(TOKEN);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect((result as { error: string }).error).toContain(
      "OpenCode Go API error 503: body [redacted]",
    );
    expect((result as { error: string }).error.length).toBeLessThanOrEqual(
      "OpenCode Go API error 503: ".length + 120,
    );
  });

  it("redacts tokens from network failures", async () => {
    mocks.fetchResponse.mockRejectedValueOnce(new Error(`failed ${TOKEN} twice ${TOKEN}`));

    await expect(queryOpenCodeGoQuota(TOKEN)).resolves.toEqual({
      success: false,
      error: "failed [redacted] twice [redacted]",
      retryable: true,
    });
  });

  it("redacts a token returned as a remote window status", async () => {
    const payload = validPayload();
    windowFrom(payload, "rolling").status = `${TOKEN}\nretry`;
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota(TOKEN)).resolves.toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: rolling status is not ok: [redacted] retry",
    });
  });
});

describe("queryOpenCodeGoConsoleStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const meter = (usedMicroCents: number | string, resetsAt?: string) => ({
    limitMicroCents: 1_000,
    usedMicroCents,
    ...(resetsAt ? { resetsAt } : {}),
  });

  function mockConsoleBody(body: unknown): void {
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
    });
  }

  it("asks the login's Console server, scoped to the login's org", async () => {
    const reset = "2026-10-01T00:00:00Z";
    mockConsoleBody({
      access: {
        meters: { fiveHour: meter(0, reset), week: meter(250, reset), month: meter(500, reset) },
      },
    });

    const result = await queryOpenCodeGoConsoleStatus(
      { accessToken: "console-access", orgId: "wrk_1", server: "https://console.example.test" },
      { requestTimeoutMs: 4321 },
    );

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://console.example.test/api/go/status",
      {
        request: {
          method: "GET",
          headers: {
            Authorization: "Bearer console-access",
            Accept: "application/json",
            "x-org-id": "wrk_1",
          },
        },
        timeoutMs: 4321,
        consume: expect.any(Function),
      },
    );
    expect(result).toMatchObject({
      success: true,
      rolling: { percentRemaining: 100 },
      weekly: { percentRemaining: 75 },
      monthly: { percentRemaining: 50 },
    });
  });

  it("reads string microcents, an exhausted zero limit, and the access end as fallback reset", async () => {
    mockConsoleBody({
      access: {
        endsAt: "2026-10-02T12:48:59Z",
        meters: {
          fiveHour: meter("0", "2026-09-23T18:59:07.061Z"),
          week: { limitMicroCents: 0, usedMicroCents: 5 },
          month: meter(1_000),
        },
      },
    });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: true,
      rolling: {
        status: "ok",
        usagePercent: 0,
        percentRemaining: 100,
        resetTimeIso: "2026-09-23T18:59:07.061Z",
      },
      weekly: {
        status: "rate-limited",
        usagePercent: 100,
        percentRemaining: 0,
        resetTimeIso: "2026-10-02T12:48:59.000Z",
      },
      monthly: {
        status: "rate-limited",
        usagePercent: 100,
        percentRemaining: 0,
        resetTimeIso: "2026-10-02T12:48:59.000Z",
      },
    });
  });

  const contractError = (message: string) => ({
    success: false,
    error: `Invalid OpenCode Go API response: ${message}`,
  });

  it.each([
    [
      "no access as not subscribed",
      { access: null },
      { success: false, error: "OpenCode Go subscription is not active", notSubscribed: true },
    ],
    ["invalid JSON", "{", contractError("console response is not valid JSON")],
    ["missing meters", { access: {} }, contractError("console access meters are missing")],
    [
      "a missing meter",
      { access: { meters: { fiveHour: meter(0, "2026-10-01T00:00:00Z") } } },
      contractError("console week meter is missing"),
    ],
    [
      "invalid microcents",
      { access: { meters: { fiveHour: meter(-1, "2026-10-01T00:00:00Z") } } },
      contractError("console rolling meter microcents are invalid"),
    ],
    [
      "no reset at all",
      { access: { meters: { fiveHour: meter(0) } } },
      contractError("console rolling resetsAt is missing or invalid"),
    ],
  ])("reports %s", async (_name, body, expected) => {
    mockConsoleBody(body);

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual(
      expected,
    );
  });

  it("reads HTTP 404 as no Go subscription", async () => {
    mocks.fetchResponse.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: false,
      error: "OpenCode Go subscription not found for this console account (404)",
      notSubscribed: true,
    });
  });

  it.each([
    [401, false],
    [403, false],
    [500, true],
  ])("keeps HTTP %s as a failed Console request", async (status, retryable) => {
    mocks.fetchResponse.mockResolvedValueOnce({ ok: false, status });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: false,
      error: `OpenCode Console API error ${status} (/api/go/status)`,
      retryable,
    });
  });
});
