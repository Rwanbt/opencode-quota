import { describe, expect, it } from "vitest";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const usageValue = "Used 100 | Included 80 | Billed 20 ($0.20)";

describe("Copilot usage-only four-surface formatting", () => {
  it.each([
    // The personal group is implied; credential groups must survive on every surface.
    ["Copilot (personal)", "Copilot AI Credits", "Copilot"],
    ...["[Copilot] (business) (active)", "[Copilot sita] (business) (active)"].map((group) => [
      group,
      `${group} AI Credits`,
      group,
    ]),
  ])("shows group %s without inventing a remaining percentage or reset", (group, name, shown) => {
    const data: QuotaRenderData = {
      entries: [
        {
          accounting: {
            resultType: "usage",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          kind: "value",
          name,
          group,
          label: "Credits:",
          value: usageValue,
        },
      ],
      errors: [],
    };
    const web = formatQuotaCommand({ ...data, generatedAtMs: 0 });
    const toast = formatQuotaRowsGrouped({
      ...data,
      layout: { maxWidth: 100, narrowAt: 42, tinyAt: 32 },
    });
    const sidebar = buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
    }).join("\n");
    const compact = buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 160,
    });

    for (const output of [web, toast, sidebar, compact]) {
      expect(output).toContain("Copilot");
      expect(output).toContain("Used 100");
      expect(output).not.toMatch(/\d+%/u);
      expect(output).not.toContain("reset");
    }
    for (const output of [web, toast, sidebar]) expect(output).toContain(shown);
    for (const output of [web, toast, compact]) expect(output).toContain(usageValue);
  });
});
