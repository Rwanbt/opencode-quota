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
      dataDir: "/tmp/opencode-quota-cli-reports-data",
      configDir: "/tmp/opencode-quota-cli-reports-config",
      cacheDir: "/tmp/opencode-quota-cli-reports-cache",
      stateDir: "/tmp/opencode-quota-cli-reports-state",
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

// The real report, watched so a test can see its arguments.
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>();
  return { ...actual, buildStatusReportData: vi.fn(actual.buildStatusReportData) };
});

const { snapshotFilePath } = await import("../src/core/persist.js");
const { loadProviderSource } = await import("../src/core/provider-source.js");
const { createQuotaStore } = await import("../src/core/store.js");
const { buildCliShowJson, buildCliShowText, buildCliStatus } = await import(
  "../src/lib/cli-reports.js"
);
const { buildStatusReportData } = await import("../src/lib/quota-dialog-commands.js");
const { loadSettings } = await import("../src/settings/index.js");
type ProviderSourceHost = import("../src/core/provider-source.js").ProviderSourceHost;

describe("CLI reports", () => {
  let tempDir: string;
  let globalConfigDir: string;
  let workspaceDir: string;
  let savedConfigDir: string | undefined;

  // OpenCode's provider list is the given ids; the settings come from settings.jsonc.
  async function hostFor(providerIds: string[] = []): Promise<ProviderSourceHost> {
    const loaded = await loadSettings();
    return {
      client: {
        config: {
          providers: async () => ({ data: { providers: providerIds.map((id) => ({ id })) } }),
        },
      },
      workspaceRoot: workspaceDir,
      settings: () => loaded,
    };
  }

  function writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(globalConfigDir, "opencode-quota"), { recursive: true });
    writeFileSync(
      join(globalConfigDir, "opencode-quota", "settings.jsonc"),
      JSON.stringify(settings),
      "utf8",
    );
  }

  /** What OpenCode's store saves after checking every enabled provider. */
  async function saveSnapshot(): Promise<void> {
    const host = await hostFor();
    const store = createQuotaStore({
      source: () => loadProviderSource(host),
      file: snapshotFilePath(),
    });
    await store.refresh({ reason: "manual" });
    await store.dispose();
  }

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-cli-reports-"));
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
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    mockProviders.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("buildCliShowText", () => {
    it("renders a compact quota glance and returns zero when quota rows are available", async () => {
      const provider = {
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Synthetic Weekly",
              label: "Weekly:",
              percentRemaining: 75,
            },
          ],
          errors: [],
        }),
      };
      mockProviders.push(provider);
      writeSettings({ providers: { enabled: ["synthetic"] } });

      const report = await buildCliShowText(await hostFor());

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Synthetic Weekly");
      expect(report.stdout).toContain("75%");
      expect(report.stdout.endsWith("\n")).toBe(true);
      expect(report.stderr).toBe("");
      expect(provider.fetch).toHaveBeenCalledOnce();
    });

    it("shows used percents and the time to the reset", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));
      mockProviders.push({
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Synthetic Weekly",
              label: "Weekly:",
              percentRemaining: 81,
              resetTimeIso: "2026-01-17T15:14:00.000Z",
            },
          ],
          errors: [],
        }),
      });
      writeSettings({ providers: { enabled: ["synthetic"] }, words: { percent: "used" } });

      const report = await buildCliShowText(await hostFor());

      expect(report).toEqual({
        exitCode: 0,
        stdout: "Synthetic Weekly    19% used      2d 5h 14m\n",
        stderr: "",
      });
    });

    it("returns non-zero without asking a provider that is not available", async () => {
      const provider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(false),
        fetch: vi.fn(),
      };
      mockProviders.push(provider);
      writeSettings({ providers: { enabled: ["copilot"] } });

      const report = await buildCliShowText(await hostFor());

      expect(report.exitCode).toBe(1);
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it("renders Copilot and Gemini CLI success rows", async () => {
      const copilotProvider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Copilot",
              group: "Copilot (personal)",
              label: "Quota:",
              right: "0/300",
              percentRemaining: 100,
            },
          ],
          errors: [],
        }),
      };
      const geminiCliProvider = {
        id: "google-gemini-cli",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Gemini Pro",
              group: "Gemini CLI",
              label: "Gemini Pro:",
              right: "840 left",
              percentRemaining: 84,
            },
          ],
          errors: [],
        }),
      };
      mockProviders.push(copilotProvider, geminiCliProvider);
      writeSettings({ providers: { enabled: ["copilot", "google-gemini-cli"] } });

      const report = await buildCliShowText(await hostFor());

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(report.stdout).toContain("Gemini CLI");
      expect(copilotProvider.fetch).toHaveBeenCalledOnce();
      expect(geminiCliProvider.fetch).toHaveBeenCalledOnce();
      expect(report.stderr).toBe("");
    });

    it("uses OpenCode's provider ids for provider availability", async () => {
      const provider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn(async (ctx: any) => {
          const response = await ctx.client.config.providers();
          return response.data.providers.some(
            (item: { id: string }) => item.id === "github-copilot",
          );
        }),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 88 }],
          errors: [],
        }),
      };
      mockProviders.push(provider);

      const report = await buildCliShowText(await hostFor(["github-copilot"]));

      expect(report.exitCode).toBe(0);
      expect(report.stdout).toContain("Copilot");
      expect(provider.fetch).toHaveBeenCalledOnce();
      expect(report.stderr).toBe("");
    });
  });

  describe("buildCliShowJson", () => {
    function syntheticProvider(entries: unknown[], errors: unknown[] = [], id = "synthetic") {
      return {
        id,
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({ attempted: true, entries, errors }),
      };
    }

    it("outputs valid JSON with the quota OpenCode saved last", async () => {
      const provider = syntheticProvider([
        { accounting: TEST_ACCOUNTING, name: "Synthetic", label: "Weekly:", percentRemaining: 75 },
      ]);
      mockProviders.push(provider);
      writeSettings({ providers: { enabled: ["synthetic"] } });

      await saveSnapshot();
      expect(provider.fetch).toHaveBeenCalledOnce();

      const report = await buildCliShowJson({ host: await hostFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(report.stdout.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(report.stdout);
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

    it("asks no provider and returns unavailable when nothing was saved", async () => {
      const provider = syntheticProvider([
        { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 100 },
      ]);
      mockProviders.push(provider);
      writeSettings({ providers: { enabled: ["synthetic"] } });

      const report = await buildCliShowJson({ host: await hostFor() });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(JSON.parse(report.stdout).providers.synthetic.status).toBe("unavailable");
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it.each([
      [80, 50, 0],
      [30, 50, 1],
    ])("--threshold uses percentage rows even when the first row is a quantity: %s vs %s", async (percentRemaining, threshold, expectedCode) => {
      mockProviders.push(
        syntheticProvider(
          [
            {
              kind: "quantity",
              accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
              semantic: {
                metric: { kind: "component", component: "current_balance" },
                prominence: "primary",
              },
              name: "kilo-gateway-total-balance",
              quantity: { decimal: "5", unit: { kind: "currency", code: "USD" } },
            },
            { accounting: TEST_ACCOUNTING, name: "kilo-gateway-credits", percentRemaining },
          ],
          [],
          "kilo",
        ),
      );
      writeSettings({ providers: { enabled: ["kilo"] } });

      await saveSnapshot();
      const report = await buildCliShowJson({ host: await hostFor(), threshold });

      expect(report.exitCode).toBe(expectedCode);
    });

    it("--threshold exits 2 when no provider is ok", async () => {
      mockProviders.push(
        syntheticProvider([
          { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 100 },
        ]),
      );
      writeSettings({ providers: { enabled: ["synthetic"] } });

      const report = await buildCliShowJson({ host: await hostFor(), threshold: 10 });

      expect(report.exitCode).toBe(2);
    });

    it("--threshold exits 2 when saved ok providers have no percentRemaining values", async () => {
      mockProviders.push(
        syntheticProvider([
          {
            accounting: TEST_ACCOUNTING,
            name: "Synthetic",
            kind: "value",
            value: "$42",
            label: "Usage:",
          },
        ]),
      );
      writeSettings({ providers: { enabled: ["synthetic"] } });

      await saveSnapshot();
      const report = await buildCliShowJson({ host: await hostFor(), threshold: 10 });

      expect(report.exitCode).toBe(2);
    });

    it("--threshold exits 2 for partial saved results instead of passing incomplete data", async () => {
      mockProviders.push(
        syntheticProvider(
          [{ accounting: TEST_ACCOUNTING, name: "Synthetic", label: "5h:", percentRemaining: 80 }],
          [{ label: "Synthetic secondary", message: "quota endpoint unavailable" }],
        ),
      );
      writeSettings({ providers: { enabled: ["synthetic"] } });

      await saveSnapshot();
      const report = await buildCliShowJson({ host: await hostFor(), threshold: 50 });

      expect(report.exitCode).toBe(2);
      expect(JSON.parse(report.stdout).providers.synthetic).toMatchObject({
        status: "partial",
        entries: [expect.objectContaining({ percentRemaining: 80 })],
        errors: [{ label: "Synthetic", message: "Nothing reported" }],
      });
    });

    it("includes only the providers enabled now", async () => {
      const copilotProvider = {
        id: "copilot",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ accounting: TEST_ACCOUNTING, name: "Copilot", percentRemaining: 90 }],
          errors: [],
        }),
      };
      mockProviders.push(
        copilotProvider,
        syntheticProvider([
          { accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 50 },
        ]),
      );
      writeSettings({ providers: { enabled: ["copilot", "synthetic"] } });
      await saveSnapshot();

      writeSettings({ providers: { enabled: ["copilot"] } });
      const report = await buildCliShowJson({ host: await hostFor() });

      expect(report.exitCode).toBe(0);
      const parsed = JSON.parse(report.stdout);
      expect(Object.keys(parsed.providers)).toEqual(["copilot"]);
      expect(parsed.providers.copilot.status).toBe("ok");
    });
  });

  describe("buildCliStatus", () => {
    /** Synthetic, enabled; its check answers with `entries` and `errors`. */
    function useSynthetic(entries: object[], errors: object[] = []): void {
      mockProviders.push({
        id: "synthetic",
        cachePolicy: { kind: "account-neutral" as const },
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({ attempted: true, entries, errors }),
      });
      writeSettings({ providers: { enabled: ["synthetic"] } });
    }
    const WEEKLY = {
      accounting: TEST_ACCOUNTING,
      name: "Synthetic Weekly",
      label: "Weekly:",
      percentRemaining: 75,
    };
    const FAILED = { label: "Synthetic", message: "quota endpoint unavailable" };

    it("prints a plain-text Quota Status report and returns zero", async () => {
      useSynthetic([WEEKLY]);

      const report = await buildCliStatus({ host: await hostFor(), json: false });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      expect(report.stdout).toMatch(/^# Quota Status/u);
      expect(report.stdout).toContain("- enabledProviders: synthetic");
      expect(report.stdout).toContain("\nsynthetic:\n- state: ok");
      expect(report.stdout.endsWith("\n")).toBe(true);
      expect(buildStatusReportData).toHaveBeenCalledWith(
        expect.objectContaining({ providerFilterId: undefined }),
      );
    });

    it("emits a structured JSON payload and returns zero when live probes exist", async () => {
      useSynthetic([WEEKLY]);

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(0);
      expect(report.stderr).toBe("");
      const parsed = JSON.parse(report.stdout);
      expect(parsed).toHaveProperty("version", expect.any(String));
      expect(parsed).toHaveProperty("generatedAt");
      expect(parsed.config).toMatchObject({ enabledProviders: ["synthetic"] });
      expect(parsed.providers).toEqual([{ id: "synthetic", enabled: true, available: true }]);
      expect(parsed).toHaveProperty("pricing");
      expect(parsed.liveProbes).toEqual([{ id: "synthetic", ok: true }]);
    });

    it("exits 2 with JSON when there is no comparable provider data", async () => {
      writeSettings({ providers: { enabled: ["synthetic"] } });

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(2);
      expect(report.stderr).toBe("");
      // JSON still prints on exit 2.
      expect(JSON.parse(report.stdout).liveProbes).toEqual([]);
    });

    it("exits 2 with JSON when probes fail without producing quota entries", async () => {
      useSynthetic([], [FAILED]);

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(2);
      expect(JSON.parse(report.stdout).liveProbes).toEqual([{ id: "synthetic", ok: false }]);
    });

    it("succeeds with JSON when a partial probe produced quota entries", async () => {
      useSynthetic([WEEKLY], [FAILED]);

      const report = await buildCliStatus({ host: await hostFor(), json: true });

      expect(report.exitCode).toBe(0);
      expect(JSON.parse(report.stdout).liveProbes).toEqual([{ id: "synthetic", ok: false }]);
    });

    it("forwards the provider filter and still emits JSON", async () => {
      useSynthetic([WEEKLY]);

      const report = await buildCliStatus({
        host: await hostFor(),
        providerId: "synthetic",
        json: true,
      });

      expect(report.exitCode).toBe(0);
      expect(buildStatusReportData).toHaveBeenCalledWith(
        expect.objectContaining({ providerFilterId: "synthetic" }),
      );
      const parsed = JSON.parse(report.stdout);
      expect(parsed.providers).toHaveLength(1);
      expect(parsed).not.toHaveProperty("providerFilterId");
    });
  });
});
