/** @jsxImportSource @opentui/solid */
/**
 * The quota window's Usage tab: tokens and API cost from OpenCode's own history, laid out by
 * `view/usage.ts`, and the model detail popup. Its first lines pick what it shows: Show (cost or
 * tokens), Range (every range when they fit, else ‹ the one shown ›), Dates (for "Between") and
 * Prices (download new ones); the Breakdown heading picks by model or by day.
 *
 * Its keys work like the Settings tabs': ↑↓ walk those lines and then the model rows, the
 * current one highlighted; ←/→ change a line; space or enter change it too, type the dates,
 * download prices or open a model's details. While a date has the keyboard, enter goes to the
 * next date and then applies them, tab switches dates, esc gives the keyboard back.
 *
 * The tab keeps its choices while the window is open and closed; each show asks the server
 * again. An answer that arrives after a newer question is dropped.
 */
import {
  type InputRenderable,
  type Renderable,
  RGBA,
  type ScrollBoxRenderable,
  TextAttributes,
} from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import type { UsageModelRow, UsageQuery, UsageReport } from "../../core/usage.js";
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGES,
  type UsageRange,
  usageRangeLabel,
} from "../../core/usage-ranges.js";
import { parseCalendarDate } from "../../lib/calendar-date.js";
import { sanitizeDisplayText } from "../../lib/display-sanitize.js";
import { QuotaRpc } from "../../rpc.js";
import {
  breakdownModels,
  modelDetailTitle,
  modelDetailView,
  type UsageBreakdown,
  type UsageLine,
  type UsageMode,
  type UsageRole,
  usageView,
} from "../../view/usage.js";
import { errorToast, quotaCallOptions, rpcErrorMessage } from "../client.js";
import type { WindowHost, WindowKey, WindowTheme } from "./shell.js";

/** OpenCode's theme also has categorical hue scales, for things told apart by color. */
type UsageTheme = WindowTheme & { categorical?: ReadonlyArray<Record<number, RGBA>> };

type UsageResult =
  | { state: "loading" }
  | { state: "ready"; report: UsageReport }
  | { state: "failed"; message: string };

/** OpenCode's "large" dialog width (dialogWidth in its ui/dialog.tsx). */
const DIALOG_WIDTH = 88;
/** Room for " esc" after the model popup's title. */
const CLOSE_LABEL_ROOM = " esc".length;
const KEYS = "Usage";
/** An option's two spaces around its label, inside its raised background. */
const OPTION_PAD = 2;
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
/** The column of the control lines' names ("Show", "Range", ...), and the gap after it. */
const LABEL_WIDTH = "Prices".length + 2;
const RANGES_WIDTH = USAGE_RANGES.reduce((sum, item) => sum + item.label.length + OPTION_PAD, 0);
const PRICES_LABEL = "Update ▸";
const PRICES_BUSY_LABEL = "Updating…";

/** How each "by type" part is shaded, from the muted color (0) to the text color (1). */
const PART_SHADES: Record<string, number> = {
  "part:cacheRead": 0,
  "part:input": 0.45,
  "part:cacheWrite": 0.75,
  "part:output": 1,
};

const KEYS_HINT = "↑↓ select · space/enter or click to use · ←/→ change · tab next tab · esc close";
const DATE_HINT =
  "Typing a date: enter next date, then apply · tab other date · esc back to the window";

/** Whether the Range line shows every range in `width` columns; else it shows ‹ one ›. */
export function allRangesFit(width: number): boolean {
  return LABEL_WIDTH + RANGES_WIDTH <= width;
}

/** The lines ↑↓ walk, top to bottom: the control lines, then each model of the breakdown. */
type Stop = "show" | "range" | "dates" | "prices" | "breakdown" | `model:${number}`;

/** A stop's element id, to scroll it into view. */
function stopId(stop: Stop): string {
  return `quota-usage-${stop.replace(":", "-")}`;
}

/** The model's place in the breakdown, or -1 when `stop` is no model row. */
function modelIndex(stop: Stop): number {
  return stop.startsWith("model:") ? Number(stop.slice("model:".length)) : -1;
}

/** `from` moved `share` of the way to `to`. */
function mix(from: RGBA, to: RGBA, share: number): RGBA {
  const step = (a: number, b: number) => a + (b - a) * share;
  return RGBA.fromValues(
    step(from.r, to.r),
    step(from.g, to.g),
    step(from.b, to.b),
    step(from.a, to.a),
  );
}

type DateField = "from" | "to";

/** The first day of this month and today, local dates like "2026-10-01". */
function thisMonth(nowMs: number): { from: string; to: string } {
  const now = new Date(nowMs);
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${month}-${String(now.getDate()).padStart(2, "0")}` };
}

function roleColor(theme: UsageTheme, role: UsageRole): RGBA {
  if (role.startsWith("provider:")) {
    const scales = theme.categorical ?? [];
    const scale = scales[Number(role.slice("provider:".length)) % Math.max(1, scales.length)];
    return scale?.[200] ?? theme.hue.accent[500] ?? theme.text.base;
  }
  if (role.startsWith("part:"))
    return mix(theme.text.muted, theme.text.base, PART_SHADES[role] ?? 1);
  switch (role) {
    case "muted":
      return theme.text.muted;
    case "warning":
      return theme.text.feedback.warning.base;
    case "bar":
      return theme.hue.accent[500] ?? theme.text.base;
    default:
      return theme.text.base;
  }
}

/**
 * One view line as one text, each span in its role's color on its `back` role's color (a chart
 * cell shared by two providers); title and headings bold.
 */
function UsageLineText(props: {
  line: UsageLine;
  theme: UsageTheme;
  id?: string;
  selected?: boolean;
  onClick?: () => void;
}): JSX.Element {
  const theme = () => props.theme;
  return (
    <text id={props.id} wrapMode="none" flexShrink={0} onMouseUp={props.onClick}>
      {props.line.length === 0 ? " " : null}
      {props.line.map((part) => (
        <span
          style={{
            fg: props.selected
              ? theme().text.action.primary.focused
              : roleColor(theme(), part.role),
            // A span keeps a background once drawn: set one always, so a line let go clears it.
            bg: props.selected
              ? theme().background.action.primary.focused
              : part.back
                ? roleColor(theme(), part.back)
                : TRANSPARENT,
            attributes:
              part.role === "title" || part.role === "heading" ? TextAttributes.BOLD : undefined,
          }}
        >
          {sanitizeDisplayText(part.text)}
        </span>
      ))}
    </text>
  );
}

/** A tab of the window's tab bar: bold and underlined when it is the current one. */
export function Choice(props: {
  label: string;
  active: boolean;
  theme: UsageTheme;
  run: () => void;
}): JSX.Element {
  return (
    <text
      fg={props.active ? props.theme.text.action.primary.selected : props.theme.text.muted}
      attributes={
        props.active ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE
      }
      wrapMode="none"
      selectable={false}
      onMouseUp={props.run}
    >
      {props.label}
    </text>
  );
}

/**
 * An option inside the Usage tab (cost or tokens, a range, model or day): the current one bold on
 * a raised background, so a row of options reads apart from the tab bar's underlined tabs. On
 * the highlighted line (`lit`) the other options take its text color.
 */
function Option(props: {
  label: string;
  active: boolean;
  lit?: boolean;
  theme: UsageTheme;
  run: () => void;
}): JSX.Element {
  const idle = () => (props.lit ? props.theme.text.action.primary.focused : props.theme.text.muted);
  return (
    <box
      paddingLeft={OPTION_PAD / 2}
      paddingRight={OPTION_PAD / 2}
      flexShrink={0}
      backgroundColor={props.active ? props.theme.background.raised.high : TRANSPARENT}
      onMouseUp={props.run}
    >
      <text
        fg={props.active ? props.theme.text.action.primary.selected : idle()}
        attributes={props.active ? TextAttributes.BOLD : TextAttributes.NONE}
        wrapMode="none"
        selectable={false}
      >
        {props.label}
      </text>
    </box>
  );
}

/**
 * A control line: its name in the first column, then its options. The current line is
 * highlighted across the tab, like a Settings line.
 */
function ControlLine(props: {
  stop: Stop;
  label: string;
  lit: boolean;
  theme: UsageTheme;
  children: JSX.Element;
}): JSX.Element {
  return (
    <box
      id={stopId(props.stop)}
      flexDirection="row"
      flexShrink={0}
      backgroundColor={props.lit ? props.theme.background.action.primary.focused : TRANSPARENT}
    >
      <text
        fg={props.lit ? props.theme.text.action.primary.focused : props.theme.text.muted}
        wrapMode="none"
        flexShrink={0}
        selectable={false}
      >
        {props.label.padEnd(LABEL_WIDTH)}
      </text>
      {props.children}
    </box>
  );
}

/** The model detail popup, in OpenCode's dialog: scrolls with ↑↓, closes with esc. */
function ModelDetail(props: {
  api: WindowHost;
  report: UsageReport;
  model: UsageModelRow;
  mode: UsageMode;
}): JSX.Element {
  const theme = () => props.api.theme as UsageTheme;
  const dimensions = useTerminalDimensions();
  // The dialog is its size's width, at most the terminal's minus 2, inside this box's paddings
  // (2 + 2). The lines below the title leave a column for the scrollbar; the title leaves room
  // for " esc".
  const innerWidth = () => Math.min(DIALOG_WIDTH, dimensions().width - 2) - 4;
  const width = () => innerWidth() - 1;
  const title = () => modelDetailTitle(props.report, props.model, innerWidth() - CLOSE_LABEL_ROOM);
  // The dialog starts a quarter of the way down; the title row and paddings take 4 rows.
  const maxHeight = () => Math.max(1, Math.floor(dimensions().height * 0.75) - 4);
  const lines = () =>
    modelDetailView(props.report, props.model, { mode: props.mode, width: width() });
  let scroll: ScrollBoxRenderable | undefined;
  props.api.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "up", title: "Scroll up", group: KEYS, run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: KEYS, run: () => scroll?.scrollBy(1) },
    ],
  }));
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row">
        <UsageLineText line={title()} theme={theme()} />
        <box flexGrow={1} />
        <text
          fg={theme().text.muted}
          flexShrink={0}
          selectable={false}
          onMouseUp={() => props.api.ui.dialog.clear()}
        >
          esc
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => {
          scroll = element;
        }}
        maxHeight={maxHeight()}
      >
        {lines()
          .slice(1)
          .map((line) => (
            <UsageLineText line={line} theme={theme()} />
          ))}
      </scrollbox>
    </box>
  );
}

/** A range to show, with its dates for "between". */
export type UsageChoice = { range: UsageRange; from?: string; to?: string };

export type UsageTab = {
  /** Puts the tab on a range; the next `show` asks for it. */
  choose(choice: UsageChoice): void;
  /** True while one of the Between dates has the keyboard. */
  typingDate(): boolean;
  /** Asks the server for the report again, for the window's session. */
  show(sessionID: string): void;
  /** The tab's keys, for the window's bottom line. */
  hint(): string;
  View(props: { width: number; keyTarget: () => Renderable | undefined }): JSX.Element;
};

/** `scroll`: the window's scrollbox, which keeps the current line in view. */
export function createUsageTab(
  api: WindowHost,
  scroll: () => ScrollBoxRenderable | undefined,
): UsageTab {
  const [range, setRange] = createSignal<UsageRange>(DEFAULT_USAGE_RANGE);
  const [mode, setMode] = createSignal<UsageMode>("cost");
  const [breakdown, setBreakdown] = createSignal<UsageBreakdown>("model");
  const [dates, setDates] = createSignal(thisMonth(Date.now()));
  /** The highlighted line. */
  const [focus, setFocus] = createSignal<Stop>("show");
  const [result, setResult] = createSignal<UsageResult>({ state: "loading" });
  const [downloading, setDownloading] = createSignal(false);
  let sessionID = "";
  let latestQuestion = 0;
  let fromInput: InputRenderable | undefined;
  let toInput: InputRenderable | undefined;
  let windowBox: () => Renderable | undefined = () => undefined;
  /** The date input that has the keyboard, if any. */
  const [dateFocus, setDateFocus] = createSignal<DateField>();

  function dateInput(field: DateField): InputRenderable | undefined {
    return field === "from" ? fromInput : toInput;
  }

  /** A model row's place changes with a new report or order: the Breakdown line stays lit. */
  function leaveModelRow(): void {
    if (modelIndex(focus()) >= 0) setFocus("breakdown");
  }

  async function load(): Promise<void> {
    const question = ++latestQuestion;
    const query: UsageQuery = { range: range(), sessionID };
    if (range() === "between") Object.assign(query, dates());
    setResult({ state: "loading" });
    leaveModelRow();
    try {
      const { report } = await api.client.rpc(QuotaRpc).usage(query, quotaCallOptions(api));
      if (question === latestQuestion) setResult({ state: "ready", report });
    } catch (error) {
      if (question !== latestQuestion) return;
      setResult({ state: "failed", message: sanitizeDisplayText(rpcErrorMessage(error)) });
    }
  }

  function typeDates(): void {
    setFocus("dates");
    fromInput?.focus();
  }

  /** `typing`: a click on "Between" gives the keyboard to its first date; ←/→ never do. */
  function chooseRange(next: UsageRange, typing: boolean): void {
    setRange(next);
    setFocus(next === "between" && typing ? "dates" : "range");
    void load();
    if (next === "between" && typing) setTimeout(typeDates, 50);
  }

  function stepRange(delta: number): void {
    const index = USAGE_RANGES.findIndex((item) => item.range === range());
    const count = USAGE_RANGES.length;
    chooseRange(USAGE_RANGES[(index + delta + count) % count].range, false);
  }

  /** Enter in a date: From goes on to To; To applies both when they are dates in order. */
  function submitDate(field: DateField): void {
    if (field === "from") {
      toInput?.focus();
      return;
    }
    const from = fromInput?.value.trim() ?? dates().from;
    const to = toInput?.value.trim() ?? dates().to;
    if (!parseCalendarDate(from) || !parseCalendarDate(to) || to < from) {
      api.ui.toast.show({
        variant: "warning",
        title: "Usage",
        message: "Type two dates like 2026-09-01, the first one not after the second.",
      });
      return;
    }
    setDates({ from, to });
    backToWindow();
    void load();
  }

  /** The keyboard back to the window; the Dates line is lit again. */
  function backToWindow(): void {
    setDateFocus(undefined);
    windowBox()?.focus();
  }

  async function downloadPrices(): Promise<void> {
    setFocus("prices");
    if (downloading()) return;
    setDownloading(true);
    try {
      const answer = await api.client.rpc(QuotaRpc).downloadPrices({}, quotaCallOptions(api));
      api.ui.toast.show({
        variant: answer.ok ? "success" : "error",
        title: "Prices",
        message: sanitizeDisplayText(answer.message),
        duration: 6_000,
      });
      if (answer.ok) void load();
    } catch (error) {
      api.ui.toast.show(errorToast(error, "Prices"));
    } finally {
      setDownloading(false);
    }
  }

  function readyReport(): UsageReport | undefined {
    const current = result();
    return current.state === "ready" ? current.report : undefined;
  }

  function failure(): string | undefined {
    const current = result();
    return current.state === "failed" ? current.message : undefined;
  }

  function openModel(index: number): void {
    const report = readyReport();
    const model = report && breakdownModels(report, mode())[index];
    if (!report || !model) return;
    setFocus(`model:${index}`);
    const shownMode = mode();
    api.ui.dialog.show(() => (
      <ModelDetail api={api} report={report} model={model} mode={shownMode} />
    ));
    api.ui.dialog.set({ size: "large" });
  }

  /** The breakdown's order follows the mode, so a model row lets go. */
  function chooseMode(next: UsageMode): void {
    setMode(next);
    setFocus("show");
  }

  function chooseBreakdown(next: UsageBreakdown): void {
    setBreakdown(next);
    setFocus("breakdown");
  }

  /** The lines ↑↓ walk now: Dates only for "Between", Breakdown and models only with usage. */
  function stops(): Stop[] {
    const list: Stop[] = ["show", "range"];
    if (range() === "between") list.push("dates");
    list.push("prices");
    const report = readyReport();
    if (report && report.totals.tokens.processed > 0) {
      list.push("breakdown");
      if (breakdown() === "model") {
        const count = breakdownModels(report, mode()).length;
        for (let index = 0; index < count; index += 1) list.push(`model:${index}`);
      }
    }
    return list;
  }

  /** ↑↓: the next line, scrolled into view; past the first or last one the window scrolls. */
  function move(delta: number): ReturnType<WindowKey["run"]> {
    const list = stops();
    const next = Math.max(0, list.indexOf(focus())) + delta;
    if (next < 0 || next >= list.length) return false;
    setFocus(list[next]);
    if (next === 0) scroll()?.scrollTo(0);
    else scroll()?.scrollChildIntoView(stopId(list[next]));
  }

  /** ←/→ on a line with options: the other one, or the next range. */
  function change(delta: number): ReturnType<WindowKey["run"]> {
    switch (focus()) {
      case "show":
        chooseMode(mode() === "cost" ? "tokens" : "cost");
        return;
      case "range":
        stepRange(delta);
        return;
      case "breakdown":
        chooseBreakdown(breakdown() === "model" ? "day" : "model");
        return;
      default:
        return false;
    }
  }

  /** Space or enter: change the line, type the dates, download prices or open the model. */
  function use(): ReturnType<WindowKey["run"]> {
    const stop = focus();
    if (stop === "dates") return typeDates();
    if (stop === "prices") return void downloadPrices();
    const model = modelIndex(stop);
    if (model >= 0) return openModel(model);
    return change(1);
  }

  function View(props: { width: number; keyTarget: () => Renderable | undefined }): JSX.Element {
    const theme = () => api.theme as UsageTheme;
    windowBox = props.keyTarget;
    const lit = (stop: Stop) => focus() === stop && dateFocus() === undefined;
    // A key's `window` action runs while the window has the keyboard, its `date` action while a
    // date input inside the window has it. A key without the action, or an action that returns
    // false, goes on to the window's own keys; letters and digits a date has no key for reach
    // the input.
    const keys: Array<{
      bind: string;
      title: string;
      window?: WindowKey["run"];
      date?: (field: DateField) => void;
    }> = [
      { bind: "up", title: "Previous line", window: () => move(-1) },
      { bind: "down", title: "Next line", window: () => move(1) },
      {
        bind: "left",
        title: "Change the line",
        window: () => change(-1),
        date: (field) => dateInput(field)?.moveCursorLeft(),
      },
      {
        bind: "right",
        title: "Change the line",
        window: () => change(1),
        date: (field) => dateInput(field)?.moveCursorRight(),
      },
      { bind: "space", title: "Use the line", window: use },
      {
        bind: "return",
        title: "Use the line, or the next date",
        window: use,
        date: (field) => submitDate(field),
      },
      {
        bind: "tab",
        title: "Other date",
        date: (field) => dateInput(field === "from" ? "to" : "from")?.focus(),
      },
      { bind: "escape", title: "Back to the window", date: backToWindow },
    ];
    // Above the window's own keys; the window's target also covers the inputs inside it.
    api.keymap.layer(() => ({
      target: props.keyTarget,
      priority: 11,
      commands: keys.map((key) => ({
        bind: key.bind,
        title: key.title,
        group: KEYS,
        run: () => {
          const field = dateFocus();
          if (field) return key.date ? key.date(field) : false;
          return key.window ? key.window() : false;
        },
      })),
    }));

    const lines = () => {
      const report = readyReport();
      return report
        ? usageView(report, { mode: mode(), breakdown: breakdown(), width: props.width })
        : [];
    };
    /** The view's last lines are the model rows (see `breakdownModels`). */
    const firstModelLine = () => {
      const report = readyReport();
      if (!report || breakdown() !== "model") return Number.POSITIVE_INFINITY;
      return lines().length - breakdownModels(report, mode()).length;
    };
    const dateBox = (field: DateField) => (
      <input
        ref={(element: InputRenderable) => {
          if (field === "from") fromInput = element;
          else toInput = element;
          element.on("focused", () => {
            setFocus("dates");
            setDateFocus(field);
          });
          element.on("blurred", () => setDateFocus((now) => (now === field ? undefined : now)));
        }}
        // A date's 10 characters, the cursor after them, and the input's scroll margin.
        width={13}
        flexShrink={0}
        maxLength={10}
        value={dates()[field]}
        placeholder="YYYY-MM-DD"
        backgroundColor={theme().background.raised.high}
        textColor={theme().text.base}
        onMouseDown={() => dateInput(field)?.focus()}
      />
    );
    const plain = (text: string, isLit: boolean) => (
      <text
        fg={isLit ? theme().text.action.primary.focused : theme().text.muted}
        wrapMode="none"
        flexShrink={0}
        selectable={false}
      >
        {text}
      </text>
    );

    return (
      <box flexDirection="column" flexShrink={0} width={props.width}>
        <ControlLine stop="show" label="Show" lit={lit("show")} theme={theme()}>
          <Option
            label="Cost"
            active={mode() === "cost"}
            lit={lit("show")}
            theme={theme()}
            run={() => chooseMode("cost")}
          />
          <Option
            label="Tokens"
            active={mode() === "tokens"}
            lit={lit("show")}
            theme={theme()}
            run={() => chooseMode("tokens")}
          />
        </ControlLine>
        <ControlLine stop="range" label="Range" lit={lit("range")} theme={theme()}>
          <Show
            when={allRangesFit(props.width)}
            fallback={
              <>
                <text
                  fg={theme().text.action.primary.selected}
                  selectable={false}
                  onMouseUp={() => stepRange(-1)}
                >
                  ‹
                </text>
                <Option
                  label={usageRangeLabel(range())}
                  active
                  theme={theme()}
                  run={() => stepRange(1)}
                />
                <text
                  fg={theme().text.action.primary.selected}
                  selectable={false}
                  onMouseUp={() => stepRange(1)}
                >
                  ›
                </text>
              </>
            }
          >
            {USAGE_RANGES.map((item) => (
              <Option
                label={item.label}
                active={item.range === range()}
                lit={lit("range")}
                theme={theme()}
                run={() => chooseRange(item.range, true)}
              />
            ))}
          </Show>
        </ControlLine>
        <Show when={range() === "between"}>
          <ControlLine stop="dates" label="Dates" lit={lit("dates")} theme={theme()}>
            <box flexDirection="row" columnGap={1}>
              {dateBox("from")}
              {plain("to", lit("dates"))}
              {dateBox("to")}
              <Show when={dateFocus() === undefined}>
                {plain(" enter or click a date to change it", lit("dates"))}
              </Show>
            </box>
          </ControlLine>
        </Show>
        <ControlLine stop="prices" label="Prices" lit={lit("prices")} theme={theme()}>
          <text
            fg={
              lit("prices")
                ? theme().text.action.primary.focused
                : theme().text.action.primary.selected
            }
            wrapMode="none"
            flexShrink={0}
            selectable={false}
            onMouseUp={() => void downloadPrices()}
          >
            {downloading() ? PRICES_BUSY_LABEL : PRICES_LABEL}
          </text>
        </ControlLine>
        <box flexDirection="column" marginTop={2}>
          <Show when={result().state === "loading"}>
            <text fg={theme().text.muted}>Loading usage…</text>
          </Show>
          <Show when={failure()}>
            <text fg={theme().text.feedback.error.base} wrapMode="word">
              {`Couldn't load the usage: ${failure()}`}
            </text>
          </Show>
          {lines().map((line, index) => {
            const model = index - firstModelLine();
            if (line.length === 1 && line[0].role === "heading" && line[0].text === "Breakdown") {
              return (
                <box
                  id={stopId("breakdown")}
                  flexDirection="row"
                  columnGap={1}
                  backgroundColor={
                    lit("breakdown") ? theme().background.action.primary.focused : TRANSPARENT
                  }
                >
                  <UsageLineText line={line} theme={theme()} selected={lit("breakdown")} />
                  <box flexDirection="row" flexShrink={0}>
                    <Option
                      label="Model"
                      active={breakdown() === "model"}
                      lit={lit("breakdown")}
                      theme={theme()}
                      run={() => chooseBreakdown("model")}
                    />
                    <Option
                      label="Day"
                      active={breakdown() === "day"}
                      lit={lit("breakdown")}
                      theme={theme()}
                      run={() => chooseBreakdown("day")}
                    />
                  </box>
                </box>
              );
            }
            if (model < 0) return <UsageLineText line={line} theme={theme()} />;
            return (
              <UsageLineText
                line={line}
                theme={theme()}
                id={stopId(`model:${model}`)}
                selected={lit(`model:${model}`)}
                onClick={() => openModel(model)}
              />
            );
          })}
        </box>
      </box>
    );
  }

  return {
    choose(choice) {
      setRange(choice.range);
      if (choice.from && choice.to) setDates({ from: choice.from, to: choice.to });
      setFocus("range");
    },
    typingDate: () => dateFocus() !== undefined,
    hint: () => (dateFocus() !== undefined ? DATE_HINT : KEYS_HINT),
    show(nextSessionID) {
      sessionID = nextSessionID;
      void load();
    },
    View,
  };
}
