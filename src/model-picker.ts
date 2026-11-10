import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptText, SingleSelectPicker, type SingleSelectChoice } from "./ui-components.js";

/** Sentinel choice that opens the custom model name input. */
const CUSTOM_CHOICE = "__custom__";

const PRESET_MODELS: SingleSelectChoice<string>[] = [
  {
    value: "whisper-1",
    label: "whisper-1",
    description: "OpenAI Whisper — the most compatible default",
  },
  {
    value: "gpt-4o-transcribe",
    label: "gpt-4o-transcribe",
    description: "OpenAI GPT-4o Transcribe — newest OpenAI speech model",
  },
  {
    value: "gpt-4o-mini-transcribe",
    label: "gpt-4o-mini-transcribe",
    description: "OpenAI GPT-4o mini Transcribe — cheaper and faster",
  },
  {
    value: "whisper-large-v3",
    label: "whisper-large-v3",
    description: "Whisper large v3 — served by Groq and other compatible hosts",
  },
  {
    value: "whisper-large-v3-turbo",
    label: "whisper-large-v3-turbo",
    description: "Whisper large v3 turbo — the fastest hosted Whisper",
  },
];

export type AsrModelPickerOptions = {
  /** Setup context shown beside the title, e.g. "Pi Voice setup · step 2 of 3". */
  subtitle?: string;
};

/**
 * Choose the model name sent to the transcription API: a preset, or a custom
 * name for any other OpenAI-compatible server.
 */
export async function chooseAsrModel(
  ctx: ExtensionContext,
  current: string | undefined,
  options: AsrModelPickerOptions = {},
): Promise<string | undefined> {
  const preset = PRESET_MODELS.some((choice) => choice.value === current);
  const choices: SingleSelectChoice<string>[] = [
    ...PRESET_MODELS,
    { value: CUSTOM_CHOICE, label: "Custom model name…", description: "Type any model name your endpoint serves" },
  ];
  const selection = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      // A custom model is not a row: open on the first preset instead, and
      // let Custom replace it.
      preset ? current : undefined,
      {
        title: "Choose a transcription model",
        subtitle: options.subtitle ??
          "Sent to the OpenAI-compatible transcription endpoint with each recording.",
        cancelLabel: "back",
      },
      done,
    ),
  );
  if (selection === undefined || selection !== CUSTOM_CHOICE) return selection;
  return promptText(ctx, {
    title: "Custom model name",
    subtitle: "The model string your transcription endpoint expects.",
    initial: preset ? undefined : current,
    placeholder: "e.g. whisper-large-v3, my-finetuned-whisper",
    cancelLabel: "back",
  });
}
