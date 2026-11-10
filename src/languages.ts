/** A base code, without changing the identity or the model's exact code. */
export function canonicalLanguage(language: string): string {
  return language.trim().toLowerCase().split("-", 1)[0] ?? "";
}

// Model cards, benchmarks, and language services use different ISO codes
// for these languages (iw/jw are legacy codes for Hebrew and Javanese). This
// identity is for matching, never a code to send directly to a backend.
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { tl: "fil", no: "nb", iw: "he", jw: "jv" };

export function languageIdentity(language: string): string {
  const base = canonicalLanguage(language);
  return LANGUAGE_ALIASES[base] ?? base;
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

export function displayLanguage(language: string): string {
  // ASR services conventionally use zh for Mandarin and list Cantonese as yue.
  // Make that spoken-language distinction explicit without losing the familiar
  // umbrella term users look for.
  if (canonicalLanguage(language) === "zh") return "Mandarin (Chinese)";
  try {
    return languageNames.of(language) ?? language;
  } catch {
    return language;
  }
}
