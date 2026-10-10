import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveApiKey: vi.fn(), fetchWithTimeout: vi.fn() }));

vi.mock("../src/lib/http.js", () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  resolveApiKey: mocks.resolveApiKey,
}));

import { queryOllamaCloudQuota } from "../src/lib/ollama-cloud.js";

/** Queue one reply without a body stream; `text()` throws `textError` when given. */
function mockResponse(params: {
  status?: number;
  json?: unknown;
  text?: string;
  textError?: Error;
}) {
  const status = params.status ?? 200;
  mocks.fetchWithTimeout.mockImplementationOnce(async (_url, options) =>
    options.consume({
      ok: status < 400,
      status,
      text: async () => {
        if (params.textError) throw params.textError;
        return params.text ?? JSON.stringify(params.json);
      },
    }),
  );
}

const usagePayload = {
  limits: {
    session: { usage: 0.25, models: [{ name: "glm-5.3-flash", request_count: 57 }] },
    weekly: { usage: 0.405, models: [{ name: "glm-5.3-flash", request_count: 162 }] },
  },
};

// Monthly-pool plan response from issue #289.
const monthlyUsagePayload = {
  activity: {
    cost: "0.00000",
    period: { type: "last_4_weeks", starting_at: "...", ending_at: "..." },
    models: [],
  },
  limits: {
    monthly: {
      usage: 0.043,
      models: [
        { name: "gpt-oss:120b", request_count: 32 },
        { name: "gemma4:31b", request_count: 1 },
      ],
    },
  },
};

const UNEXPECTED_SHAPE = {
  success: false,
  error: "Ollama Cloud usage API returned an unexpected response shape",
};

describe("queryOllamaCloudQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveApiKey.mockResolvedValue({
      key: "ollama-secret-key",
      source: "env:OLLAMA_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveApiKey.mockResolvedValueOnce(null);

    await expect(queryOllamaCloudQuota()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the exact usage request with the raw Authorization value and timeout", async () => {
    mockResponse({ json: usagePayload });

    await queryOllamaCloudQuota({ requestTimeoutMs: 1234 });

    // Ollama takes the key as-is, without "Bearer ".
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://ollama.com/api/usage",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: { Accept: "application/json", Authorization: "ollama-secret-key" },
          redirect: "manual",
        },
        timeoutMs: 1234,
        consume: expect.any(Function),
      }),
    );
  });

  it.each([
    [
      "a real nested response",
      usagePayload,
      {
        success: true,
        session: { usageFraction: 0.25, usagePercent: 25, percentRemaining: 75 },
        weekly: { usageFraction: 0.405, usagePercent: 40.5, percentRemaining: 59.5 },
      },
    ],
    [
      "a monthly-only plan",
      monthlyUsagePayload,
      {
        success: true,
        monthly: { usageFraction: 0.043, usagePercent: 4.3, percentRemaining: 95.7 },
      },
    ],
    [
      "the zero and fully-used boundaries",
      { limits: { session: { usage: 0 }, weekly: { usage: 1 } } },
      {
        success: true,
        session: { usageFraction: 0, usagePercent: 0, percentRemaining: 100 },
        weekly: { usageFraction: 1, usagePercent: 100, percentRemaining: 0 },
      },
    ],
    [
      "an invalid weekly fraction next to a valid one",
      { limits: { session: { usage: 0.2 }, weekly: { usage: 1.5 } } },
      {
        success: true,
        session: { usageFraction: 0.2, usagePercent: 20, percentRemaining: 80 },
        rowErrors: ["Weekly: ignored invalid usage fraction"],
      },
    ],
    [
      "an invalid monthly fraction next to a valid one",
      { limits: { weekly: { usage: 0.3 }, monthly: { usage: "0.5" } } },
      {
        success: true,
        weekly: { usageFraction: 0.3, usagePercent: 30, percentRemaining: 70 },
        rowErrors: ["Monthly: ignored invalid usage fraction"],
      },
    ],
    [
      "no usable fraction",
      { limits: { session: { usage: -1 }, weekly: { usage: Number.NaN }, monthly: { usage: 2 } } },
      { success: false, error: "Ollama Cloud usage API returned no usable usage data" },
    ],
    ["a null root", null, UNEXPECTED_SHAPE],
    ["an array root", [], UNEXPECTED_SHAPE],
    ["a string root", "invalid", UNEXPECTED_SHAPE],
  ])("maps %s", async (_name, json, expected) => {
    mockResponse({ json });

    await expect(queryOllamaCloudQuota()).resolves.toEqual(expected);
  });

  it("reports non-success responses without leaking the API key", async () => {
    mockResponse({ status: 401, text: "Unauthorized\nollama-secret-key\u001b[31m" });

    await expect(queryOllamaCloudQuota()).resolves.toEqual({
      success: false,
      error: "Ollama Cloud usage API error 401: Unauthorized [redacted]",
    });
  });

  it("rejects an oversized response before parsing it", async () => {
    mockResponse({ text: "x".repeat(256 * 1024 + 1) });

    await expect(queryOllamaCloudQuota()).resolves.toEqual({
      success: false,
      error: "Ollama Cloud usage API response exceeded 262144 bytes",
    });
  });

  it("sanitizes malformed JSON and transport errors without leaking the API key", async () => {
    mockResponse({ textError: new Error("bad JSON ollama-secret-key\nnext") });
    await expect(queryOllamaCloudQuota()).resolves.toEqual({
      success: false,
      error: "bad JSON [redacted] next",
    });

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout ollama-secret-key\u001b[31m"));
    await expect(queryOllamaCloudQuota()).resolves.toEqual({
      success: false,
      error: "timeout [redacted]",
    });
  });
});
