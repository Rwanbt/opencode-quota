import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", () => ({
  Show: (props: { children?: unknown }) => props.children,
  Index: (props: { children?: unknown }) => props.children,
  createEffect: vi.fn(),
  createSignal: <T>(value: T) => [() => value, vi.fn()],
  onCleanup: vi.fn(),
}));

vi.mock("@opentui/solid", () => ({
  createComponent: (component: (props: unknown) => unknown, props: unknown) => component(props),
  createElement: vi.fn(),
  createTextNode: vi.fn(),
  effect: vi.fn(),
  insert: vi.fn(),
  insertNode: vi.fn(),
  memo: (fn: () => unknown) => fn,
  setProp: vi.fn(),
}));

vi.mock("@opentui/solid/preload", () => ({}));

const packagedTui = await import("../dist/tui.js");

describe("tui dist packaging", () => {
  it("loads the conventional root TUI entrypoint as the existing local plugin", async () => {
    const [local, source] = await Promise.all([import("../tui.js"), import("../src/tui-v2.js")]);

    expect(local.default).toBe(source.default);
    expect(local.default).toMatchObject({ id: "@slkiser/opencode-quota" });
    expect(typeof local.default.setup).toBe("function");
  });

  it("ships the precompiled TUI entry without jsx artifacts", async () => {
    const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
    const jsxFiles = (await readdir(distDir, { recursive: true })).filter((file) =>
      /\.jsx(?:\.map)?$/.test(file),
    );
    expect(jsxFiles).toEqual([]);

    // dist/tui.js only re-exports the compiled TUI entry.
    expect(await readFile(new URL("../dist/tui.js", import.meta.url), "utf8")).toBe(
      'export { default } from "./tui-v2.js";\n',
    );
    const source = await readFile(new URL("../dist/tui-v2.js", import.meta.url), "utf8");
    expect(source).toContain("createComponent");
    expect(source).toContain("sidebar.content");
    expect(source).toContain("prompt.footer");
    expect(source).toContain("home.footer.status");
    expect(source).toContain("./rpc.js");
    expect(source).toContain("client.rpc(");
    expect(source).toContain("writeExport");
    expect(source).toContain("registerQuotaCommands");
    expect(source).not.toContain("jsx-dev-runtime");
  });

  it("can load the packaged TUI module", () => {
    expect(packagedTui.default).toMatchObject({
      id: "@slkiser/opencode-quota",
    });
    expect(typeof packagedTui.default.setup).toBe("function");
  });

  it("can load the packaged root module", async () => {
    const mod = await import("../dist/index.js");

    expect(mod.default).toMatchObject({
      id: "@slkiser/opencode-quota.server",
    });
    expect(typeof mod.default.setup).toBe("function");
  });
});
