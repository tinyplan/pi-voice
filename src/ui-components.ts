import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { VoiceKeys } from "./keybindings.js";

type UiTheme = ExtensionContext["ui"]["theme"];

export const PANEL_PADDING = 1;
export const LIST_PADDING = 1;

export function panelBorder(theme: UiTheme): DynamicBorder {
  return new DynamicBorder((text: string) => theme.fg("border", text));
}

/** The rule Pi's editor draws above and below its text. */
export function editorBorder(theme: UiTheme): DynamicBorder {
  return new DynamicBorder((text: string) => theme.fg("borderMuted", text));
}

/** Page title on the left; quieter setup context and progress on the right. */
export function onboardingHeader(
  theme: UiTheme,
  title: string,
  step: number,
  total = 3,
): Component {
  const context = `Pi Voice setup · ${step} of ${total}`;
  const compactContext = `${step} of ${total}`;
  return {
    invalidate() {},
    render(width: number): string[] {
      const innerWidth = Math.max(1, width - PANEL_PADDING * 2);
      const titleWidth = visibleWidth(title);
      const contextWidth = visibleWidth(context);
      const left = theme.fg("accent", theme.bold(title));
      let content: string;
      if (titleWidth + contextWidth + 2 <= innerWidth) {
        content = `${left}${" ".repeat(innerWidth - titleWidth - contextWidth)}${theme.fg("dim", context)}`;
      } else {
        const suffix = ` · ${compactContext}`;
        const titleRoom = Math.max(1, innerWidth - visibleWidth(suffix));
        content = `${truncateToWidth(left, titleRoom, "…")}${theme.fg("dim", suffix)}`;
      }
      return [truncateToWidth(`${" ".repeat(PANEL_PADDING)}${content}`, width, "")];
    },
  };
}

export type SingleSelectChoice<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export function selectedWindow<T>(
  items: readonly T[],
  selected: number,
  maximum: number,
): [number, number] {
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maximum / 2), items.length - maximum),
  );
  return [start, Math.min(start + maximum, items.length)];
}

/** Rows the host renders below an editor-mounted pane (its two footer lines). */
const RESERVED_HOST_ROWS = 2;
/** Below this a list stops shrinking and the pane is left to overflow. */
export const MIN_VISIBLE_ROWS = 3;

/** Rows available to a pane, or undefined when the terminal size is unknown. */
export function paneRowBudget(tui: TUI): number | undefined {
  const rows = (tui as Partial<TUI>).terminal?.rows;
  return typeof rows === "number" && rows > 0
    ? rows - RESERVED_HOST_ROWS
    : undefined;
}

/** Window size that fits a list into a budget of rows. */
export function windowSizeForBudget(
  budget: number,
  maximum: number,
  minimum = MIN_VISIBLE_ROWS,
): number {
  return Math.max(minimum, Math.min(maximum, budget));
}

/** Compute a list window while reserving the pane's non-list content. */
export function paneListWindow(
  tui: TUI,
  renderedRows: number,
  listRows: number,
  detailRows: number,
  reservedDetailRows: number,
  maximum: number,
): number | undefined {
  const budget = paneRowBudget(tui);
  if (budget === undefined) return undefined;
  const chrome = renderedRows - listRows - detailRows + reservedDetailRows;
  return windowSizeForBudget(budget - chrome, maximum);
}

export function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** Shared fixed-width marker: the arrow is focus, while ✓ is selected/current. */
export function selectionMarker(theme: UiTheme, selected: boolean): string {
  return selected ? theme.fg("accent", "✓") : " ";
}

/** Pi-native single-choice picker with optional fuzzy search and current-value marker. */
export class SingleSelectPicker<T extends string> extends Container implements Focusable {
  private readonly search = new Input();
  private readonly titleText: Text;
  private readonly subtitleText: Text | undefined;
  private readonly list = new Container();
  private readonly detail = new Text("", PANEL_PADDING, 0);
  private readonly footer = new Text("", PANEL_PADDING, 0);
  private filtered: SingleSelectChoice<T>[];
  private selectedIndex: number;
  /** Rows the list window may use; shrinks to fit short terminals. */
  private visibleLimit: number;
  /** Width of the last render; row labels are laid out against it. */
  private renderWidth = 80;
  /** Lines of the longest description at the cached width. */
  private detailReserve = 0;
  private detailReserveWidth = -1;
  private readonly hasDescriptions: boolean;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && Boolean(this.options.searchable);
  }

  private readonly keys: VoiceKeys;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    private readonly choices: readonly SingleSelectChoice<T>[],
    private readonly current: T | undefined,
    private readonly options: {
      title: string;
      subtitle?: string;
      searchable?: boolean;
      maximumVisible?: number;
      cancelLabel?: string;
      /** Extra footer legend, appended after the ✓ current marker. */
      legend?: string;
      /** Custom row body after the cursor and ✓ markers; handles its own active styling. */
      renderLabel?: (choice: SingleSelectChoice<T>, active: boolean, width: number) => string;
    },
    private readonly done: (value: T | undefined) => void,
  ) {
    super();
    this.keys = new VoiceKeys(keybindings);
    this.visibleLimit = options.maximumVisible ?? 10;
    this.hasDescriptions = choices.some((choice) => choice.description);
    this.filtered = [...choices];
    this.selectedIndex = Math.max(
      0,
      this.filtered.findIndex((choice) => choice.value === current),
    );

    this.titleText = new Text(
      theme.fg("accent", theme.bold(options.title)),
      PANEL_PADDING,
      0,
    );
    this.subtitleText = options.subtitle
      ? new Text(theme.fg("muted", options.subtitle), PANEL_PADDING, 0)
      : undefined;

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(this.titleText);
    if (this.subtitleText) this.addChild(this.subtitleText);
    this.addChild(new Spacer(1));
    if (options.searchable) {
      const searchBox = new Box(LIST_PADDING, 0);
      searchBox.addChild(this.search);
      this.addChild(searchBox);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    if (this.hasDescriptions) {
      this.addChild(this.detail);
      this.addChild(new Spacer(1));
    }
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter([...this.choices], query, (choice) =>
          `${choice.label} ${choice.value} ${choice.description ?? ""}`,
        )
      : [...this.choices];
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(
        new Text(this.theme.fg("muted", "  No matching choices"), LIST_PADDING, 0),
      );
      this.detail.setText("");
    } else {
      const maximum = this.visibleLimit;
      const [start, end] = selectedWindow(
        this.filtered,
        this.selectedIndex,
        maximum,
      );
      for (let index = start; index < end; index += 1) {
        const choice = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const current = this.current === undefined
          ? ""
          : `${selectionMarker(this.theme, choice.value === this.current)} `;
        const label = this.options.renderLabel
          ? this.options.renderLabel(choice, active, this.renderWidth)
          : active
            ? this.theme.fg("accent", choice.label)
            : choice.label;
        this.list.addChild(new Text(`${prefix}${current}${label}`, LIST_PADDING, 0));
      }
      this.detail.setText(
        this.filtered[this.selectedIndex]?.description
          ? this.theme.fg("dim", this.filtered[this.selectedIndex]!.description!)
          : "",
      );
    }

    // When the list is clipped the scroll position lives in this count, so
    // the list itself never spends a row on an indicator.
    const clipped = this.filtered.length > this.visibleLimit;
    const shown = query
      ? clipped
        ? `${this.selectedIndex + 1}/${this.filtered.length} matching choices`
        : `${this.filtered.length}/${this.choices.length} matching choices`
      : clipped
        ? `${this.selectedIndex + 1}/${this.choices.length} choices`
        : `${this.choices.length} choices`;
    const legend = [
      this.current === undefined
        ? undefined
        : `${selectionMarker(this.theme, true)} ${this.theme.fg("dim", "current")}`,
      this.options.legend,
    ]
      .filter((value): value is string => Boolean(value))
      .join("  ");
    this.footer.setText(
      `${this.theme.fg("dim", shown)}${legend ? `  ${legend}` : ""}\n${this.keys.navHint("navigate")}  ${this.keys.hint("tui.select.confirm", "select")}  ${this.keys.hint("tui.select.cancel", query ? "clear search" : (this.options.cancelLabel ?? "back"))}`,
    );
    this.tui.requestRender();
  }

  override invalidate(): void {
    super.invalidate();
    this.titleText.setText(
      this.theme.fg("accent", this.theme.bold(this.options.title)),
    );
    if (this.subtitleText && this.options.subtitle) {
      this.subtitleText.setText(this.theme.fg("muted", this.options.subtitle));
    }
    this.refresh();
  }

  // The pane replaces the host editor and cannot scroll: when the terminal
  // is short, shrink the list window so the title and footer stay on screen.
  override render(width: number): string[] {
    if (width !== this.renderWidth) {
      this.renderWidth = width;
      this.refresh();
    }
    const limit = paneListWindow(
      this.tui,
      super.render(width).length,
      this.list.render(width).length,
      this.detail.render(width).length,
      this.maxDetailLines(width),
      this.options.maximumVisible ?? 10,
    );
    if (limit !== undefined && limit !== this.visibleLimit) {
      this.visibleLimit = limit;
      this.refresh();
    }
    return super.render(width);
  }

  // Sizing against the longest description keeps the window height steady
  // while the highlight moves across short and wrapping descriptions.
  private maxDetailLines(width: number): number {
    if (!this.hasDescriptions) return 0;
    if (this.detailReserveWidth !== width) {
      this.detailReserveWidth = width;
      const probe = new Text("", PANEL_PADDING, 0);
      this.detailReserve = Math.max(
        ...this.choices.map((choice) => {
          if (!choice.description) return 1;
          probe.setText(choice.description);
          return probe.render(width).length;
        }),
      );
    }
    return this.detailReserve;
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keys.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = Math.max(
          0,
          this.choices.findIndex((choice) => choice.value === this.current),
        );
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    if (this.options.searchable) {
      this.search.handleInput(data);
      this.selectedIndex = 0;
      this.refresh();
    }
  }
}

export type TextInputOptions = {
  title: string;
  subtitle?: string;
  initial?: string;
  /** Hint under the input; defaults to the trimmed value's use. */
  placeholder?: string;
  cancelLabel?: string;
  confirmLabel?: string;
};

/** One-line text entry pane: Enter accepts a non-empty trimmed value, Esc cancels. */
export class TextInputPrompt extends Container implements Focusable {
  private readonly input = new Input();
  private readonly footer = new Text("", PANEL_PADDING, 0);
  private readonly keys: VoiceKeys;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    private readonly options: TextInputOptions,
    private readonly done: (value: string | undefined) => void,
  ) {
    super();
    this.keys = new VoiceKeys(keybindings);
    this.input.setValue(options.initial ?? "");

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), PANEL_PADDING, 0));
    if (options.subtitle) {
      this.addChild(new Text(theme.fg("muted", options.subtitle), PANEL_PADDING, 0));
    }
    this.addChild(new Spacer(1));
    const box = new Box(LIST_PADDING, 0);
    box.addChild(this.input);
    this.addChild(box);
    this.addChild(new Spacer(1));
    if (options.placeholder) {
      this.addChild(new Text(theme.fg("dim", options.placeholder), PANEL_PADDING, 0));
      this.addChild(new Spacer(1));
    }
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.footer.setText(
      `${this.keys.hint("tui.select.confirm", options.confirmLabel ?? "save")}  ${this.keys.hint("tui.select.cancel", options.cancelLabel ?? "back")}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.confirm")) {
      const value = this.input.getValue().trim();
      if (value) this.done(value);
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }
}

export async function promptText(
  ctx: ExtensionContext,
  options: TextInputOptions,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new TextInputPrompt(tui, theme, keybindings, options, done),
  );
}
