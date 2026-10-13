import { describe, expect, it } from "vitest";
import { OLD_USAGE_COMMANDS, parseUsageArguments, USAGE_RANGES } from "../src/core/usage-ranges.js";

describe("usage ranges", () => {
  it("lists every range in order, with its label", () => {
    expect(USAGE_RANGES.map((item) => [item.range, item.label])).toEqual([
      ["today", "Today"],
      ["24h", "24 hours"],
      ["7d", "7 days"],
      ["30d", "30 days"],
      ["90d", "90 days"],
      ["session", "This session"],
      ["between", "Between"],
    ]);
  });

  it("shows this session when /quota_usage has no range", () => {
    expect(parseUsageArguments("  ")).toEqual({ ok: true, range: "session" });
    expect(parseUsageArguments("90d")).toEqual({ ok: true, range: "90d" });
  });

  it.each(["all", "session_tree"])("answers /quota_usage %s as an unknown range", (range) => {
    expect(parseUsageArguments(range)).toEqual({
      ok: false,
      error: `Unknown range "${range}".\nUsage: /quota_usage [today | 24h | 7d | 30d | 90d | session | between YYYY-MM-DD YYYY-MM-DD]`,
    });
  });

  it("runs the old session commands on this session and /tokens_all on 90 days", () => {
    expect(OLD_USAGE_COMMANDS).toEqual({
      tokens_today: "today",
      tokens_daily: "24h",
      tokens_weekly: "7d",
      tokens_monthly: "30d",
      tokens_all: "90d",
      tokens_session: "session",
      tokens_session_all: "session",
      tokens_between: "between",
    });
  });
});
