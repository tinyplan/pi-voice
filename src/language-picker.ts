import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Spacer,
  Text,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { languageIdentity, displayLanguage } from "./languages.js";
import { VoiceKeys } from "./keybindings.js";
import type { TranscriptionLanguage } from "./settings.js";
import {
  LIST_PADDING,
  MIN_VISIBLE_ROWS,
  onboardingHeader,
  PANEL_PADDING,
  padToWidth,
  panelBorder,
  paneRowBudget,
  selectedWindow,
  selectionMarker,
  SingleSelectPicker,
  windowSizeForBudget,
  type SingleSelectChoice,
} from "./ui-components.js";

type UiTheme = ExtensionContext["ui"]["theme"];

const MAX_VISIBLE_LANGUAGES = 9;
const TEXT_PADDING = PANEL_PADDING;
// Longest common language name is "Norwegian Nynorsk" (17).
const LANGUAGE_NAME_WIDTH = 20;
const TRANSCRIPTION_LANGUAGE_NAME_WIDTH = 28;

export type LanguageSelection = {
  languages: string[];
  /** False when the picker was closed with Esc instead of Continue. */
  confirmed: boolean;
};

export class LanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", TEXT_PADDING, 0);
  private readonly selected: Set<string>;
  private readonly available: readonly string[];
  private ordered: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = 0;
  /** Scroll-window rows (rule included); shrinks to fit short terminals. */
  private windowRows = MAX_VISIBLE_LANGUAGES + 1;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  private readonly keys: VoiceKeys;

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    keybindings: KeybindingsManager,
    initial: readonly string[],
    private readonly cancelLabel: string,
    private readonly done: (result: LanguageSelection | undefined) => void,
    private readonly onboardingStep?: number,
  ) {
    super();
    this.keys = new VoiceKeys(keybindings);
    // Keep saved languages visible and removable even if the search would not
    // surface them.
    this.selected = new Set(initial.map(languageIdentity).filter(Boolean));
    this.available = [...new Set([...COMMON_LANGUAGES, ...this.selected])];
    this.reorder();

    this.addChild(panelBorder(theme));
    this.addChild(new Spacer(1));
    this.addChild(
      onboardingStep
        ? onboardingHeader(theme, "Choose your languages", onboardingStep)
        : new Text(
            theme.fg("accent", theme.bold("Select the languages you speak")),
            TEXT_PADDING,
            0,
          ),
    );
    this.addChild(
      new Text(
        onboardingStep
          ? "Which languages will you speak to Pi in?"
          : theme.fg("muted", "Used to pick transcription defaults"),
        TEXT_PADDING,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    // The search caret sits in the gutter, aligned with the list cursor; its
    // "> " prompt then puts the typed query on the content edge.
    const searchBox = new Box(LIST_PADDING, 0);
    searchBox.addChild(this.search);
    this.addChild(searchBox);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(panelBorder(theme));
    this.refresh();
  }

  private selectedLanguages(): string[] {
    return this.available.filter((language) =>
      this.selected.has(language),
    );
  }

  // Selected languages are pinned to the top of the list so the current
  // selection is always visible without scrolling.
  private reorder(): void {
    const available = this.available;
    this.ordered = [
      ...available.filter((language) => this.selected.has(language)),
      ...available.filter((language) => !this.selected.has(language)),
    ];
  }

  private continueRowIndex(): number {
    return this.filtered.length;
  }

  private refresh(focusLanguage?: string): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.ordered, query, (language) => `${displayLanguage(language)} ${language}`)
      : this.ordered;
    if (focusLanguage) {
      const index = this.filtered.indexOf(focusLanguage);
      if (index >= 0) this.selectedIndex = index;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.continueRowIndex());
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), LIST_PADDING, 0));
    } else {
      // In the unfiltered list, a rule separates the pinned (selected) group
      // from the rest. It is a real row in the scroll window (null entry), so
      // it scrolls like any other line instead of appearing and disappearing,
      // which would shift the layout below the list.
      const boundary =
        !query && this.selected.size > 0 && this.selected.size < this.filtered.length
          ? this.selected.size
          : -1;
      const rows: (string | null)[] =
        boundary >= 0
          ? [...this.filtered.slice(0, boundary), null, ...this.filtered.slice(boundary)]
          : [...this.filtered];
      const cursorRow =
        boundary >= 0 && this.selectedIndex >= boundary
          ? this.selectedIndex + 1
          : this.selectedIndex;
      // Sized +1 so the window holds the same line count with or without the
      // rule row.
      const [start, end] = selectedWindow(rows, cursorRow, this.windowRows);
      for (let index = start; index < end; index += 1) {
        const language = rows[index]!;
        if (language === null) {
          this.list.addChild(
            new Text(`  ${this.theme.fg("dim", "─".repeat(LANGUAGE_NAME_WIDTH + 6))}`, LIST_PADDING, 0),
          );
          continue;
        }
        const active = index === cursorRow;
        const checked = this.selected.has(language);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const mark = selectionMarker(this.theme, checked);
        const name = padToWidth(displayLanguage(language), LANGUAGE_NAME_WIDTH);
        this.list.addChild(
          new Text(
            `${prefix}${mark} ${active ? this.theme.fg("accent", name) : name}${this.theme.fg("dim", language)}`,
            LIST_PADDING,
            0,
          ),
        );
      }
    }

    const selected = this.selectedLanguages();
    const onContinue = this.selectedIndex === this.continueRowIndex();
    const continuePrefix = onContinue ? this.theme.fg("accent", "→ ") : "  ";
    const continueAction = ` ${this.keys.keyText("voice.languages.continue")}  Continue `;
    const continueRow = selected.length === 0
      ? this.theme.fg("warning", "Select at least one language to continue")
      : this.theme.inverse(
          this.theme.fg("accent", this.theme.bold(continueAction)),
        );
    this.list.addChild(new Spacer(1));
    this.list.addChild(new Text(`${continuePrefix}${continueRow}`, LIST_PADDING, 0));

    this.footer.setText(
      `${this.keys.navHint("move")}  ${this.keys.hint(["voice.languages.toggle", "tui.select.confirm"], "select")}  ${this.keys.hint("tui.select.cancel", query ? "clear search" : this.cancelLabel)}`,
    );
    this.tui.requestRender();
  }

  private toggleHighlighted(): void {
    const language = this.filtered[this.selectedIndex];
    if (!language) return;
    const adding = !this.selected.has(language);
    if (adding) this.selected.add(language);
    else this.selected.delete(language);
    this.reorder();
    // A search query is spent once used: clear it so the full list returns.
    this.search.setValue("");
    // Follow a newly selected language so the user sees it land in the pinned
    // group; on deselect stay put — trailing the language to its new spot far
    // down the list is disorienting.
    this.refresh(adding ? language : undefined);
  }

  // The pane replaces the host editor and cannot scroll: when the terminal is
  // short, shrink the window so the title, Continue row, and footer stay on
  // screen.
  override render(width: number): string[] {
    const budget = paneRowBudget(this.tui);
    if (budget !== undefined) {
      const chrome = super.render(width).length - this.list.render(width).length;
      // The spacer and Continue row live inside the list; the scroll window
      // gets the rest, still +1 sized for the rule row.
      const rows = windowSizeForBudget(
        budget - chrome - 2,
        MAX_VISIBLE_LANGUAGES + 1,
        MIN_VISIBLE_ROWS + 1,
      );
      if (rows !== this.windowRows) {
        this.windowRows = rows;
        this.refresh();
      }
    }
    return super.render(width);
  }

  handleInput(data: string): void {
    const lastIndex = this.continueRowIndex();
    if (this.keys.matches(data, "voice.languages.continue")) {
      const selected = this.selectedLanguages();
      if (selected.length > 0) this.done({ languages: selected, confirmed: true });
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? lastIndex : this.selectedIndex - 1;
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === lastIndex ? 0 : this.selectedIndex + 1;
      this.refresh();
      return;
    }
    if (this.keys.matches(data, "voice.languages.toggle")) {
      this.toggleHighlighted();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (this.selectedIndex === this.continueRowIndex()) {
        const selected = this.selectedLanguages();
        if (selected.length > 0) this.done({ languages: selected, confirmed: true });
        return;
      }
      // Enter on a language toggles it, so landing Enter never silently
      // confirms a selection the user was not pointing at.
      this.toggleHighlighted();
      return;
    }
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        // Esc keeps the current selection; only an empty selection reads as
        // "never mind".
        const selected = this.selectedLanguages();
        this.done(
          selected.length > 0 ? { languages: selected, confirmed: false } : undefined,
        );
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

/** Languages offered beyond the user's saved ones, most spoken first. */
const COMMON_LANGUAGES = [
  "en", "zh", "es", "hi", "ar", "pt", "ru", "ja", "ko", "de", "fr", "it",
  "tr", "pl", "nl", "vi", "th", "id", "uk", "yue",
] as const;

export function defaultSpokenLanguages(): string[] {
  const locale = languageIdentity(Intl.DateTimeFormat().resolvedOptions().locale);
  return locale ? [locale] : ["en"];
}

export async function chooseLanguages(
  ctx: ExtensionContext,
  initial: readonly string[] = defaultSpokenLanguages(),
  options: { cancelLabel?: string; onboardingStep?: number } = {},
): Promise<LanguageSelection | undefined> {
  return ctx.ui.custom<LanguageSelection | undefined>((tui, theme, keybindings, done) =>
    new LanguagePicker(
      tui,
      theme,
      keybindings,
      initial,
      options.cancelLabel ?? "close",
      done,
      options.onboardingStep,
    ),
  );
}

export function transcriptionLanguageSummary(language: TranscriptionLanguage): string {
  return language === "auto" ? "Auto detect" : displayLanguage(language);
}

/** Single-choice picker: Auto detect plus the user's preferred languages. */
export function chooseTranscriptionLanguage(
  ctx: ExtensionContext,
  current: TranscriptionLanguage,
  preferredLanguages: readonly string[],
): Promise<TranscriptionLanguage | undefined> {
  return ctx.ui.custom<TranscriptionLanguage | undefined>((tui, theme, keybindings, done) =>
    createTranscriptionLanguagePicker(tui, theme, keybindings, current, preferredLanguages, done),
  );
}

export function createTranscriptionLanguagePicker(
  tui: TUI,
  theme: UiTheme,
  keybindings: KeybindingsManager,
  current: TranscriptionLanguage,
  preferredLanguages: readonly string[],
  done: (language: TranscriptionLanguage | undefined) => void,
): SingleSelectPicker<TranscriptionLanguage> {
  // The chosen language stays selectable even if it was removed from the
  // preferred list, so the summary can never point at a hidden row.
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const language of [current === "auto" ? undefined : current, ...preferredLanguages]) {
    if (!language) continue;
    const identity = languageIdentity(language);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    codes.push(language);
  }
  const choices: SingleSelectChoice<TranscriptionLanguage>[] = [
    {
      value: "auto",
      label: "Auto detect",
      description: "Let the transcription service detect the language of each recording.",
    },
    ...codes.map((language) => ({ value: language, label: displayLanguage(language) })),
  ];
  return new SingleSelectPicker(
    tui,
    theme,
    keybindings,
    choices,
    current,
    {
      title: "Choose transcription language",
      subtitle: "Language expected in recordings, or automatic detection.",
      searchable: true,
      maximumVisible: MAX_VISIBLE_LANGUAGES,
      cancelLabel: "back",
      renderLabel: (choice, active) => {
        const nameText = padToWidth(choice.label, TRANSCRIPTION_LANGUAGE_NAME_WIDTH);
        const name = active ? theme.fg("accent", nameText) : nameText;
        const code = choice.value === "auto" ? "" : theme.fg("dim", choice.value);
        return `${name}  ${code}`;
      },
    },
    done,
  );
}
