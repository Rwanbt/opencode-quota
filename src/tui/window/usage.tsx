/** @jsxImportSource @opentui/solid */
/**
 * The quota window's Usage tab: tokens and API cost from OpenCode's own history, laid out by
 * `view/usage.ts`, and the model detail popup. Its top line picks cost or tokens and the range
 * (every range when they fit, else ‹ the one shown ›) and has "Update prices" on the right when
 * there is room. Its keys, while the window has the keyboard:
 * c/t cost or tokens, ←/→ the range, m/d breakdown by model or by day, ↑↓ pick a model, enter
 * its details, p download new prices. "Between" asks for two dates in the tab: enter goes to
 * the next date and then applies them, tab switches dates, esc gives the keyboard back to the
 * window.
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
const MODEL_ROW_ID = "quota-usage-model-";
/** Between the choices of the top line, as the tab bar. */
const CHOICE_GAP = 2;
const MODES_WIDTH = "Cost".length + CHOICE_GAP + "Tokens".length;
/** "│" and the gaps around it. */
const SEPARATOR_WIDTH = 1 + 2 * CHOICE_GAP;
const RANGES_WIDTH =
  USAGE_RANGES.reduce((sum, item) => sum + item.label.length, 0) +
  CHOICE_GAP * (USAGE_RANGES.length - 1);
/** "‹ Session + subagents ›", the longest label: the stepper fits with any range. */
const RANGE_LABEL_WIDTH = Math.max(...USAGE_RANGES.map((item) => item.label.length));
const STEPPER_WIDTH = 2 * (1 + CHOICE_GAP) + RANGE_LABEL_WIDTH;
const PRICES_LABEL = "Update prices";
/** "Update prices" keeps at least this much space before it. */
const PRICES_GAP = 3;

/** How each "by type" part is shaded, from the muted color (0) to the text color (1). */
const PART_SHADES: Record<string, number> = {
  "part:cacheRead": 0,
  "part:input": 0.45,
  "part:cacheWrite": 0.75,
  "part:output": 1,
};

const KEYS_HINT =
  "c/t cost/tokens · ←/→ range · m/d model/day · ↑↓ pick a model, enter details · p update prices · tab next tab · esc close";
const DATE_HINT =
  "Typing a date: enter next date, then apply · tab other date · esc back to the window";

/** The top line in `width` columns: every range or ‹ one ›, and whether "Update prices" fits. */
export function usageControls(width: number): { allRanges: boolean; prices: boolean } {
  const prices = PRICES_GAP + PRICES_LABEL.length;
  const all = MODES_WIDTH + SEPARATOR_WIDTH + RANGES_WIDTH;
  if (all + prices <= width) return { allRanges: true, prices: true };
  if (all <= width) return { allRanges: true, prices: false };
  const stepper = MODES_WIDTH + SEPARATOR_WIDTH + STEPPER_WIDTH;
  return { allRanges: false, prices: stepper + prices <= width };
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

/** One view line as one text, each span in its role's color; title and headings bold. */
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
            bg: props.selected ? theme().background.action.primary.focused : undefined,
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

/** A choice in a row of choices (a tab, a range): bold and underlined when it is the current one. */
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

/** `scroll`: the window's scrollbox, which keeps the picked model in view. */
export function createUsageTab(
  api: WindowHost,
  scroll: () => ScrollBoxRenderable | undefined,
): UsageTab {
  const [range, setRange] = createSignal<UsageRange>(DEFAULT_USAGE_RANGE);
  const [mode, setMode] = createSignal<UsageMode>("cost");
  const [breakdown, setBreakdown] = createSignal<UsageBreakdown>("model");
  const [dates, setDates] = createSignal(thisMonth(Date.now()));
  const [editingDates, setEditingDates] = createSignal(false);
  /** The picked model's place in the model breakdown; -1 for none. */
  const [selected, setSelected] = createSignal(-1);
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

  async function load(): Promise<void> {
    const question = ++latestQuestion;
    const query: UsageQuery = { range: range(), sessionID };
    if (range() === "between") Object.assign(query, dates());
    setResult({ state: "loading" });
    setSelected(-1);
    try {
      const { report } = await api.client.rpc(QuotaRpc).usage(query, quotaCallOptions(api));
      if (question === latestQuestion) setResult({ state: "ready", report });
    } catch (error) {
      if (question !== latestQuestion) return;
      setResult({ state: "failed", message: sanitizeDisplayText(rpcErrorMessage(error)) });
    }
  }

  function chooseRange(next: UsageRange): void {
    setRange(next);
    setEditingDates(next === "between");
    void load();
    if (next === "between") setTimeout(() => fromInput?.focus(), 50);
  }

  function stepRange(delta: number): void {
    const index = USAGE_RANGES.findIndex((item) => item.range === range());
    const count = USAGE_RANGES.length;
    chooseRange(USAGE_RANGES[(index + delta + count) % count].range);
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
    setEditingDates(false);
    windowBox()?.focus();
    void load();
  }

  async function downloadPrices(): Promise<void> {
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
    setSelected(index);
    const shownMode = mode();
    api.ui.dialog.show(() => (
      <ModelDetail api={api} report={report} model={model} mode={shownMode} />
    ));
    api.ui.dialog.set({ size: "large" });
  }

  /** ↑↓ in the model breakdown: the next model, scrolled into view; past the ends, none. */
  function moveSelection(delta: number): ReturnType<WindowKey["run"]> {
    const report = readyReport();
    if (!report || breakdown() !== "model") return false;
    const next = selected() + delta;
    if (next < 0) {
      setSelected(-1);
      return false;
    }
    if (next >= breakdownModels(report, mode()).length) return false;
    setSelected(next);
    scroll()?.scrollChildIntoView(`${MODEL_ROW_ID}${next}`);
  }

  /** The breakdown's order follows the mode, so the picked model is dropped. */
  function chooseMode(next: UsageMode): void {
    setMode(next);
    setSelected(-1);
  }

  function View(props: { width: number; keyTarget: () => Renderable | undefined }): JSX.Element {
    const theme = () => api.theme as UsageTheme;
    windowBox = props.keyTarget;
    const backToWindow = () => {
      setEditingDates(false);
      props.keyTarget()?.focus();
    };
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
      { bind: "c", title: "Cost", window: () => chooseMode("cost") },
      { bind: "t", title: "Tokens", window: () => chooseMode("tokens") },
      { bind: "m", title: "Breakdown by model", window: () => setBreakdown("model") },
      { bind: "d", title: "Breakdown by day", window: () => setBreakdown("day") },
      {
        bind: "left",
        title: "Previous range",
        window: () => stepRange(-1),
        date: (field) => dateInput(field)?.moveCursorLeft(),
      },
      {
        bind: "right",
        title: "Next range",
        window: () => stepRange(1),
        date: (field) => dateInput(field)?.moveCursorRight(),
      },
      { bind: "up", title: "Previous model", window: () => moveSelection(-1) },
      { bind: "down", title: "Next model", window: () => moveSelection(1) },
      {
        bind: "return",
        title: "Model details, or the next date",
        window: () => (selected() < 0 ? false : openModel(selected())),
        date: (field) => submitDate(field),
      },
      {
        bind: "tab",
        title: "Other date",
        date: (field) => dateInput(field === "from" ? "to" : "from")?.focus(),
      },
      { bind: "escape", title: "Back to the window", date: backToWindow },
      { bind: "p", title: "Download new prices", window: () => void downloadPrices() },
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

    const controls = () => usageControls(props.width);
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
          element.on("focused", () => setDateFocus(field));
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

    return (
      <box flexDirection="column" flexShrink={0} width={props.width}>
        <box flexDirection="row" columnGap={CHOICE_GAP}>
          <Choice
            label="Cost"
            active={mode() === "cost"}
            theme={theme()}
            run={() => chooseMode("cost")}
          />
          <Choice
            label="Tokens"
            active={mode() === "tokens"}
            theme={theme()}
            run={() => chooseMode("tokens")}
          />
          <text fg={theme().text.muted} selectable={false}>
            │
          </text>
          <Show
            when={controls().allRanges}
            fallback={
              <>
                <text
                  fg={theme().text.action.primary.selected}
                  selectable={false}
                  onMouseUp={() => stepRange(-1)}
                >
                  ‹
                </text>
                <Choice
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
              <Choice
                label={item.label}
                active={item.range === range()}
                theme={theme()}
                run={() => chooseRange(item.range)}
              />
            ))}
          </Show>
          <Show when={controls().prices}>
            <box flexGrow={1} />
            <text
              fg={theme().text.action.primary.selected}
              selectable={false}
              onMouseUp={() => void downloadPrices()}
            >
              {downloading() ? "Updating prices…" : PRICES_LABEL}
            </text>
          </Show>
        </box>
        <Show when={range() === "between"}>
          <box flexDirection="row" columnGap={1} marginTop={1}>
            <text fg={theme().text.muted} selectable={false}>
              From
            </text>
            {dateBox("from")}
            <text fg={theme().text.muted} selectable={false}>
              to
            </text>
            {dateBox("to")}
            <text fg={theme().text.muted} selectable={false}>
              {editingDates()
                ? "  enter next date, then apply · esc back"
                : "  click a date to change it"}
            </text>
          </box>
        </Show>
        <box flexDirection="column" marginTop={1}>
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
                <box flexDirection="row" columnGap={2}>
                  <UsageLineText line={line} theme={theme()} />
                  <Choice
                    label="Model"
                    active={breakdown() === "model"}
                    theme={theme()}
                    run={() => setBreakdown("model")}
                  />
                  <Choice
                    label="Day"
                    active={breakdown() === "day"}
                    theme={theme()}
                    run={() => setBreakdown("day")}
                  />
                </box>
              );
            }
            if (model < 0) return <UsageLineText line={line} theme={theme()} />;
            return (
              <UsageLineText
                line={line}
                theme={theme()}
                id={`${MODEL_ROW_ID}${model}`}
                selected={model === selected()}
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
      setEditingDates(false);
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
