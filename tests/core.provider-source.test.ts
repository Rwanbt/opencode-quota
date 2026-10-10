import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keyedLogins } from "../src/core/provider-source.js";
import { createQuotaStore } from "../src/core/store.js";
import type { QuotaRow } from "../src/core/types.js";
import type { QuotaProvider, QuotaProviderResult } from "../src/lib/entries.js";
import { buildQuotaExport } from "../src/lib/quota-export.js";
import { __resetQuotaStateForTests, fetchQuotaProviderResult } from "../src/lib/quota-state.js";
import { __resetResolvedAuthIdentityForTests } from "../src/lib/resolved-auth-identity.js";

const runtime = vi.hoisted(() => ({ root: "" }));

vi.mock("../src/lib/opencode-runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-runtime-paths.js")>()),
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(runtime.root, "data"),
    configDir: join(runtime.root, "config"),
    cacheDir: join(runtime.root, "cache"),
    stateDir: join(runtime.root, "state"),
  }),
}));

const POSIX_IDENTITY_STORAGE = process.platform !== "win32" && typeof process.getuid === "function";
const EMAIL = "alice@example.com";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("provider source logins", () => {
  beforeEach(async () => {
    runtime.root = await mkdtemp(join(tmpdir(), "opencode-quota-logins-"));
    __resetResolvedAuthIdentityForTests();
  });

  afterEach(async () => {
    __resetResolvedAuthIdentityForTests();
    await rm(runtime.root, { recursive: true, force: true });
  });

  it.runIf(POSIX_IDENTITY_STORAGE)(
    "keys logins with the install's protected key, so a saved login can't be matched to an email",
    async () => {
      const [login, none] = await keyedLogins("google-gemini-cli", [EMAIL, ""]);
      expect(none).toBe("");
      expect(login).not.toContain("alice");
      expect(await keyedLogins("google-gemini-cli", [EMAIL])).toEqual([login]);
      expect(await keyedLogins("google-agy", [EMAIL])).not.toEqual([login]);

      // The store saves a hash of the keyed id, never one anyone can recompute from an email.
      const row: QuotaRow = {
        id: "google-gemini-cli.pro",
        providerId: "google-gemini-cli",
        label: "Pro",
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        window: "day",
        prominence: "primary",
        percentRemaining: 50,
      };
      const file = join(runtime.root, "state", "snapshot-v6.json");
      const store = createQuotaStore({
        source: async () => ({
          providers: [
            {
              id: "google-gemini-cli",
              label: "Gemini CLI",
              identity: async () => ({ key: "account", persist: true }),
              fetch: async () => ({ rows: [row], rowLogins: [login ?? ""], debug: [] }),
            },
          ],
          minIntervalMs: 0,
        }),
        file,
        log: () => {},
      });
      await store.refresh({ reason: "manual" });
      await store.dispose();
      const saved = await readFile(file, "utf8");
      expect(saved).not.toContain(sha256(EMAIL).slice(0, 16));
      expect(saved).not.toContain("alice");

      // Another install (another key) gets other ids.
      await rm(join(runtime.root, "state"), { recursive: true, force: true });
      __resetResolvedAuthIdentityForTests();
      expect(await keyedLogins("google-gemini-cli", [EMAIL])).not.toEqual([login]);
    },
  );
});

describe("export after a failed check", () => {
  beforeEach(async () => {
    runtime.root = await mkdtemp(join(tmpdir(), "opencode-quota-export-failure-"));
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    __resetQuotaStateForTests();
    await rm(runtime.root, { recursive: true, force: true });
  });

  it("shows the provider's last failure, not 'unavailable', until a check works again", async () => {
    const accounting = {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    } as const;
    const left = (percentRemaining: number): QuotaProviderResult => ({
      attempted: true,
      entries: [{ accounting, name: "Claude", percentRemaining }],
      errors: [],
    });
    const answers = [
      left(80),
      { attempted: true, entries: [], errors: [{ label: "Claude", message: "HTTP 503" }] },
      left(70),
    ];
    const provider = {
      id: "anthropic",
      cachePolicy: { kind: "account-neutral" },
      isAvailable: async () => true,
      fetch: async () => answers.shift(),
    } as unknown as QuotaProvider;
    const ctx = { client: {}, config: { onlyCurrentModel: false } } as never;
    // The store's fetch, then the export file's read.
    const checkThenExport = async () => {
      await fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
      const exported = await buildQuotaExport({
        providers: [provider],
        ctx,
        ttlMs: 60_000,
        fromCache: true,
      });
      return exported.providers.anthropic;
    };

    expect(await checkThenExport()).toMatchObject({ status: "ok" });
    expect(await checkThenExport()).toMatchObject({ status: "error", error: "HTTP 503" });
    expect(await checkThenExport()).toMatchObject({
      status: "ok",
      entries: [{ percentRemaining: 70 }],
    });
  });
});
