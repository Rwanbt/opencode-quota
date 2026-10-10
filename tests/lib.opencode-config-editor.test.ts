import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveEditableConfigPath } from "../src/lib/config-file-utils.js";
import {
  applyConfigDocumentEdit,
  planConfigDocumentEdit,
} from "../src/lib/opencode-config-editor.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-config-editor-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("OpenCode JSON/JSONC config editor", () => {
  it("preserves JSONC comments and trailing commas without duplicating managed comments", async () => {
    const dir = makeTempDir();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(
      path,
      `{
  // user-owned setting
  "theme": "dark",
  // OpenCode Quota: loads the server plugin for slash commands and quota checks.
  "plugin": ["other-plugin",],
}
`,
      "utf8",
    );

    const target = resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "jsonc",
    });
    const desiredData = {
      theme: "dark",
      plugin: ["other-plugin", "@slkiser/opencode-quota@latest"],
    };
    const comments = [
      {
        path: ["plugin"],
        text: "// OpenCode Quota: loads the server plugin for slash commands and quota checks.",
      },
    ];

    const first = await planConfigDocumentEdit({
      target,
      desiredData,
      managedComments: comments,
    });
    await applyConfigDocumentEdit(first);

    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("// user-owned setting");
    expect(updated).toContain('"other-plugin",');
    expect(updated.match(/OpenCode Quota: loads the server plugin/g)).toHaveLength(1);

    const second = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir,
        kind: "opencode",
        preferredFormat: "jsonc",
      }),
      desiredData,
      managedComments: comments,
    });
    expect(second.changed).toBe(false);
  });

  it.each([
    { existing: "opencode.jsonc", preferredFormat: "json", format: "jsonc" },
    { existing: "opencode.json", preferredFormat: "jsonc", format: "json" },
  ] as const)("keeps the existing $existing file when $preferredFormat is preferred", ({
    existing,
    preferredFormat,
    format,
  }) => {
    const dir = makeTempDir();
    const path = join(dir, existing);
    writeFileSync(path, '{"plugin":["other"]}\n', "utf8");

    expect(resolveEditableConfigPath({ dir, kind: "opencode", preferredFormat })).toEqual({
      path,
      format,
      existed: true,
    });
  });

  it("writes valid strict JSON without comments when JSON is selected", async () => {
    const dir = makeTempDir();
    const target = resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "json",
    });
    const plan = await planConfigDocumentEdit({
      target,
      desiredData: {
        $schema: "https://opencode.ai/config.json",
        plugin: ["@slkiser/opencode-quota@latest"],
      },
      managedComments: [
        {
          path: ["plugin"],
          text: "// OpenCode Quota: this must not appear in strict JSON.",
        },
      ],
    });

    expect(plan.path).toBe(join(dir, "opencode.json"));
    expect(() => JSON.parse(plan.updated)).not.toThrow();
    expect(plan.updated).not.toMatch(/^\s*\/\//m);

    await applyConfigDocumentEdit(plan);
    expect(() => JSON.parse(readFileSync(plan.path, "utf8"))).not.toThrow();
  });
});
