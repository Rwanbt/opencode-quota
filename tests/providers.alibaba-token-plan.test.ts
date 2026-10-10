import { describe, expect, it, vi } from "vitest";

import {
  type AlibabaTokenPlanErrorKind,
  queryAlibabaTokenPlanQuota,
  resolveAlibabaTokenPlanExecutable,
} from "../src/lib/alibaba-token-plan.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import {
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/alibaba-token-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/alibaba-token-plan.js")>();
  return {
    ...actual,
    resolveAlibabaTokenPlanExecutable: vi.fn(actual.resolveAlibabaTokenPlanExecutable),
    queryAlibabaTokenPlanQuota: vi.fn(actual.queryAlibabaTokenPlanQuota),
  };
});

describe("alibaba-token-plan provider", () => {
  it("is available from explicit selection or recognized runtime presence without probing PATH", async () => {
    const supported = process.platform === "darwin" || process.platform === "linux";
    const selected = createProviderAvailabilityContext({
      providerIds: ["alibaba-token-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(selected)).resolves.toBe(supported);

    const codingPlanOnly = createProviderAvailabilityContext({
      providerIds: ["alibaba", "alibaba-coding-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(codingPlanOnly)).resolves.toBe(false);

    const runtime = createProviderAvailabilityContext({
      configOverrides: { currentProviderID: "alibaba-token-plan" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(runtime)).resolves.toBe(supported);

    const model = createProviderAvailabilityContext({
      configOverrides: { currentModel: "alibaba-token-plan/qwen3" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(model)).resolves.toBe(supported);
    expect(resolveAlibabaTokenPlanExecutable).not.toHaveBeenCalled();
  });

  it.each([
    ["alibaba-token-plan/qwen3", "alibaba-token-plan", true],
    ["alibaba/qwen3-coder", "alibaba", false],
    ["alibaba-coding-plan/qwen3", "alibaba-coding-plan", false],
    ["alibaba-token-plan/qwen3", undefined, true],
    ["alibaba/qwen3-coder", undefined, false],
  ])("matchesCurrentModel(%s, provider %s) -> %s", (model, currentProviderID, expected) => {
    const context = currentProviderID ? ({ currentProviderID } as never) : undefined;
    expect(alibabaTokenPlanProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });

  it("maps official windows without fabricating a sibling, for the project folder", async () => {
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValueOnce({
      ok: true,
      weekly: {
        percentRemaining: 60,
        resetTimeIso: "2024-05-01T20:53:20.000Z",
      },
    });
    const out = await alibabaTokenPlanProvider.fetch({
      workspaceRoot: "/home/user/project",
      config: { requestTimeoutMs: 5000 },
    } as never);

    expect(queryAlibabaTokenPlanQuota).toHaveBeenLastCalledWith({
      requestTimeoutMs: 5000,
      runtime: { cwd: "/home/user/project" },
    });
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "alibaba-token-plan")).toEqual([
      {
        name: "Alibaba Personal Token Plan Weekly",
        group: "Alibaba Personal Token Plan",
        label: "Weekly:",
        percentRemaining: 60,
        resetTimeIso: "2024-05-01T20:53:20.000Z",
      },
    ]);
    expect(out.statusDetails).toEqual([
      { key: "cli_available", value: "true" },
      { key: "platform", value: process.platform },
      { key: "windows", value: "weekly" },
    ]);
  });

  it.each([
    {
      kind: "executable_not_found",
      message: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
      cliAvailable: "false",
    },
    {
      kind: "not_authenticated",
      message:
        "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
      cliAvailable: "true",
    },
    {
      kind: "timeout",
      message: "Timed out while running the Alibaba Cloud CLI.",
      retryable: true,
      cliAvailable: "true",
    },
  ])("returns $kind as one attempted error row", async ({
    kind,
    message,
    retryable,
    cliAvailable,
  }) => {
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValueOnce({
      ok: false,
      error: { kind: kind as AlibabaTokenPlanErrorKind, message, retryable },
    });
    const out = await alibabaTokenPlanProvider.fetch({ config: {} } as never);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      { label: "Alibaba Personal Token Plan", message, ...(retryable ? { retryable } : {}) },
    ]);
    expect(out.statusDetails).toEqual([
      { key: "cli_available", value: cliAvailable },
      { key: "platform", value: process.platform },
      { key: "failure_kind", value: kind },
    ]);
  });

  it("returns not-attempted on unsupported platforms", async () => {
    vi.mocked(queryAlibabaTokenPlanQuota).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "unsupported_platform",
        message: "Alibaba Personal Token Plan is not supported on this platform.",
      },
    });
    expectNotAttempted(await alibabaTokenPlanProvider.fetch({ config: {} } as never));
  });
});
