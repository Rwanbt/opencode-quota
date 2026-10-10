import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/http.js", () => ({ fetchWithTimeout }));

import { queryKimiQuota } from "../src/lib/kimi.js";

function queryCn() {
  return queryKimiQuota({ apiKey: "cn-test-key", endpoint: "cn" });
}

function mockResponse(response: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  fetchWithTimeout.mockImplementationOnce(async (_url, options) =>
    options.consume({
      ...response,
      json: async () => response.json,
      text: async () => response.text,
    }),
  );
}

const usagePayload = { usage: { limit: "100", used: "10", remaining: "90" } };

describe("queryKimiQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["global", "https://api.kimi.ai/coding/v1/usages", "Kimi Code"],
    ["cn", "https://api.kimi.com/coding/v1/usages", "Kimi Code (CN)"],
  ] as const)("binds the %s key to its own endpoint and forwards the timeout", async (endpoint, url, label) => {
    mockResponse({ ok: true, json: usagePayload });

    const result = await queryKimiQuota({ apiKey: "secret", endpoint, requestTimeoutMs: 4321 });

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        request: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        }),
        timeoutMs: 4321,
      }),
    );
    expect(result).toMatchObject({ success: true, label });
  });

  it("parses string numbers from the existing API shape", async () => {
    mockResponse({
      ok: true,
      json: {
        usage: {
          limit: "100",
          used: "45",
          remaining: "55",
          resetTime: "2026-04-16T15:36:21.718434Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "100",
              used: "22",
              remaining: "78",
              resetTime: "2026-04-16T16:36:21.718434Z",
            },
          },
        ],
        parallel: { limit: "20" },
      },
    });

    await expect(queryCn()).resolves.toMatchObject({
      success: true,
      label: "Kimi Code (CN)",
      windows: [
        {
          label: "Weekly limit",
          used: 45,
          limit: 100,
          percentRemaining: 55,
          resetTimeIso: "2026-04-16T15:36:21.718Z",
        },
        {
          label: "5h limit",
          used: 22,
          limit: 100,
          percentRemaining: 78,
          resetTimeIso: "2026-04-16T16:36:21.718Z",
        },
      ],
    });
  });

  it("computes used from remaining when used is absent", async () => {
    mockResponse({ ok: true, json: { usage: { limit: "100", remaining: "30" } } });

    await expect(queryCn()).resolves.toMatchObject({
      success: true,
      windows: [{ label: "Weekly limit", used: 70, limit: 100, percentRemaining: 30 }],
    });
  });

  it.each([
    [
      "an HTTP error",
      () => mockResponse({ ok: false, status: 401, text: "Unauthorized" }),
      "Kimi API error 401: Unauthorized",
    ],
    [
      "an empty usable payload",
      () => mockResponse({ ok: true, json: { message: "hello", code: 0 } }),
      "Unexpected response structure (keys: message, code)",
    ],
    [
      "a thrown error",
      () => fetchWithTimeout.mockRejectedValueOnce(new Error("network\u001b[31m error")),
      "network error",
    ],
  ])("returns a sanitized error for %s without trying the other host", async (_name, mock, error) => {
    mock();

    await expect(queryCn()).resolves.toEqual({ success: false, error });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit regional label", async () => {
    mockResponse({ ok: true, json: usagePayload });

    await expect(
      queryKimiQuota({ apiKey: "key", endpoint: "global", label: "Custom Kimi" }),
    ).resolves.toMatchObject({ success: true, label: "Custom Kimi" });
  });
});
