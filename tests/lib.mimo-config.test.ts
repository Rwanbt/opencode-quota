import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePathMocks = vi.hoisted(() => ({
  getOpencodeRuntimeDirs: vi.fn(),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: runtimePathMocks.getOpencodeRuntimeDirs,
}));

import {
  getMimoConfigDiagnostics,
  normalizeMimoCookieHeader,
  resolveMimoConfig,
  resolveMimoConfigCached,
} from "../src/lib/mimo-config.js";

const originalEnv = process.env;
const tempRoots: string[] = [];
const requiredCookie = "api-platform_serviceToken=service-secret; userId=user-secret";

/** Points the config dir at a new temp dir and writes `mimo.json` there when `body` is given. */
async function useConfigFile(body?: string): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "mimo-config-"));
  tempRoots.push(configDir);
  runtimePathMocks.getOpencodeRuntimeDirs.mockReturnValue({ configDir });
  const path = join(configDir, "opencode-quota", "mimo.json");
  if (body !== undefined) {
    await mkdir(join(configDir, "opencode-quota"));
    await writeFile(path, body);
  }
  return path;
}

describe("MiMo config resolution", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MIMO_USAGE_COOKIE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the optional Cookie prefix and retains only the fixed cookie set", () => {
    expect(
      normalizeMimoCookieHeader(
        " Cookie: ignored=drop; userId=user=part; api-platform_slh=slh; " +
          "api-platform_serviceToken=service; api-platform_ph=ph ",
      ),
    ).toBe(
      "api-platform_serviceToken=service; userId=user=part; api-platform_ph=ph; api-platform_slh=slh",
    );
    expect(
      normalizeMimoCookieHeader("cookie: api-platform_serviceToken=service; userId=user"),
    ).toBe("api-platform_serviceToken=service; userId=user");
  });

  it.each([
    ["missing service token", "userId=user"],
    ["missing user id", "api-platform_serviceToken=service"],
    [
      "duplicate retained name",
      "api-platform_serviceToken=first; userId=user; api-platform_serviceToken=second",
    ],
    ["empty retained value", "api-platform_serviceToken=; userId=user"],
    ["malformed pair", "api-platform_serviceToken=service; malformed; userId=user"],
    ["CR injection", "api-platform_serviceToken=service; userId=user\rignored=value"],
    ["LF injection", "api-platform_serviceToken=service; userId=user\nignored=value"],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeMimoCookieHeader(raw)).toBeNull();
  });

  it("prefers the environment and never reads a lower-priority valid file", async () => {
    await useConfigFile(JSON.stringify({ cookie: requiredCookie }));
    process.env.MIMO_USAGE_COOKIE =
      "Cookie: userId=env-user; ignored=value; api-platform_serviceToken=env-service";

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "configured",
      source: "env:MIMO_USAGE_COOKIE",
      config: {
        cookie: "api-platform_serviceToken=env-service; userId=env-user",
      },
    });
  });

  it.each([
    " ",
    "Cookie: userId=private-user",
  ])("treats a defined invalid environment value %j as blocking without echoing it", async (envValue) => {
    await useConfigFile(JSON.stringify({ cookie: requiredCookie }));
    process.env.MIMO_USAGE_COOKIE = envValue;

    const result = await resolveMimoConfig();

    expect(result).toEqual({
      state: "invalid",
      source: "env:MIMO_USAGE_COOKIE",
      error: "Invalid cookie header",
    });
    expect(JSON.stringify(result)).not.toMatch(/private-user|userId/);
  });

  it("returns none when the environment and config file are both absent", async () => {
    await useConfigFile();
    await expect(resolveMimoConfig()).resolves.toEqual({ state: "none" });
  });

  it("reads the trusted user/global config file when the environment is absent", async () => {
    const path = await useConfigFile(
      JSON.stringify({
        cookie:
          "api-platform_ph=ph; userId=file-user; api-platform_serviceToken=file-service; other=no",
      }),
    );

    await expect(resolveMimoConfig()).resolves.toEqual({
      state: "configured",
      source: path,
      config: {
        cookie: "api-platform_serviceToken=file-service; userId=file-user; api-platform_ph=ph",
      },
    });
  });

  it.each([
    ["invalid JSON", "{", "Failed to parse JSON"],
    ["array", "[]", "Config file must contain a JSON object"],
    ["missing cookie", "{}", "Config file must contain only the cookie field"],
    [
      "endpoint override",
      JSON.stringify({ cookie: requiredCookie, endpoint: "https://example.test" }),
      "Config file must contain only the cookie field",
    ],
    ["wrong cookie type", JSON.stringify({ cookie: 123 }), "Config cookie field must be a string"],
    [
      "invalid cookie",
      JSON.stringify({ cookie: "api-platform_serviceToken=secret" }),
      "Invalid cookie header",
    ],
  ])("rejects a config file with %s", async (_label, body, error) => {
    const path = await useConfigFile(body);

    await expect(resolveMimoConfig()).resolves.toEqual({ state: "invalid", source: path, error });
  });

  it("caches resolved credentials within the configured TTL", async () => {
    const path = await useConfigFile(JSON.stringify({ cookie: requiredCookie }));

    const first = await resolveMimoConfigCached({ maxAgeMs: 5_000 });
    await writeFile(
      path,
      JSON.stringify({
        cookie: "api-platform_serviceToken=changed-service; userId=changed-user",
      }),
    );

    await expect(resolveMimoConfigCached({ maxAgeMs: 5_000 })).resolves.toEqual(first);
  });

  it("reports trusted checked paths without exposing cookie names or values", async () => {
    const path = await useConfigFile();
    process.env.MIMO_USAGE_COOKIE = requiredCookie;

    const diagnostics = await getMimoConfigDiagnostics();
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics).toEqual({
      state: "configured",
      source: "env:MIMO_USAGE_COOKIE",
      error: null,
      checkedPaths: [path],
    });
    expect(serialized).not.toContain("service-secret");
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("api-platform_serviceToken");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("auth.json");
  });
});
