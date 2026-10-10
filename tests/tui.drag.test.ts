import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import { draggedTo, dropIndex, movedBy, surfaceTree } from "../src/tui/window/drag.js";
import type { SurfaceRows } from "../src/view/select.js";

function provider(providerId: string, rowKeys: string[]): ProviderSnapshot {
  const rows = rowKeys.map(
    (key): QuotaRow => ({
      id: `${providerId}.${key}`,
      providerId,
      label: key,
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
    }),
  );
  return { providerId, label: providerId, rows, refreshing: false, debug: [] };
}

const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [provider("a", ["x", "y"]), provider("b", ["z"]), provider("c", ["u", "v", "w"])],
  resetNotices: [],
  generatedAtMs: 0,
};
const ROWS: SurfaceRows = defaultDisplaySettings().surfaces.sidebar;

/** The tree's lines after `change`, top to bottom. */
function linesAfter(change: (rows: SurfaceRows) => SurfaceRows, withRows = true): string[] {
  return surfaceTree(SNAPSHOT, change(ROWS)).flatMap(({ provider, rowIds }) => [
    provider.providerId,
    ...(withRows ? rowIds : []),
  ]);
}

describe("the Settings tree's drag math", () => {
  it.each([
    { name: "same heights, down one", from: 0, heights: [1, 1, 1], pointer: 1, expected: 1 },
    { name: "same heights, to the end", from: 0, heights: [1, 1, 1], pointer: 9, expected: 2 },
    { name: "same heights, up to the top", from: 2, heights: [1, 1, 1], pointer: -3, expected: 0 },
    {
      name: "a tall block, still inside itself",
      from: 0,
      heights: [3, 1],
      pointer: 2,
      expected: 0,
    },
    { name: "a tall block, onto the next one", from: 0, heights: [3, 1], pointer: 3, expected: 1 },
    // Moved down, the tall block now starts at line 1: line 2 is still inside it, so it stays.
    { name: "a tall block, no flip back", from: 1, heights: [1, 3], pointer: 2, expected: 1 },
    { name: "a short block, inside a tall one", from: 1, heights: [3, 1], pointer: 1, expected: 1 },
    {
      name: "a short block, at a tall one's top",
      from: 1,
      heights: [3, 1],
      pointer: 0,
      expected: 0,
    },
    { name: "a short block, past a tall one", from: 0, heights: [1, 3], pointer: 2, expected: 0 },
    { name: "a short block, at its end", from: 0, heights: [1, 3], pointer: 3, expected: 1 },
  ])("$name", ({ from, heights, pointer, expected }) => {
    expect(dropIndex(from, heights, pointer)).toBe(expected);
  });

  it("moves a provider with its rows, and a row only inside its provider", () => {
    expect(linesAfter((rows) => movedBy(surfaceTree(SNAPSHOT, rows), rows, "a", 1))).toEqual([
      "b",
      "b.z",
      "a",
      "a.x",
      "a.y",
      "c",
      "c.u",
      "c.v",
      "c.w",
    ]);
    expect(linesAfter((rows) => movedBy(surfaceTree(SNAPSHOT, rows), rows, "c.u", 5))).toEqual([
      "a",
      "a.x",
      "a.y",
      "b",
      "b.z",
      "c",
      "c.v",
      "c.w",
      "c.u",
    ]);
    // Nothing moves past an end, so the settings stay the same object.
    expect(movedBy(surfaceTree(SNAPSHOT, ROWS), ROWS, "a", -1)).toBe(ROWS);
  });

  it("drags a provider block by the line under the pointer", () => {
    const tree = surfaceTree(SNAPSHOT, ROWS);
    // Lines: a 0, a.x 1, a.y 2, b 3, b.z 4, c 5..8. Block a onto c's last line goes last.
    expect(linesAfter((rows) => draggedTo(tree, rows, "a", 8, true)).slice(0, 4)).toEqual([
      "b",
      "b.z",
      "c",
      "c.u",
    ]);
    // On a one-line-per-provider tab the blocks are one line each.
    expect(linesAfter((rows) => draggedTo(tree, rows, "c", 0, false), false)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps a dragged row inside its provider, wherever the pointer goes", () => {
    const tree = surfaceTree(SNAPSHOT, ROWS);
    const cRows = (pointer: number) =>
      linesAfter((rows) => draggedTo(tree, rows, "c.w", pointer, true)).slice(6);
    // c's rows are on lines 6 to 8; above them the row goes first, never into b.
    expect([cRows(0), cRows(7), cRows(99)]).toEqual([
      ["c.w", "c.u", "c.v"],
      ["c.u", "c.w", "c.v"],
      ["c.u", "c.v", "c.w"],
    ]);
  });
});
