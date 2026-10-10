import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readMarkdownSection } from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function headingIndex(document: string, heading: string): number {
  const index = document.split("\n").findIndex((line) => line === `## ${heading}`);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("contribution guidance", () => {
  const prTemplate = read(".github/pull_request_template.md");
  const contributing = read("CONTRIBUTING.md");

  it("places Before-and-after evidence after OpenCode Validation and before Quality Checklist", () => {
    const openCodeValidation = headingIndex(prTemplate, "OpenCode Validation");
    const evidence = headingIndex(prTemplate, "Before-and-after evidence");
    const quality = headingIndex(prTemplate, "Quality Checklist");
    expect(openCodeValidation).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(quality);
    expect(headingIndex(contributing, "Before-and-after screenshots (required)")).toBeLessThan(
      headingIndex(contributing, "PR checklist"),
    );
  });

  it("requires matching screenshots, four-surface reports, redaction, and justified Not applicable", () => {
    const templateEvidence = readMarkdownSection(prTemplate, /^Before-and-after evidence$/);
    expect(templateEvidence).toContain("matching before-and-after screenshots");
    expect(templateEvidence).toContain("Web output");
    expect(templateEvidence).toContain("TUI sidebar");
    expect(templateEvidence).toContain("toast");
    expect(templateEvidence).toContain("status line below the message input");
    expect(templateEvidence).toContain("command dialog when relevant");
    expect(templateEvidence).toContain("unchanged or untested");
    expect(templateEvidence).toMatch(
      /redact credentials, account identifiers, private paths, and other sensitive information/i,
    );
    expect(templateEvidence).toContain("`Not applicable`");
    expect(templateEvidence).toContain("explain briefly");
    expect(templateEvidence).toContain("Formatter tests do not count as screenshot evidence");

    const contributingEvidence = readMarkdownSection(
      contributing,
      /^Before-and-after screenshots \(required\)$/,
    );
    expect(contributingEvidence).toContain("must include before-and-after screenshots");
    expect(contributingEvidence).toContain("same config, model, theme, and window size");
    expect(contributingEvidence).toContain(
      "Web, TUI sidebar, toast, and the status line under the message input",
    );
    expect(contributingEvidence).toContain("command dialog if relevant");
    expect(contributingEvidence).toContain("Say which ones you didn't test");
    expect(contributingEvidence).toContain(
      "credentials, account identifiers, and private paths hidden",
    );
    expect(contributingEvidence).toContain("`Not applicable`");
    expect(contributingEvidence).toContain("Tests don't replace screenshots");

    expect(readMarkdownSection(contributing, /^PR checklist$/)).toContain(
      "Before-and-after screenshots and surface results, or `Not applicable`",
    );
  });

  it("uses canonical pnpm verify and keeps production-version and focused-change requirements", () => {
    expect(prTemplate).toContain("I ran `pnpm verify`");
    expect(prTemplate).not.toContain("I ran `pnpm run typecheck`");
    expect(prTemplate).not.toContain("I ran `pnpm run build`");
    expect(prTemplate).not.toContain("I ran `pnpm test`");
    expect(prTemplate).toContain("Current production released OpenCode version tested:");
    expect(prTemplate).toContain("This change is focused and avoids unrelated behavior changes");
    expect(contributing).toContain("`pnpm verify` passes");
    expect(contributing).toContain("Tested on the current released OpenCode");
    expect(contributing).toContain("smallest safe fix");
  });
});
