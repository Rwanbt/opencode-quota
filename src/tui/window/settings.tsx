/** @jsxImportSource @opentui/solid */
/**
 * The quota window's Settings tabs: Sidebar, Collapsed, Status line, Toast, Colors and Layout.
 * Their setting lines come from the field table in `display.ts`; the surface tabs also list
 * the snapshot's providers (and rows) as a tree you drag, hide and rename. While you edit, the
 * real sidebar, status line and toast show the draft and mark the selected line. Save
 * (ctrl+s) keeps the draft in plugin storage, Discard drops it, and Esc with unsaved changes
 * asks first.
 */
import {
  type BoxRenderable,
  type MouseEvent,
  type Renderable,
  RGBA,
  type ScrollBoxRenderable,
  TextAttributes,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { describeError } from "../../core/errors.js";
import type { ProviderSnapshot, QuotaRow } from "../../core/types.js";
import { WINDOWS } from "../../core/windows.js";
import { DEFAULT_WORDS, fit, percentText, resetText, rowValueText } from "../../view/format.js";
import { pickRow, type Surface, type WindowChoice } from "../../view/select.js";
import type { ColorRole } from "../../view/text.js";
import {
  COLOR_NAMES,
  cycleField,
  cyclePreset,
  type DisplaySettings,
  type DisplayStore,
  FIELDS,
  type Field,
  isSurfaceTab,
  PRESETS,
  type PresetName,
  presetChoice,
  renameRow,
  resetTab,
  type SettingsTab,
  setIn,
  typedColor,
  valueAt,
} from "../display.js";
import type { SurfaceEditing, SurfaceHost } from "../sidebar.js";
import { namedColor, roleColor } from "../theme.js";
import { TOAST_TITLE, toastText } from "../toasts.js";
import { draggedTo, movedBy, surfaceTree, type TreeProvider } from "./drag.js";
import type { WindowTheme } from "./shell.js";

export const SETTINGS_TABS: ReadonlyArray<{
  tab: SettingsTab;
  title: string;
  note: string;
  /** A surface tab's switch on top, and its note while the switch is off. */
  switchTitle?: string;
  offNote?: string;
  /** Its changes show in the sidebar, so it says when the sidebar is hidden. */
  watchesSidebar: boolean;
}> = [
  {
    tab: "sidebar",
    title: "Sidebar",
    switchTitle: "Show the Quota panel in the session sidebar",
    offNote: "Off: the Quota panel is gone from the sidebar →",
    note: "Watch the Quota panel in the sidebar →  Drag ⠿ to move a provider (its rows come along) or a row inside its provider. [x] shows or hides it.",
    watchesSidebar: true,
  },
  {
    tab: "collapsed",
    title: "Collapsed",
    switchTitle: "When the panel is collapsed, show one line per provider",
    offNote: "Off: the collapsed panel shows only its title →",
    note: "The sidebar panel stays collapsed while this tab is open →  Click ‹ › to pick a window.",
    watchesSidebar: true,
  },
  {
    tab: "statusLine",
    title: "Status line",
    switchTitle: "Show the quota line under the message box",
    offNote: "Off: the quota line under the message box is gone ↓",
    note: "Watch the line under the message box ↓  It fills the room OpenCode leaves free. Mouse wheel scrolls it.",
    watchesSidebar: false,
  },
  {
    tab: "toast",
    title: "Toast",
    switchTitle: "Show quota toasts",
    offNote: "Off: quota never shows a toast.",
    note: "OpenCode shows one toast at a time, so quota only takes a turn when you say so. The toast shows again after each change here. Toasts can't have colors.",
    watchesSidebar: false,
  },
  {
    tab: "colors",
    title: "Colors",
    note: "Quota uses your OpenCode theme's colors, so changing the theme here recolors everything. Change one line below to override only that color.",
    watchesSidebar: true,
  },
  {
    tab: "layout",
    title: "Layout",
    note: "Bars and spacing. Watch the sidebar → and the line under the message box ↓",
    watchesSidebar: true,
  },
];

export function isSettingsTab(tab: string | undefined): tab is SettingsTab {
  return SETTINGS_TABS.some((item) => item.tab === tab);
}

type SettingsKey = {
  bind: string;
  title: string;
  group: string;
  run: () => void;
};

/** What the Settings tabs need from OpenCode's TUI context. */
export type SettingsHost = {
  theme: WindowTheme;
  themeMode?: "dark" | "light";
  renderer: { useMouse?: boolean };
  keymap: {
    layer(
      build: () => {
        target?: () => Renderable | undefined;
        priority: number;
        enabled?: () => boolean;
        commands: SettingsKey[];
      },
    ): void;
    /** Runs one of OpenCode's own commands, like the theme list. */
    dispatch(id: string): void;
  };
  ui: {
    toast: {
      show(toast: {
        variant: "info" | "success" | "error";
        title: string;
        message: string;
        duration: number;
      }): void;
    };
  };
};

export type SettingsEditor = SurfaceEditing & {
  /** A line takes typed text now, so the window's own keys rest. */
  typing(): boolean;
  /** The window shows `tab` now; undefined when it closed, which drops the draft. */
  setTab(tab: string | undefined): void;
  /** Esc or Close: true when they must wait, because the bottom bar asks about unsaved changes. */
  askBeforeClose(): boolean;
  /** A press anywhere in the window: clicks count again after a drag. */
  pressed(): void;
  /** `run` as a click handler that skips the click OpenCode sends right after a drag. */
  click(run: () => void): () => void;
  /** The keyboard hint, or undefined for the window's own. */
  hint(tab: string, hasKeyboard: boolean): string | undefined;
  /** The surface switch and the note above a Settings tab's body. */
  Header(props: { tab: SettingsTab; refocus: () => void }): JSX.Element;
  Body(props: {
    tab: SettingsTab;
    host: SurfaceHost;
    sessionID: string;
    box: () => BoxRenderable | undefined;
    scroll: () => ScrollBoxRenderable | undefined;
  }): JSX.Element;
  /** The bottom bar: Close, or Save and Discard, or the "Keep your changes?" question. */
  Buttons(props: {
    tab: string;
    host: SurfaceHost;
    sessionID: string;
    box: () => BoxRenderable | undefined;
    close: () => void;
  }): JSX.Element;
};

/** A setting line: ‹ value › to step through values, a button (▸), and maybe a typed value. */
type OptionLine = {
  id: string;
  /** A heading above the line, which starts a group. */
  group?: string;
  title: string;
  value: () => string;
  cycle?: (delta: number) => void;
  run?: () => void;
  typed?: Typed;
  note: () => string;
  swatches?: () => RGBA[];
};

/** What a line takes when you type into it (e, or a double-click). */
type Typed = { placeholder: string; hint: string; apply: (text: string) => void };

/** A line of a surface tab's tree. One object per line, so <For> keeps its view while it moves. */
type TreeLine = { id: string; providerId: string; row: boolean };

const KEYS = "Quota window";
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
/** The id of a surface tab's switch line. */
const SWITCH_ID = "surface";
const DOUBLE_CLICK_MS = 400;

/** Selection id of a tree line; a row id could equal a setting's path. */
function lineKey(id: string): string {
  return `line:${id}`;
}

/** Renderable id of a line, so the list can scroll it into view. */
function boxId(id: string): string {
  return `quota-settings.${id}`;
}

function windowChoices(provider: ProviderSnapshot): WindowChoice[] {
  const windows = provider.rows.flatMap((row) =>
    row.window && row.percentRemaining !== undefined ? [row.window] : [],
  );
  const unique = [...new Set(windows)];
  return unique.length > 1 ? ["lowest", ...unique] : [];
}

function windowTitle(choice: WindowChoice): string {
  return choice === "lowest" ? "lowest left" : WINDOWS[choice].short;
}

export function createSettingsEditor(api: SettingsHost, display: DisplayStore): SettingsEditor {
  const [tab, setTabNow] = createSignal<SettingsTab>();
  const [selected, setSelected] = createSignal("");
  const [typing, setTyping] = createSignal<Typed & { id: string; value: string }>();
  const [confirming, setConfirming] = createSignal(false);
  const [sidebars, setSidebars] = createSignal(0);
  const [dragging, setDragging] = createSignal<string>();
  let draggedSincePress = false;
  let lastPress = { id: "", atMs: 0 };
  const treeLines = new Map<string, TreeLine>();
  const theme = () => api.theme;
  const shown = () => display.shown();

  const click = (run: () => void) => () => {
    if (!draggedSincePress) run();
  };

  /** Two presses on the same line within 400 ms. */
  function isDoubleClick(id: string): boolean {
    const now = Date.now();
    const double = lastPress.id === id && now - lastPress.atMs < DOUBLE_CLICK_MS;
    lastPress = double ? { id: "", atMs: 0 } : { id, atMs: now };
    return double;
  }

  function editSurface(
    surface: Surface,
    change: (rows: DisplaySettings["surfaces"][Surface]) => DisplaySettings["surfaces"][Surface],
  ): void {
    display.edit((settings) => {
      const rows = settings.surfaces[surface];
      const next = change(rows);
      return next === rows ? settings : setIn(settings, ["surfaces", surface], next);
    });
  }

  function toggleSurface(surface: Surface): void {
    display.edit((settings) =>
      setIn(settings, ["surfaces", surface, "enabled"], !settings.surfaces[surface].enabled),
    );
  }

  function fieldLine(field: Field): OptionLine {
    const role = field.color ? (field.path.slice("colors.".length) as ColorRole) : undefined;
    return {
      id: field.path,
      ...(field.group ? { group: field.group } : {}),
      title: field.title,
      value: () => field.show(valueAt(shown(), field.path)),
      cycle: (delta) => display.edit((settings) => cycleField(settings, field, delta)),
      ...(field.color
        ? {
            typed: {
              placeholder: "#rrggbb",
              hint: "Type a color like #89b4fa, then enter · enter with nothing typed = the theme's color · esc stop",
              apply: (text: string) =>
                display.edit((settings) => typedColor(settings, field, text)),
            },
          }
        : {}),
      note: () =>
        field.preset && presetChoice(shown(), field.preset) !== undefined
          ? "from the preset"
          : (field.note ?? ""),
      ...(role ? { swatches: () => [roleColor(theme(), shown(), role, 60)] } : {}),
    };
  }

  function presetLine(name: PresetName): OptionLine {
    return {
      id: `preset.${name}`,
      title: PRESETS[name].title,
      value: () => presetChoice(shown(), name) ?? "your own",
      cycle: (delta) => display.edit((settings) => cyclePreset(settings, name, delta)),
      note: () => `sets ${PRESETS[name].drives}`,
    };
  }

  /** OpenCode's own theme list and light/dark switch; quota's colors follow them. */
  const themeLines: OptionLine[] = [
    {
      id: "theme",
      group: "OpenCode theme",
      title: "Theme",
      value: () => "open the theme list",
      run: () => api.keymap.dispatch("theme.switch"),
      swatches: () => COLOR_NAMES.map((name) => namedColor(theme(), name)),
      note: () => "↑↓ shows each theme live · enter keeps it · esc puts it back",
    },
    {
      id: "themeMode",
      title: "Light or dark",
      value: () => api.themeMode ?? "dark",
      cycle: () => api.keymap.dispatch("theme.switch_mode"),
      note: () => "some themes have only one",
    },
  ];

  function optionLines(settingsTab: SettingsTab): OptionLine[] {
    const presets = (Object.keys(PRESETS) as PresetName[]).filter(
      (name) => PRESETS[name].tab === settingsTab,
    );
    return [
      ...presets.map(presetLine),
      ...(settingsTab === "colors" ? themeLines : []),
      ...FIELDS.filter((field) => field.tab === settingsTab).map(fieldLine),
    ];
  }

  function firstLine(settingsTab: SettingsTab | undefined): string {
    if (settingsTab === undefined) return "";
    return isSurfaceTab(settingsTab) ? SWITCH_ID : (optionLines(settingsTab)[0]?.id ?? "");
  }

  function Button(props: { label: string; primary?: boolean; run: () => void }): JSX.Element {
    return (
      <box
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={
          props.primary ? theme().background.action.primary.focused : theme().background.raised.high
        }
        onMouseUp={click(props.run)}
      >
        <text
          fg={props.primary ? theme().text.action.primary.focused : theme().text.base}
          selectable={false}
        >
          {props.label}
        </text>
      </box>
    );
  }

  function previewToast(host: SurfaceHost, sessionID: string): void {
    const settings = shown();
    const snapshot = host.quota.snapshot(sessionID);
    if (!snapshot || !settings.surfaces.toast.enabled) return;
    const message = toastText(snapshot, settings, Date.now());
    if (!message) return;
    api.ui.toast.show({
      variant: "info",
      title: TOAST_TITLE,
      message,
      duration: settings.toast.seconds * 1000,
    });
  }

  function Header(props: { tab: SettingsTab; refocus: () => void }): JSX.Element {
    const info = () => SETTINGS_TABS.find((item) => item.tab === props.tab) ?? SETTINGS_TABS[0];
    const surface = () => (isSurfaceTab(props.tab) ? props.tab : undefined);
    const surfaceOn = (): boolean => {
      const current = surface();
      return current === undefined || shown().surfaces[current].enabled;
    };
    const sidebarHidden = () => info().watchesSidebar && sidebars() === 0;
    const switchActive = () => selected() === SWITCH_ID;
    return (
      <>
        <Show when={surface()}>
          {(current: () => Surface) => (
            <box
              flexDirection="row"
              marginTop={1}
              flexShrink={0}
              backgroundColor={
                switchActive() ? theme().background.action.primary.focused : TRANSPARENT
              }
              onMouseDown={() => setSelected(SWITCH_ID)}
              onMouseUp={click(() => toggleSurface(current()))}
            >
              <text
                fg={switchActive() ? theme().text.action.primary.focused : theme().text.base}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
                selectable={false}
              >
                {`   ${surfaceOn() ? "[x]" : "[ ]"} ${info().switchTitle}`}
              </text>
            </box>
          )}
        </Show>
        {/* Padding instead of leading spaces, so a note that wraps stays indented. */}
        <box
          paddingLeft={3}
          marginTop={surface() ? 0 : 1}
          flexDirection="row"
          gap={2}
          flexShrink={0}
        >
          <text
            fg={sidebarHidden() ? theme().text.feedback.warning.base : theme().text.muted}
            wrapMode="word"
            selectable={false}
            flexShrink={1}
          >
            {sidebarHidden()
              ? "The sidebar is hidden, so there is nothing to watch here."
              : surfaceOn() || props.tab === "collapsed"
                ? info().note
                : info().offNote}
          </text>
          <Show when={sidebarHidden()}>
            <Button
              label="Show sidebar"
              run={() => {
                api.keymap.dispatch("session.sidebar.toggle");
                setTimeout(props.refocus, 50);
              }}
            />
          </Show>
        </box>
      </>
    );
  }

  function Body(props: {
    tab: SettingsTab;
    host: SurfaceHost;
    sessionID: string;
    box: () => BoxRenderable | undefined;
    scroll: () => ScrollBoxRenderable | undefined;
  }): JSX.Element {
    /** The box with only the tree lines, so the drag math counts lines from its top. */
    let list: BoxRenderable | undefined;
    let dragId: string | undefined;
    const surface = () => (isSurfaceTab(props.tab) ? props.tab : undefined);
    const withRows = () => props.tab === "sidebar" || props.tab === "toast";
    const snapshot = () => props.host.quota.snapshot(props.sessionID);
    const words = () => snapshot()?.words ?? DEFAULT_WORDS;
    const tree = (): TreeProvider[] => {
      const current = surface();
      const loaded = snapshot();
      return current && loaded ? surfaceTree(loaded, shown().surfaces[current]) : [];
    };
    const options = createMemo(() => optionLines(props.tab));
    const lines = createMemo(() =>
      tree().flatMap(({ provider, rowIds }) => [
        treeLine(provider.providerId, provider.providerId, false),
        ...(withRows() ? rowIds.map((id) => treeLine(id, provider.providerId, true)) : []),
      ]),
    );
    const selectable = () => [
      ...(surface() ? [SWITCH_ID] : []),
      ...options().map((line) => line.id),
      ...lines().map((line) => lineKey(line.id)),
    ];
    const selectedOption = () => options().find((line) => line.id === selected());
    const selectedLine = () => lines().find((line) => lineKey(line.id) === selected());

    function treeLine(id: string, providerId: string, row: boolean): TreeLine {
      const key = `${row ? "row" : "provider"}:${id}`;
      let line = treeLines.get(key);
      if (!line) {
        line = { id, providerId, row };
        treeLines.set(key, line);
      }
      return line;
    }

    /** ↑↓ select the next line; past the first or last one they scroll. */
    function select(delta: number): void {
      const ids = selectable();
      const next = ids.indexOf(selected()) + delta;
      if (next < 0 || next >= ids.length) props.scroll()?.scrollBy(delta);
      else setSelected(ids[next] as string);
    }

    function toggleHidden(id: string): void {
      const current = surface();
      if (!current) return;
      editSurface(current, (rows) => ({
        ...rows,
        hidden: rows.hidden.includes(id)
          ? rows.hidden.filter((item) => item !== id)
          : [...rows.hidden, id],
      }));
    }

    function cycleWindow(providerId: string, delta: number): void {
      const provider = tree().find((item) => item.provider.providerId === providerId)?.provider;
      const choices = provider ? windowChoices(provider) : [];
      if (choices.length === 0) return;
      const index = Math.max(0, choices.indexOf(shown().window[providerId] ?? "lowest"));
      const next = choices[(index + delta + choices.length) % choices.length];
      display.edit((settings) =>
        setIn(settings, ["window", providerId], next === "lowest" ? undefined : next),
      );
    }

    function move(delta: number): void {
      const current = surface();
      const line = selectedLine();
      if (current && line) editSurface(current, (rows) => movedBy(tree(), rows, line.id, delta));
    }

    function ownRow(line: TreeLine): QuotaRow | undefined {
      return tree()
        .find((item) => item.provider.providerId === line.providerId)
        ?.provider.rows.find((row) => row.id === line.id);
    }

    /** e or a double-click: type a color, or rename a row. */
    function startTyping(): void {
      const option = selectedOption();
      if (option?.typed) {
        setTyping({ id: option.id, value: "", ...option.typed });
        return;
      }
      const line = selectedLine();
      const row = line?.row ? ownRow(line) : undefined;
      if (!line || !row) return;
      setTyping({
        id: lineKey(line.id),
        value: "",
        placeholder: shown().labels[line.id] ?? row.label,
        hint: `Type a new name, then enter · enter with nothing typed = its own name ("${row.label}") · esc stop`,
        apply: (text) => display.edit((settings) => renameRow(settings, line.id, row.label, text)),
      });
    }

    function stopTyping(): void {
      setTyping(undefined);
      props.box()?.focus();
    }

    function commitTyping(): void {
      const current = typing();
      current?.apply(current.value);
      stopTyping();
    }

    /** Space or enter: flip a switch, run a button, next value, or show/hide a tree line. */
    function activate(): void {
      const current = surface();
      if (selected() === SWITCH_ID && current) {
        toggleSurface(current);
        return;
      }
      const option = selectedOption();
      if (option?.run) option.run();
      else if (option?.cycle) option.cycle(1);
      else if (option) startTyping();
      else {
        const line = selectedLine();
        if (line) toggleHidden(line.id);
      }
    }

    function sideways(delta: number): void {
      const option = selectedOption();
      if (option) option.cycle?.(delta);
      else {
        const line = selectedLine();
        if (line && !line.row) cycleWindow(line.providerId, delta);
      }
    }

    /** A provider moves with all its rows; a row moves only among its own provider's rows. */
    function onDrag(event: MouseEvent): void {
      const current = surface();
      const id = dragId;
      if (!current || !id || !list || typing()) return;
      draggedSincePress = true;
      setDragging(id);
      // Dragging onto the top or bottom line of a list that scrolls moves it one line.
      const scroll = props.scroll();
      if (scroll && event.y <= scroll.y) scroll.scrollBy(-1);
      else if (scroll && event.y >= scroll.y + scroll.height - 1) scroll.scrollBy(1);
      // list.y already includes the scroll offset, so this counts lines from the first line.
      const pointer = event.y - list.y;
      editSurface(current, (rows) => draggedTo(tree(), rows, id, pointer, withRows()));
    }

    function endDrag(): void {
      dragId = undefined;
      setDragging(undefined);
    }

    // On the Toast tab the real toast shows again after every change of what it shows.
    createEffect(
      on(
        () => {
          const settings = shown();
          return (
            props.tab === "toast" &&
            JSON.stringify([
              settings.surfaces.toast,
              settings.labels,
              settings.toast,
              settings.runsOut.toast,
            ])
          );
        },
        (key) => {
          if (key) previewToast(props.host, props.sessionID);
        },
      ),
    );
    // Keep the selected line in view when the list is taller than its room.
    createEffect(
      on(selected, (id) => {
        queueMicrotask(() => props.scroll()?.scrollChildIntoView(boxId(id)));
      }),
    );

    // Keys work only while the window has the keyboard; they win over the window's own.
    api.keymap.layer(() => ({
      target: props.box,
      priority: 11,
      enabled: () => typing() === undefined && !confirming(),
      commands: [
        { bind: "up", title: "Previous line", group: KEYS, run: () => select(-1) },
        { bind: "down", title: "Next line", group: KEYS, run: () => select(1) },
        { bind: "shift+up", title: "Move up", group: KEYS, run: () => move(-1) },
        { bind: "shift+down", title: "Move down", group: KEYS, run: () => move(1) },
        { bind: "alt+up", title: "Move up", group: KEYS, run: () => move(-1) },
        { bind: "alt+down", title: "Move down", group: KEYS, run: () => move(1) },
        { bind: "space", title: "Use the line", group: KEYS, run: activate },
        { bind: "return", title: "Use the line", group: KEYS, run: activate },
        { bind: "e", title: "Rename a row or type a color", group: KEYS, run: startTyping },
        { bind: "left", title: "Previous value", group: KEYS, run: () => sideways(-1) },
        { bind: "right", title: "Next value", group: KEYS, run: () => sideways(1) },
        {
          bind: "ctrl+r",
          title: "Reset this tab",
          group: KEYS,
          run: () => display.edit((settings) => resetTab(settings, props.tab)),
        },
      ],
    }));
    // While typing, the input has the keyboard: Esc only stops typing, Enter keeps the text.
    api.keymap.layer(() => ({
      priority: 20,
      enabled: () => typing() !== undefined,
      commands: [
        { bind: "escape", title: "Stop typing", group: KEYS, run: stopTyping },
        { bind: "return", title: "Keep it", group: KEYS, run: commitTyping },
      ],
    }));

    function TypingInput(inputProps: { width: number; placeholder: string }): JSX.Element {
      return (
        <input
          width={inputProps.width}
          flexShrink={0}
          value=""
          placeholder={inputProps.placeholder}
          focused
          onInput={(value: string) => {
            const current = typing();
            if (current) setTyping({ ...current, value });
          }}
          onSubmit={commitTyping}
        />
      );
    }

    function OptionRow(rowProps: { line: OptionLine; first: boolean }): JSX.Element {
      const line = rowProps.line;
      const active = () => selected() === line.id;
      const fg = () => (active() ? theme().text.action.primary.focused : theme().text.base);
      const arrow = () => (active() ? fg() : theme().text.action.primary.selected);
      const useValue = () => (line.run ? line.run() : line.cycle ? line.cycle(1) : startTyping());
      return (
        <>
          <Show when={line.group}>
            <box paddingTop={rowProps.first ? 0 : 1}>
              <text
                fg={theme().text.action.primary.selected}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
                flexShrink={0}
                selectable={false}
              >
                {` ${line.group}`}
              </text>
            </box>
          </Show>
          <box
            id={boxId(line.id)}
            flexDirection="row"
            backgroundColor={active() ? theme().background.action.primary.focused : TRANSPARENT}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== 0 || typing()) return;
              setSelected(line.id);
              if (line.typed && isDoubleClick(line.id)) startTyping();
            }}
          >
            <text fg={fg()} wrapMode="none" flexShrink={0} selectable={false}>
              {`   ${fit(line.title, 26)} `}
            </text>
            <text
              fg={arrow()}
              wrapMode="none"
              flexShrink={0}
              selectable={false}
              onMouseUp={click(() => line.cycle?.(-1))}
            >
              {line.cycle ? "‹ " : "  "}
            </text>
            <Show
              when={typing()?.id === line.id}
              fallback={
                <text
                  fg={fg()}
                  wrapMode="none"
                  flexShrink={0}
                  selectable={false}
                  onMouseUp={click(useValue)}
                >
                  {fit(line.value(), 24)}
                </text>
              }
            >
              <TypingInput width={24} placeholder={line.typed?.placeholder ?? ""} />
            </Show>
            <text
              fg={arrow()}
              wrapMode="none"
              flexShrink={0}
              selectable={false}
              onMouseUp={click(() => line.cycle?.(1))}
            >
              {line.run ? " ▸" : line.cycle ? " ›" : "  "}
            </text>
            <Show when={line.swatches}>
              <text wrapMode="none" flexShrink={0} selectable={false}>
                {(line.swatches?.() ?? []).map((color) => (
                  <span style={{ fg: color }}>{" ██"}</span>
                ))}
              </text>
            </Show>
            <text fg={active() ? fg() : theme().text.muted} wrapMode="none" selectable={false}>
              {line.note() ? `   ${line.note()}` : ""}
            </text>
          </box>
        </>
      );
    }

    function TreeRow(rowProps: { line: TreeLine }): JSX.Element {
      const line = rowProps.line;
      const key = lineKey(line.id);
      const entry = () => tree().find((item) => item.provider.providerId === line.providerId);
      const rows = () => shown().surfaces[surface() as Surface];
      const active = () => selected() === key;
      // Dragging a provider carries its rows, so they light up with it.
      const isDragged = () =>
        dragging() === line.id || (line.row && dragging() === line.providerId);
      const hidden = () => rows().hidden.includes(line.id);
      const fg = () =>
        active() || isDragged()
          ? theme().text.action.primary.focused
          : !rows().enabled || hidden() || (line.row && rows().hidden.includes(line.providerId))
            ? theme().text.muted
            : theme().text.base;
      /** Tree lines show which provider a row belongs to: ├ for a middle row, └ for the last. */
      const branch = () => {
        if (!line.row) return "";
        const rowIds = entry()?.rowIds ?? [];
        return rowIds[rowIds.length - 1] === line.id ? "  └ " : "  ├ ";
      };
      const own = () => (line.row ? ownRow(line) : undefined);
      const label = () =>
        line.row
          ? (shown().labels[line.id] ?? own()?.label ?? line.id)
          : (entry()?.provider.label ?? line.id);
      const summary = (row: QuotaRow) => {
        if (row.percentRemaining === undefined) return rowValueText(row);
        const reset = resetText(row, Date.now(), words());
        return `${percentText(words(), row.percentRemaining, true)}${reset ? ` · ${reset}` : ""}`;
      };
      const detail = () => {
        const provider = entry()?.provider;
        const row = own();
        if (row) {
          if (shown().labels[line.id] !== undefined) return `was "${row.label}"`;
          if (row.prominence === "supplementary" && words().detail !== "detailed") {
            return "only with all rows";
          }
          return summary(row);
        }
        if (!provider) return "";
        if (provider.error && provider.rows.length === 0) {
          return describeError(provider.error, provider.label, Date.now());
        }
        if (withRows()) return "";
        const picked = pickRow(
          { rows: provider.rows.map((item) => ({ row: item, label: item.label })) },
          shown().window[provider.providerId],
        );
        return picked ? summary(picked.row) : "";
      };
      const choices = () => {
        const provider = entry()?.provider;
        return !line.row && !withRows() && provider ? windowChoices(provider) : [];
      };
      /** Rows sit 4 columns further right, so their names get 4 fewer; the details line up. */
      const labelWidth = line.row ? 24 : 28;
      return (
        <box
          id={boxId(key)}
          flexDirection="row"
          backgroundColor={
            active() || isDragged() ? theme().background.action.primary.focused : TRANSPARENT
          }
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== 0 || typing()) return;
            setSelected(key);
            dragId = line.id;
            if (line.row && isDoubleClick(key)) startTyping();
          }}
        >
          <text fg={theme().text.muted} wrapMode="none" flexShrink={0} selectable={false}>
            {` ${branch()}`}
          </text>
          <text
            fg={isDragged() ? fg() : theme().text.action.primary.selected}
            wrapMode="none"
            flexShrink={0}
            selectable={false}
          >
            {api.renderer.useMouse === false ? "" : "⠿ "}
          </text>
          <text
            fg={fg()}
            wrapMode="none"
            flexShrink={0}
            selectable={false}
            onMouseUp={click(() => toggleHidden(line.id))}
          >
            {hidden() ? "[ ] " : "[x] "}
          </text>
          <Show
            when={typing()?.id === key}
            fallback={
              <text
                fg={fg()}
                attributes={line.row ? TextAttributes.NONE : TextAttributes.BOLD}
                wrapMode="none"
                flexShrink={0}
                selectable={false}
              >
                {fit(label(), labelWidth)}
              </text>
            }
          >
            <TypingInput width={labelWidth} placeholder={label()} />
          </Show>
          <text flexShrink={0} selectable={false}>
            {" "}
          </text>
          {/* One-line-per-provider tabs keep this column, so the details line up. */}
          <Show
            when={choices().length > 0}
            fallback={
              <text flexShrink={0} selectable={false}>
                {withRows() ? "" : " ".repeat(16)}
              </text>
            }
          >
            <text
              fg={active() ? fg() : theme().text.action.primary.selected}
              wrapMode="none"
              flexShrink={0}
              selectable={false}
              onMouseUp={click(() => cycleWindow(line.providerId, 1))}
            >
              {`‹ ${fit(windowTitle(shown().window[line.providerId] ?? "lowest"), 11)} › `}
            </text>
          </Show>
          <text
            fg={active() || isDragged() ? fg() : theme().text.muted}
            wrapMode="none"
            selectable={false}
          >
            {fit(detail(), 24)}
          </text>
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <For each={options()}>
          {(line: OptionLine, index: () => number) => (
            <OptionRow line={line} first={index() === 0} />
          )}
        </For>
        <Show when={surface() && !snapshot()}>
          <text fg={theme().text.muted} selectable={false}>
            {"   Loading quota…"}
          </text>
        </Show>
        <Show when={options().length > 0 && lines().length > 0}>
          <box height={1} />
        </Show>
        <box
          ref={(element: BoxRenderable) => {
            list = element;
          }}
          flexDirection="column"
          onMouseDrag={onDrag}
          onMouseDragEnd={endDrag}
          onMouseUp={() => {
            dragId = undefined;
          }}
        >
          <For each={lines()}>{(line: TreeLine) => <TreeRow line={line} />}</For>
        </box>
      </box>
    );
  }

  function Buttons(props: {
    tab: string;
    host: SurfaceHost;
    sessionID: string;
    box: () => BoxRenderable | undefined;
    close: () => void;
  }): JSX.Element {
    const settingsTab = () => (isSettingsTab(props.tab) ? props.tab : undefined);
    async function save(): Promise<void> {
      try {
        await display.save();
      } catch (error) {
        api.ui.toast.show({
          variant: "error",
          title: "Quota settings not saved",
          message: error instanceof Error ? error.message : String(error),
          duration: 6_000,
        });
        return;
      }
      setConfirming(false);
      props.close();
      api.ui.toast.show({
        variant: "success",
        title: "Quota settings saved",
        message: "Every open OpenCode window uses them now, and they stay after a restart.",
        duration: 4_000,
      });
    }
    const discard = () => {
      display.discard();
      if (confirming()) {
        setConfirming(false);
        props.close();
      }
    };

    api.keymap.layer(() => ({
      target: props.box,
      priority: 12,
      enabled: () => typing() === undefined && (settingsTab() !== undefined || display.dirty()),
      commands: [{ bind: "ctrl+s", title: "Save", group: KEYS, run: () => void save() }],
    }));
    // While the bottom bar asks about unsaved changes: d drops them, Esc goes back to editing.
    api.keymap.layer(() => ({
      target: props.box,
      priority: 15,
      enabled: () => confirming() && typing() === undefined,
      commands: [
        { bind: "d", title: "Discard the changes", group: KEYS, run: discard },
        { bind: "escape", title: "Keep editing", group: KEYS, run: () => setConfirming(false) },
      ],
    }));

    return (
      <Show
        when={!confirming()}
        fallback={
          <>
            <text
              fg={theme().text.feedback.warning.base}
              attributes={TextAttributes.BOLD}
              selectable={false}
            >
              Keep your changes?
            </text>
            <Button label="Save" primary run={() => void save()} />
            <Button label="Discard" run={discard} />
            <Button label="Keep editing" run={() => setConfirming(false)} />
          </>
        }
      >
        <Show when={display.dirty()} fallback={<Button label="Close" primary run={props.close} />}>
          <Button label="Save" primary run={() => void save()} />
          <Button label="Discard" run={discard} />
        </Show>
        <Show when={settingsTab()}>
          {(current: () => SettingsTab) => (
            <Button
              label="Reset tab"
              run={() => display.edit((settings) => resetTab(settings, current()))}
            />
          )}
        </Show>
        <Show when={settingsTab() === "toast" && shown().surfaces.toast.enabled}>
          <Button label="Show toast" run={() => previewToast(props.host, props.sessionID)} />
        </Show>
        <text fg={theme().text.feedback.warning.base} selectable={false}>
          {display.dirty() ? " unsaved changes" : ""}
        </text>
      </Show>
    );
  }

  return {
    marked(surface) {
      const id = selected();
      return tab() === surface && id.startsWith("line:") ? id.slice("line:".length) : undefined;
    },
    panelOpen() {
      if (tab() === "sidebar") return true;
      return tab() === "collapsed" ? false : undefined;
    },
    sidebarShown() {
      setSidebars((count) => count + 1);
      return () => setSidebars((count) => count - 1);
    },
    setTab(next) {
      if (next === undefined) {
        display.discard();
        setConfirming(false);
        setTyping(undefined);
      }
      const settingsTab = isSettingsTab(next) ? next : undefined;
      if (settingsTab !== tab()) setSelected(firstLine(settingsTab));
      setTabNow(settingsTab);
    },
    askBeforeClose() {
      if (!display.dirty() || confirming()) return false;
      setConfirming(true);
      return true;
    },
    pressed() {
      draggedSincePress = false;
    },
    click,
    typing: () => typing() !== undefined,
    hint(windowTab, hasKeyboard) {
      const current = typing();
      if (current) return current.hint;
      if (!hasKeyboard) return undefined;
      if (confirming()) return "ctrl+s save · d discard the changes · esc keep editing";
      if (!isSettingsTab(windowTab)) return undefined;
      const end = "↑↓ select · tab next tab · ctrl+s save · ctrl+r reset tab · esc close";
      if (!isSurfaceTab(windowTab)) {
        return `‹ › or ←/→ change · double-click a color (or e) to type your own · ${end}`;
      }
      const rowsTab = windowTab === "sidebar" || windowTab === "toast";
      const moving =
        api.renderer.useMouse === false
          ? "shift+↑↓ move"
          : `drag ⠿ or shift+↑↓ to move${rowsTab ? " (a provider takes its rows along)" : ""}`;
      const naming = rowsTab ? "double-click a row (or e) to rename it" : "‹ › pick a window";
      return `${moving} · [x] or space show/hide · ${naming} · ${end}`;
    },
    Header,
    Body,
    Buttons,
  };
}
