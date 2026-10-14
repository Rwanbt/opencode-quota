/** @jsxImportSource @opentui/solid */
/**
 * A list down the left of the quota window's tab body: Usage's ranges and Layout's pages. The
 * chosen item has "›" before it and is bold, on the raised background across the list; a muted
 * line runs down the list's right side. A click picks an item. On a short window the list ends
 * at the window's bottom line instead of drawing over it.
 */
import { RGBA, TextAttributes } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import type { WindowTheme } from "./shell.js";

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
/** Each label starts this far in; the chosen one has "› " there. */
const RAIL_INDENT = 2;
/** The muted line at the list's right. */
const LINE_WIDTH = 1;

/** An item of the list: what it picks, its label and its element id. */
export type RailItem<Key extends string> = { key: Key; label: string; id: string };

/** The list's width: the longest label, its indent and 2 more columns. */
function railWidth(labels: readonly string[]): number {
  return RAIL_INDENT + Math.max(...labels.map((label) => label.length)) + 2;
}

/** What the list takes left of the content: the list, the line after it and `gap` columns. */
export function railRoom(labels: readonly string[], gap: number): number {
  return railWidth(labels) + LINE_WIDTH + gap;
}

export function Rail<Key extends string>(props: {
  items: ReadonlyArray<RailItem<Key>>;
  chosen: Key;
  theme: WindowTheme;
  /** Columns between the line and the content. */
  gap: number;
  pick: (key: Key) => void;
}): JSX.Element {
  const width = () => railWidth(props.items.map((item) => item.label));
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width() + LINE_WIDTH}
      marginRight={props.gap}
      overflow="hidden"
      border={["right"]}
      borderStyle="single"
      borderColor={props.theme.text.muted}
    >
      {props.items.map((item) => {
        const chosen = item.key === props.chosen;
        const marker = chosen ? "› " : " ".repeat(RAIL_INDENT);
        return (
          <text
            id={item.id}
            fg={chosen ? props.theme.text.action.primary.selected : props.theme.text.muted}
            bg={chosen ? props.theme.background.raised.high : TRANSPARENT}
            attributes={chosen ? TextAttributes.BOLD : TextAttributes.NONE}
            wrapMode="none"
            flexShrink={0}
            selectable={false}
            onMouseUp={() => props.pick(item.key)}
          >
            {`${marker}${item.label}`.padEnd(width())}
          </text>
        );
      })}
    </box>
  );
}
