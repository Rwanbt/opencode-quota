import { describe, expect, it } from "vitest";

import type { QuotaRow } from "../src/core/types.js";
import {
  containsQuotaReport,
  formatQuotaReportMessage,
  quotaMessageText,
  removeQuotaReports,
} from "../src/lib/quota-report-message.js";

describe("quota report messages", () => {
  it("wraps the report in a fixed first and last line", () => {
    const message = formatQuotaReportMessage("# Quota\nopenai  ███░░ 42%");

    expect(message).toBe(
      "[OpenCode Quota report]\n# Quota\nopenai  ███░░ 42%\n[End of OpenCode Quota report]",
    );
    expect(containsQuotaReport(message)).toBe(true);
  });

  it("cuts every complete report out of text and leaves everything else", () => {
    const first = formatQuotaReportMessage("openai 42%");
    const second = formatQuotaReportMessage("anthropic 7%");
    const text = `[User]: hi\n\n[User]: ${first}\n\n[Assistant]: ok\n\n[User]: ${second}`;

    expect(removeQuotaReports(text)).toBe("[User]: hi\n\n[User]: \n\n[Assistant]: ok\n\n[User]: ");
    expect(removeQuotaReports("[OpenCode Quota report] without an end line")).toBe(
      "[OpenCode Quota report] without an end line",
    );
    expect(removeQuotaReports("no report")).toBe("no report");
  });

  it("writes every limit of the snapshot, then the notices", () => {
    const nowMs = Date.parse("2026-10-10T12:00:00.000Z");
    const row = (id: string, fields: Partial<QuotaRow>): QuotaRow => ({
      id,
      providerId: "anthropic",
      label: id.split(".")[1] ?? "",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      ...fields,
    });
    const snapshot = {
      version: 6,
      providers: [
        {
          providerId: "anthropic",
          label: "Claude",
          rows: [
            row("anthropic.5h", {
              percentRemaining: 58,
              resetsAt: new Date(nowMs + 134 * 60_000).toISOString(),
            }),
            // Web and Desktop have no display settings, so supplementary rows show too.
            row("anthropic.fable", { percentRemaining: 90, prominence: "supplementary" }),
          ],
          checkedAtMs: nowMs,
          refreshing: false,
          debug: [],
        },
      ],
      resetNotices: [],
      generatedAtMs: nowMs,
      words: {
        percent: "left",
        reset: "exact",
        resetDecimals: 1,
        detail: "detailed",
        runsOut: false,
        onlyCurrentModel: false,
        sessionTokens: "current",
      },
    } as const;
    const notices = [
      {
        id: "a",
        message: "Copilot moves to AI Credits.",
        url: "https://example.com/a",
        read: true,
      },
    ];

    expect(quotaMessageText({ snapshot, notices, nowMs }).split("\n")).toEqual([
      "Quota",
      "Claude 5h           58% left      2h 14m",
      "Claude fable        90% left",
      "",
      "Notices",
      "- Copilot moves to AI Credits.",
      "  https://example.com/a",
    ]);
    expect(quotaMessageText({ snapshot: { ...snapshot, providers: [] }, notices: [], nowMs })).toBe(
      "Quota\nNo quota providers found. Run /quota_status to see why.",
    );
  });
});
