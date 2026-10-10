import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const { mockProviders, runtimeDirs } = vi.hoisted(() => ({
  mockProviders: [] as any[],
  runtimeDirs: {
    value: {
      dataDir: "/tmp/opencode-quota-cli-status-data",
      configDir: "/tmp/opencode-quota-cli-status-config",
      cacheDir: "/tmp/opencode-quota-cli-status-cache",
      stateDir: "/tmp/opencode-quota-cli-status-state",
    },
  },
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => runtimeDirs.value,
}));

// The real price list choice; no price download.
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  maybeRefreshPricingSnapshot: vi.fn(async () => ({ attempted: false, updated: false })),
}));

// The real report, watched so a test can see its arguments or make it fail.
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>();
  return { ...actual, buildStatusReportData: vi.fn(actual.buildStatusReportData) };
});

import { runCliStatusCommand } from "../src/lib/cli-status.js";
import {
  __resetPricingSnapshotForTests,
  getPricingRefreshPolicy,
  getPricingSnapshotSelection,
} from "../src/lib/modelsdev-pricing.js";
import { getCredentialSourceDiagnostics } from "../src/lib/opencode-auth.js";
import { buildStatusReportData } from "../src/lib/quota-dialog-commands.js";

function createCaptureStream() {
  let output = "";
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      },
    },
    get output() {
      return output;
    },
  };
}

/** The Synthetic provider; its check answers with `entries` and `errors`. */
function synthetic(
  entries: object[] = [
    {
      accounting: TEST_ACCOUNTING,
      name: "Synthetic Weekly",
      label: "Weekly:",
      percentRemaining: 75,
    },
  ],
  errors: object[] = [],
  available = true,
) {
  return {
    id: "synthetic",
    cachePolicy: { kind: "account-neutral" as const },
    isAvailable: vi.fn().mockResolvedValue(available),
    fetch: vi.fn(async () => ({ attempted: true, entries, errors })),
  };
}

const FAILED_CHECK = [{ label: "Synthetic", message: "quota endpoint unavailable" }];

describe("runCliStatusCommand", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  async function runStatus(argv: string[]) {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const code = await runCliStatusCommand({
      argv,
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });
    return { code, stdout: stdout.output, stderr: stderr.output };
  }

  function writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(globalConfigDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(globalConfigDir, "opencode-quota", "settings.jsonc"),
      JSON.stringify(settings),
      "utf8",
    );
  }

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-status-"));
    globalConfigDir = join(tempDir, "global-config", "opencode");
    workspaceDir = join(tempDir, "workspace");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    runtimeDirs.value = {
      dataDir: join(tempDir, "data"),
      configDir: globalConfigDir,
      cacheDir: join(tempDir, "cache"),
      stateDir: join(tempDir, "state"),
    };
    vi.stubEnv("OPENCODE_DB", join(tempDir, "opencode.db"));
    mockProviders.length = 0;
    vi.mocked(buildStatusReportData).mockClear();
    __resetPricingSnapshotForTests();
    writeSettings({ providers: { enabled: ["synthetic"] } });
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints a plain-text Quota Status report and returns zero", async () => {
    mockProviders.push(synthetic());
    const result = await runStatus([]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Quota Status");
    expect(result.stdout).toContain("- enabledProviders: synthetic");
    expect(result.stdout).toContain("\nsynthetic:\n- state: ok");
    expect(result.stderr).toBe("");
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: undefined }),
    );
  });

  it("checks the providers with the price list and refresh age the settings choose", async () => {
    writeSettings({
      providers: { enabled: ["synthetic"] },
      pricing: { source: "bundled", autoRefreshDays: 3 },
    });
    const seen: Array<{ source: string; maxAgeMs: number }> = [];
    const provider = synthetic();
    provider.fetch.mockImplementation(async () => {
      seen.push({
        source: getPricingSnapshotSelection(),
        maxAgeMs: getPricingRefreshPolicy().maxAgeMs,
      });
      return { attempted: true, entries: [], errors: [] };
    });
    mockProviders.push(provider);

    await runStatus([]);

    expect(seen).toEqual([{ source: "bundled", maxAgeMs: 3 * 24 * 60 * 60 * 1000 }]);
  });

  it("--json emits a structured payload and returns zero when live probes exist", async () => {
    mockProviders.push(synthetic());
    const result = await runStatus(["--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("version", expect.any(String));
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed.config).toMatchObject({ enabledProviders: ["synthetic"] });
    expect(parsed.providers).toEqual([{ id: "synthetic", enabled: true, available: true }]);
    expect(parsed).toHaveProperty("pricing");
    expect(parsed.liveProbes).toEqual([{ id: "synthetic", ok: true }]);
  });

  it("--json exits 2 when there is no comparable provider data", async () => {
    mockProviders.push(synthetic(undefined, undefined, false));
    const result = await runStatus(["--json"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    // JSON still prints on exit 2.
    const parsed = JSON.parse(result.stdout);
    expect(parsed.liveProbes).toEqual([]);
  });

  it("--json exits 2 when probes fail without producing quota entries", async () => {
    mockProviders.push(synthetic([], FAILED_CHECK));
    const result = await runStatus(["--json"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).liveProbes).toEqual([{ id: "synthetic", ok: false }]);
  });

  it("--json succeeds when a partial probe produced quota entries", async () => {
    mockProviders.push(synthetic(undefined, FAILED_CHECK));
    const result = await runStatus(["--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).liveProbes).toEqual([{ id: "synthetic", ok: false }]);
  });

  it("--provider filters the report to one provider", async () => {
    mockProviders.push(synthetic());
    const result = await runStatus(["--provider", "synthetic"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: "synthetic" }),
    );
  });

  it("resolves a case-insensitive provider synonym before filtering", async () => {
    const result = await runStatus(["--provider", "  CLAUDE  "]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: "anthropic" }),
    );
  });

  it("--provider --json forwards the provider filter and still emits JSON", async () => {
    mockProviders.push(synthetic());
    const result = await runStatus(["--json", "--provider", "synthetic"]);

    expect(result.code).toBe(0);
    expect(buildStatusReportData).toHaveBeenCalledWith(
      expect.objectContaining({ providerFilterId: "synthetic" }),
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed).not.toHaveProperty("providerFilterId");
  });
  it("rejects --threshold with a redirect to show --json --threshold", async () => {
    const result = await runStatus(["--threshold", "50"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--threshold is not supported by status");
    expect(result.stderr).toContain("opencode-quota show --json --threshold");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("rejects --threshold even when combined with --json", async () => {
    const result = await runStatus(["--json", "--threshold=10"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold is not supported by status");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider before building the report", async () => {
    const result = await runStatus(["--provider", "not-a-provider"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown provider: not-a-provider");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("rejects a missing --provider value", async () => {
    const result = await runStatus(["--provider"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --provider");
    expect(result.stderr).toContain("opencode-quota status");
  });

  it("rejects an unknown flag", async () => {
    const result = await runStatus(["--bogus"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --bogus");
    expect(result.stderr).toContain("opencode-quota status");
  });

  it("prints help and returns zero for --help", async () => {
    const result = await runStatus(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("opencode-quota status");
    expect(result.stdout).toContain("Exit codes:");
    expect(buildStatusReportData).not.toHaveBeenCalled();
  });

  it("returns non-zero when report building throws", async () => {
    vi.mocked(buildStatusReportData).mockRejectedValueOnce(new Error("boom"));
    const result = await runStatus([]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Failed to generate quota status: boom");
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
  });

  it("builds the report with the database login source bound and unbinds it afterwards", async () => {
    let sourceDuringRun: unknown;
    const provider = synthetic();
    provider.fetch.mockImplementation(async () => {
      sourceDuringRun = getCredentialSourceDiagnostics();
      return { attempted: true, entries: [], errors: [] };
    });
    mockProviders.push(provider);

    const result = await runStatus([]);

    expect(result.code).toBe(0);
    expect(sourceDuringRun).toMatchObject({ state: "bound", kind: "sqlite" });
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
  });
});
