// The OpenAI provider through the real credential reader; only the network is faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import { openaiProvider } from "../src/providers/openai.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

let unbind: (() => void) | undefined;

/**
 * `list()` shows the `openai` integration with no connections, yet
 * `connection.active("openai")` still returns a valid OAuth sign-in.
 */
function bindActiveLoginMissingFromList() {
  const integration = createFakeIntegration([
    {
      integrationId: "openai",
      id: "cred_active",
      label: "default",
      registered: true,
      method: "oauth",
      value: { type: "oauth", access: "a.b.c", refresh: "r", expires: Date.now() + 3_600_000 },
    },
  ]);
  integration.list.mockResolvedValue({
    location: { directory: "/tmp/opencode-quota-fake-location" },
    data: [{ id: "openai", name: "openai", methods: [], connections: [] }],
  } as never);
  unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
}

afterEach(() => {
  unbind?.();
  notifyCredentialsChanged();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openai provider with an empty connection list", () => {
  it("queries the active sign-in OpenCode still reports", async () => {
    bindActiveLoginMissingFromList();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 60,
              },
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await openaiProvider.fetch({ config: {} } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer a.b.c" }),
      }),
    );
    expect(out).toMatchObject({
      attempted: true,
      errors: [],
      presentation: { singleWindowDisplayName: "OpenAI (Plus)" },
    });
    expect(out.entries.map((entry) => [entry.group, entry.percentRemaining])).toEqual([
      ["OpenAI (Plus)", 80],
    ]);
  });

  it("forwards requestTimeoutMs to that request", async () => {
    vi.useFakeTimers();
    bindActiveLoginMissingFromList();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const pending = openaiProvider.fetch({ config: { requestTimeoutMs: 12_000 } } as never);
    await vi.advanceTimersByTimeAsync(12_000);

    await expect(pending).resolves.toMatchObject({
      attempted: true,
      entries: [],
      errors: [{ label: "OpenAI", message: "Request timeout after 12s" }],
    });
  });
});
