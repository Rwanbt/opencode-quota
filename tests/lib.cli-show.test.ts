import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer, percentRow } from "./helpers/fake-answers.js";

const { authMocks, mockProviders, runtimeDirs } = vi.hoisted(() => ({
  authMocks: {
    anthropicConfigured: false,
    kimiGlobalState: "none" as "none" | "configured",
    kimiCnState: "none" as "none" | "configured",
  },
  mockProviders: [] as any[],
  runtimeDirs: {
    value: {
      dataDir: "/tmp/opencode-quota-cli-show-data",
      configDir: "/tmp/opencode-quota-cli-show-config",
      cacheDir: "/tmp/opencode-quota-cli-show-cache",
      stateDir: "/tmp/opencode-quota-cli-show-state",
    },
  },
}));

vi.mock("../src/lib/anthropic.js", () => ({
  hasAnthropicCredentialsConfigured: vi.fn(async () => authMocks.anthropicConfigured),
}));

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api-key-resolver.js")>();
  return {
    ...actual,
    resolveApiKeyLogin: vi.fn(async (spec: unknown) => ({
      state:
        spec === actual.API_KEY_LOGIN_VENDORS["kimi-code-plan-global"]
          ? authMocks.kimiGlobalState
          : spec === actual.API_KEY_LOGIN_VENDORS["kimi-code-plan-cn"]
            ? authMocks.kimiCnState
            : "none",
    })),
  };
});

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => runtimeDirs.value,
}));

const { snapshotFilePath } = await import("../src/core/persist.js");
const { loadProviderSource } = await import("../src/core/provider-source.js");
const { createQuotaStore } = await import("../src/core/store.js");
const { createCliQuotaClient, runCliShowCommand } = await import("../src/lib/cli-show.js");
const { clearReadAuthFileCacheForTests, getCredentialSourceDiagnostics, readCredentialRows } =
  await import("../src/lib/opencode-auth.js");
const { __resetPricingSnapshotForTests, getPricingRefreshPolicy, getPricingSnapshotSelection } =
  await import("../src/lib/modelsdev-pricing.js");
const { loadSettings } = await import("../src/settings/index.js");
const { writeCredentialDatabase } = await import("./helpers/credential-database.js");

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

describe("runCliShowCommand", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  function writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(globalConfigDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(globalConfigDir, "opencode-quota", "settings.jsonc"),
      JSON.stringify(settings),
      "utf8",
    );
  }

  beforeEach(() => {
    authMocks.anthropicConfigured = false;
    authMocks.kimiGlobalState = "none";
    authMocks.kimiCnState = "none";
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-show-"));
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
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    clearReadAuthFileCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("synthesizes offline Kimi runtime ids independently by region", async () => {
    writeFileSync(join(workspaceDir, "opencode.json"), "{}", "utf8");

    const client = () =>
      createCliQuotaClient({ configRootDir: workspaceDir, anthropicBinaryPath: "claude" });
    const unauthenticated = await client().config.providers();
    expect(unauthenticated.data?.providers).toEqual([]);

    authMocks.anthropicConfigured = true;
    authMocks.kimiCnState = "configured";
    const cnOnly = await client().config.providers();
    expect(cnOnly.data?.providers).toEqual([{ id: "anthropic" }, { id: "kimi-code-plan-cn" }]);

    authMocks.kimiGlobalState = "configured";
    const bothRegions = await client().config.providers();
    expect(bothRegions.data?.providers).toEqual([
      { id: "anthropic" },
      { id: "kimi-code-plan-global" },
      { id: "kimi-code-plan-cn" },
    ]);
  });

  it("renders a compact quota glance and returns zero when quota rows are available", async () => {
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Synthetic", rows: [percentRow("weekly", "Weekly", 75)] }),
        ),
    };
    mockProviders.push(provider);
    writeSettings({ providers: { enabled: ["synthetic"] } });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Synthetic Weekly");
    expect(stdout.output).toContain("75%");
    expect(stderr.output).toBe("");
    expect(provider.fetch).toHaveBeenCalledOnce();
  });

  it("checks the providers with the price list and refresh age the settings choose", async () => {
    __resetPricingSnapshotForTests();
    const seen: Array<{ source: string; maxAgeMs: number }> = [];
    mockProviders.push({
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(async () => {
        const maxAgeMs = getPricingRefreshPolicy().maxAgeMs;
        seen.push({ source: getPricingSnapshotSelection(), maxAgeMs });
        return answer();
      }),
    });
    writeSettings({
      providers: { enabled: ["synthetic"] },
      pricing: { source: "bundled", autoRefreshDays: 3 },
    });

    await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: createCaptureStream().stream as any,
      stderr: createCaptureStream().stream as any,
    });

    expect(seen).toEqual([{ source: "bundled", maxAgeMs: 3 * 24 * 60 * 60 * 1000 }]);
  });

  it("reads logins from OpenCode's database, read-only, only while the command runs", async () => {
    const databasePath = join(tempDir, "opencode.db");
    writeCredentialDatabase(databasePath, [
      {
        id: "cred_synthetic",
        integrationId: "synthetic",
        active: 1,
        updated: 1,
        value: { type: "key", key: "synthetic-key" },
      },
    ]);
    const databaseBefore = readFileSync(databasePath);
    let rowsDuringRun: unknown;
    let sourceDuringRun: unknown;
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(async () => {
        rowsDuringRun = await readCredentialRows(["synthetic"]);
        sourceDuringRun = getCredentialSourceDiagnostics();
        return answer({ name: "Synthetic", rows: [percentRow("weekly", "Weekly", 75)] });
      }),
    };
    mockProviders.push(provider);
    writeSettings({ providers: { enabled: ["synthetic"] } });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(rowsDuringRun).toEqual([
      {
        id: "cred_synthetic",
        integrationId: "synthetic",
        label: "default",
        active: true,
        value: { type: "api", key: "synthetic-key" },
      },
    ]);
    expect(sourceDuringRun).toMatchObject({ state: "bound", kind: "sqlite" });
    expect(getCredentialSourceDiagnostics().state).toBe("unbound");
    expect(readFileSync(databasePath).equals(databaseBefore)).toBe(true);
  });

  it("normalizes --provider aliases and checks only that provider", async () => {
    const copilotProvider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 50)] }),
        ),
    };
    const openAiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(answer()),
    };
    mockProviders.push(openAiProvider, copilotProvider);
    writeSettings({ providers: { enabled: ["openai"] } });

    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider=github-copilot"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(copilotProvider.fetch).toHaveBeenCalledOnce();
    expect(openAiProvider.fetch).not.toHaveBeenCalled();
    expect(stderr.output).toBe("");
  });

  it("rejects an unknown provider before probing providers", async () => {
    const provider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mockProviders.push(provider);
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider", "not-a-provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Unknown provider: not-a-provider");
    expect(provider.isAvailable).not.toHaveBeenCalled();
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("rejects missing provider values", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--provider"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("Missing value for --provider");
    expect(stderr.output).toContain("opencode-quota show");
  });

  it("uses root-level OpenCode provider ids for standalone provider availability", async () => {
    const provider = {
      id: "copilot",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn(async (ctx: any) => {
        const response = await ctx.client.config.providers();
        return response.data.providers.some((item: { id: string }) => item.id === "github-copilot");
      }),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Copilot", rows: [percentRow("allowance", "Premium requests", 88)] }),
        ),
    };
    mockProviders.push(provider);
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ provider: { "github-copilot": {} } }),
      "utf8",
    );
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: [],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stdout.output).toContain("Copilot");
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(stderr.output).toBe("");
  });

  // ──────────────────────────────────────────────
  //  --json / --threshold tests
  // ──────────────────────────────────────────────

  it("--json outputs the quota OpenCode saved last", async () => {
    const provider = {
      id: "synthetic",
      cachePolicy: { kind: "account-neutral" as const },
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValue(
          answer({ name: "Synthetic", rows: [percentRow("weekly", "Weekly", 75)] }),
        ),
    };
    mockProviders.push(provider);
    writeSettings({ providers: { enabled: ["synthetic"] } });

    // OpenCode's store checks the providers and saves the snapshot.
    const loaded = await loadSettings();
    const store = createQuotaStore({
      source: () =>
        loadProviderSource({
          client: { config: { providers: async () => ({ data: { providers: [] } }) } },
          workspaceRoot: workspaceDir,
          settings: () => loaded,
        }),
      file: snapshotFilePath(),
    });
    await store.refresh({ reason: "manual" });
    await store.dispose();
    expect(provider.fetch).toHaveBeenCalledOnce();

    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();
    const jsonCode = await runCliShowCommand({
      argv: ["--json"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(0);
    expect(jsonErr.output).toBe("");

    const parsed = JSON.parse(jsonOut.output);
    expect(parsed).toHaveProperty("version", 2);
    expect(parsed).toHaveProperty("exportedAt");
    expect(parsed).toHaveProperty("fromCache", true);
    expect(parsed).toHaveProperty("cacheAgeSeconds");
    expect(parsed.providers).toHaveProperty("synthetic");
    expect(parsed.providers.synthetic.status).toBe("ok");
    expect(parsed.providers.synthetic.entries[0].name).toBe("Synthetic Weekly");
    expect(parsed.providers.synthetic.entries[0].percentRemaining).toBe(75);
    expect(parsed.providers.synthetic.entries[0].renderType).toBe("percent");
    expect(parsed.providers.synthetic.entries[0]).not.toHaveProperty("unlimited");
    expect(provider.fetch).toHaveBeenCalledTimes(1); // only OpenCode's store asked it
  });

  it("reports unknown flag with --json as error on stderr with exit code 1", async () => {
    const jsonOut = createCaptureStream();
    const jsonErr = createCaptureStream();

    const jsonCode = await runCliShowCommand({
      argv: ["--json", "--bogus-flag"],
      cwd: workspaceDir,
      stdout: jsonOut.stream as any,
      stderr: jsonErr.stream as any,
    });

    expect(jsonCode).toBe(1);
    expect(jsonErr.output).toContain("Unknown option: --bogus-flag");
    expect(jsonErr.output).toContain("opencode-quota show");
  });

  it("--threshold validates input and requires --json", async () => {
    const run = async (argv: string[]) => {
      const stdout = createCaptureStream();
      const stderr = createCaptureStream();
      const code = await runCliShowCommand({
        argv,
        cwd: workspaceDir,
        stdout: stdout.stream as any,
        stderr: stderr.stream as any,
      });
      return { code, stderr: stderr.output };
    };

    // Invalid value
    let result = await run(["--json", "--threshold", "abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    // Zero
    result = await run(["--json", "--threshold", "0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold must be a positive finite number");

    // Missing value
    result = await run(["--json", "--threshold"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Missing value for --threshold");

    // Without --json
    result = await run(["--threshold", "5"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--threshold requires --json");
  });

  it("prints help without an OpenCode requirement or exit code 3", async () => {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();

    const code = await runCliShowCommand({
      argv: ["--help"],
      cwd: workspaceDir,
      stdout: stdout.stream as any,
      stderr: stderr.stream as any,
    });

    expect(code).toBe(0);
    expect(stderr.output).toBe("");
    expect(stdout.output).toContain("opencode-quota show");
    expect(stdout.output).not.toContain("OpenCode running");
    expect(stdout.output).not.toMatch(/exit code 3/i);
  });
});
