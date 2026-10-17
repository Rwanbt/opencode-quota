import { describe, expect, it } from "vitest";
import { toGuiQuotaSnapshot } from "../src/lib/gui-snapshot.js";
import type { QuotaExport } from "../src/lib/quota-export-types.js";

describe("GUI quota snapshot projection", () => {
  it("projects percentage windows and provenance, excluding identifiers, raw details and errors", () => {
    const input: QuotaExport = {
      version: 2,
      exportedAt: 1000,
      fromCache: true,
      cacheAgeSeconds: 15,
      providers: {
        copilot: {
          status: "partial",
          fetchedAt: 990,
          rawDetails: [{ key: "authorization", value: "SECRET" }],
          errors: [{ label: "private@example.com", message: "SECRET" }],
          entries: [
            {
              name: "private@example.com",
              renderType: "percent",
              resultType: "rate_limit",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: "private-account",
              observedAt: 985,
              window: "5h",
              resetAt: 1090,
              percentRemaining: 63,
            },
            {
              name: "private@example.com",
              renderType: "value",
              resultType: "balance",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "locally_derived",
              value: "SECRET",
            },
          ],
        },
      },
    };

    expect(toGuiQuotaSnapshot(input)).toEqual({
      version: 1,
      generatedAt: 1000,
      cacheAgeSeconds: 15,
      providers: {
        copilot: {
          status: "partial",
          fetchedAt: 990,
          windows: [
            {
              window: "5h",
              percentRemaining: 63,
              resetAt: 1090,
              observedAt: 985,
              resultType: "rate_limit",
              authority: "provider_reported",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(toGuiQuotaSnapshot(input))).not.toMatch(/SECRET|private/);
  });

  it("preserves unavailable status and excludes invalid percentage bars", () => {
    const entry = {
      name: "unknown",
      renderType: "percent" as const,
      resultType: "quota" as const,
      acquisitionMethod: "remote_api" as const,
      ownership: "maintained" as const,
      authority: "locally_derived" as const,
      percentRemaining: Number.NaN,
      resetAt: Number.NaN,
    };
    const snapshot: QuotaExport = {
      version: 2,
      exportedAt: 100,
      cacheAgeSeconds: 0,
      fromCache: true,
      providers: {
        missing: { status: "unavailable" },
        broken: { status: "ok", fetchedAt: 99, entries: [entry] },
      },
    };
    const result = toGuiQuotaSnapshot(snapshot);
    expect(result.providers.missing).toEqual({ status: "unavailable", windows: [] });
    expect(result.providers.broken).toEqual({ status: "ok", fetchedAt: 99, windows: [] });
  });

  it("treats prototype-like provider ids as plain data, not object mutations", () => {
    const input: QuotaExport = {
      version: 2,
      exportedAt: 100,
      cacheAgeSeconds: 1,
      fromCache: true,
      providers: Object.fromEntries([["__proto__", { status: "unavailable" }]]),
    };
    const result = toGuiQuotaSnapshot(input);
    expect(Object.keys(result.providers)).toEqual(["__proto__"]);
    expect(Object.hasOwn(result.providers, "__proto__")).toBe(true);
    expect(result.providers["__proto__"]).toEqual({ status: "unavailable", windows: [] });
    expect(JSON.parse(JSON.stringify(result)).providers).toHaveProperty("__proto__");
  });
});
