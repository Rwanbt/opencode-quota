import { describe, expect, it } from "vitest";

import {
  getMaintainerAnnouncementsSummary,
  type MaintainerAnnouncement,
} from "../src/lib/maintainer-announcements.js";

const NOW_MS = Date.parse("2026-05-21T12:00:00.000Z");

const BASE_ANNOUNCEMENT = {
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
} satisfies MaintainerAnnouncement;

function evaluate(
  announcements: readonly MaintainerAnnouncement[],
  enabledProviders: string[] | "auto",
) {
  return getMaintainerAnnouncementsSummary({ nowMs: NOW_MS, enabledProviders, announcements })
    .evaluations;
}

describe("maintainer announcements", () => {
  it("keeps an announcement inactive for each reason it fails", () => {
    const evaluations = evaluate(
      [
        BASE_ANNOUNCEMENT,
        { ...BASE_ANNOUNCEMENT, id: "future", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "expired", endsAt: "2026-05-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "invalid-url", url: "http://example.com" },
        { ...BASE_ANNOUNCEMENT, id: "wrong-provider", providerIds: ["openai"] },
        { ...BASE_ANNOUNCEMENT, id: "targeted", providerIds: ["copilot"] },
        {
          ...BASE_ANNOUNCEMENT,
          id: "future-alias",
          startsAt: "2026-06-01T00:00:00.000Z",
          providerIds: ["gemini-cli" as never, "unknown-provider" as never],
        },
        { ...BASE_ANNOUNCEMENT, id: "invalid-message", message: "", providerIds: ["openai"] },
        { ...BASE_ANNOUNCEMENT, id: "invalid-only", providerIds: ["unknown-provider" as never] },
      ],
      ["copilot"],
    );

    expect(
      Object.fromEntries(evaluations.map((item) => [item.announcement.id, item.reasons])),
    ).toEqual({
      "copilot-credits": [],
      future: ["not_started"],
      expired: ["ended"],
      "invalid-url": ["invalid_url"],
      "wrong-provider": ["provider_mismatch"],
      targeted: [],
      "future-alias": ["not_started", "provider_mismatch"],
      "invalid-message": ["invalid_message", "provider_mismatch"],
      "invalid-only": ["invalid_provider_ids"],
    });
    expect(evaluations.filter((item) => item.active).map((item) => item.announcement.id)).toEqual([
      "copilot-credits",
      "targeted",
    ]);
  });

  it("requires concrete provider ids for provider-targeted announcements", () => {
    const targeted = [{ ...BASE_ANNOUNCEMENT, providerIds: ["copilot" as const] }];

    expect(evaluate(targeted, "auto")).toMatchObject([
      { active: false, reasons: ["provider_mismatch"] },
    ]);
    expect(evaluate(targeted, ["copilot"])).toMatchObject([{ active: true }]);
  });

  it.each([
    ["2026-07-22T12:00:00.000Z", "auto", ["opencode-ecosystem-listing-support"]],
    [
      "2026-07-22T12:00:00.000Z",
      ["gemini-cli"],
      ["opencode-ecosystem-listing-support", "google-gemini-cli-org-only"],
    ],
    ["2026-07-22T12:00:00.000Z", ["google-agy"], ["opencode-ecosystem-listing-support"]],
    ["2026-09-24T23:59:59.999Z", "auto", []],
    ["2026-09-25T00:00:00.000Z", "auto", ["opencode-2-feedback"]],
    [
      "2026-10-15T12:00:00.000Z",
      ["google-gemini-cli"],
      ["opencode-ecosystem-listing-thumbs-up", "opencode-2-feedback", "google-gemini-cli-org-only"],
    ],
    ["2026-10-26T00:00:00.000Z", "auto", ["opencode-2-feedback"]],
    ["2026-11-24T23:59:59.999Z", ["google-agy"], ["opencode-2-feedback"]],
    ["2026-11-25T00:00:00.000Z", "auto", []],
  ] as const)("shows the bundled notices active at %s for %o", (iso, enabledProviders, ids) => {
    const summary = getMaintainerAnnouncementsSummary({
      nowMs: Date.parse(iso),
      enabledProviders: enabledProviders === "auto" ? "auto" : [...enabledProviders],
    });

    expect(summary.activeAnnouncements.map((item) => item.announcement.id)).toEqual(ids);
  });

  it("sorts active announcements before inactive, then by end date and id", () => {
    const evaluations = evaluate(
      [
        { ...BASE_ANNOUNCEMENT, id: "z-last", endsAt: "2026-06-10T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "inactive", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "a-first", endsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "b-first", endsAt: "2026-06-01T00:00:00.000Z" },
      ],
      "auto",
    );

    expect(evaluations.map((item) => item.announcement.id)).toEqual([
      "a-first",
      "b-first",
      "z-last",
      "inactive",
    ]);
  });

  it("summarizes bundled-only counts without state", () => {
    const summary = getMaintainerAnnouncementsSummary({
      nowMs: NOW_MS,
      enabledProviders: ["copilot"],
      announcements: [
        BASE_ANNOUNCEMENT,
        { ...BASE_ANNOUNCEMENT, id: "future", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "expired", endsAt: "2026-05-01T00:00:00.000Z" },
      ],
    });

    expect(summary).toMatchObject({
      source: "bundled_only",
      network: false,
      bundledCount: 3,
      activeCount: 1,
      futureCount: 1,
      expiredCount: 1,
    });
    expect(summary.activeAnnouncements.map((item) => item.announcement.id)).toEqual([
      "copilot-credits",
    ]);
  });
});
