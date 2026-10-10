import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --------------- mock modules ---------------

const testPaths = vi.hoisted(() => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const join = (...parts: string[]) => parts.join(separator);
  const root = join(process.cwd(), ".quota-export-test");
  const cacheDir = join(root, "cache");
  return {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir,
    stateDir: join(root, "state"),
    defaultExport: join(cacheDir, "quota-export.json"),
    explicitExport: join(root, "export.json"),
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: testPaths.dataDir,
    configDir: testPaths.configDir,
    cacheDir: testPaths.cacheDir,
    stateDir: testPaths.stateDir,
  }),
}));

vi.mock("../src/lib/atomic-json.js", () => ({
  writeJsonAtomic: vi.fn(),
}));

// --------------- imports ---------------

import { writeJsonAtomic } from "../src/lib/atomic-json.js";
import { resolveExportPath, writeQuotaExport } from "../src/lib/quota-export.js";

// --------------- describe blocks ---------------

describe("resolveExportPath", () => {
  it("handles empty, tilde, absolute, and relative paths", () => {
    expect(resolveExportPath("")).toBe(testPaths.defaultExport);
    expect(resolveExportPath("~/my-exports/quota.json")).toBe(
      join(homedir(), "my-exports/quota.json"),
    );
    expect(resolveExportPath("/etc/opencode/export.json")).toBe("/etc/opencode/export.json");
    expect(resolveExportPath("relative/path/quota.json")).toBe("relative/path/quota.json");
  });

  it("expands Windows-style home-relative paths across platforms", () => {
    expect(resolveExportPath("~\\exports\\quota.json")).toBe(
      join(homedir(), "exports", "quota.json"),
    );
    expect(resolveExportPath("~\\exports\\\\nested\\quota.json")).toBe(
      join(homedir(), "exports", "nested", "quota.json"),
    );
    expect(resolveExportPath("~\\")).toBe(homedir());
  });

  it("leaves unsupported tilde and ordinary backslash paths unchanged", () => {
    expect(resolveExportPath("~")).toBe("~");
    expect(resolveExportPath("~user/exports")).toBe("~user/exports");
    expect(resolveExportPath("relative\\path.json")).toBe("relative\\path.json");
    expect(resolveExportPath("C:\\exports\\quota.json")).toBe("C:\\exports\\quota.json");
    expect(resolveExportPath("\\\\server\\share\\quota.json")).toBe(
      "\\\\server\\share\\quota.json",
    );
    expect(resolveExportPath("~/literal\\name.json")).toBe(join(homedir(), "literal\\name.json"));
  });
});

describe("writeQuotaExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls writeJsonAtomic with the resolved path and trailing newline", async () => {
    const exportData: any = { version: 2, providers: {} };
    await writeQuotaExport(exportData, testPaths.explicitExport);

    expect(writeJsonAtomic).toHaveBeenCalledWith(testPaths.explicitExport, exportData, {
      trailingNewline: true,
    });
  });
});
