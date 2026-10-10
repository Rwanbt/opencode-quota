/**
 * The status line at the bottom of Home, with the display settings a v5 config converts to.
 * JSX here builds plain `{ type, props }` nodes and never calls a component, so a test reads
 * what HomeFooter asks Solid to show.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertV5 } from "../src/settings/index.js";
import { applyDisplayImport, createDisplayStore } from "../src/tui/display.js";
import type { SurfaceHost } from "../src/tui/sidebar.js";

type Node = { type: unknown; props: Record<string, any> };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-tui-status-line-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => ({
      type,
      props: { ...props, children: children.length > 1 ? children : children[0] },
    }),
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

/** OpenCode's plugin storage: one live value per key, changed only through `update`. */
function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    store<Value extends object>(key: string, options: { readonly initial: Value }) {
      if (!values.has(key)) values.set(key, structuredClone(options.initial));
      const value = values.get(key) as Value;
      return [value, async (mutation: (draft: Value) => void) => mutation(value)] as const;
    },
  };
}

function findAll(node: unknown, match: (node: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [...(match(element) ? [element] : []), ...findAll(element.props?.children, match)];
}

describe("HomeFooter", () => {
  it("shows the status line on Home for a v5 config that showed it only on Home", async () => {
    const v5 = join(root, "config", "opencode-quota", "quota-toast.jsonc");
    mkdirSync(join(root, "config", "opencode-quota"), { recursive: true });
    writeFileSync(
      v5,
      JSON.stringify({
        tuiCompactStatus: { enabled: true, sessionPrompt: false, homeBottom: true },
      }),
    );
    const conversion = await convertV5();
    const storage = memoryStorage();
    await applyDisplayImport(storage, conversion?.displayImport ?? {});
    const display = createDisplayStore(storage).shown;
    expect(display().surfaces.statusLine.enabled).toBe(false);

    const { HomeFooter, StatusLine } = await import("../src/tui/status-line.tsx");
    const host = {
      theme: () => ({ text: { muted: "muted" } }),
      display,
      quota: { homeLine: () => "", watchHome: () => () => {} },
    } as unknown as SurfaceHost;
    const footer = HomeFooter({ host });

    // Every <Show> around the status line: the footer's own, then the status line's.
    const shows = findAll(
      footer,
      (node) =>
        "when" in node.props &&
        findAll(node.props.children, (child) => child.type === StatusLine).length > 0,
    );
    expect(shows.map((node) => node.props.when)).toEqual([true, true]);
  });
});
