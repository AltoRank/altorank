/**
 * Mapping of language codes to DataForSEO language_code + location_code.
 * location_code = the primary country for that language.
 */
export type LocaleEntry = {
  label: string;
  languageCode: string;
  locationCode: number;
  country: string;
};

export const LOCALES: Record<string, LocaleEntry> = {
  en: { label: "English", languageCode: "en", locationCode: 2840, country: "United States" },
  "en-gb": { label: "English (UK)", languageCode: "en", locationCode: 2826, country: "United Kingdom" },
  "en-au": { label: "English (AU)", languageCode: "en", locationCode: 2036, country: "Australia" },
  "en-ca": { label: "English (CA)", languageCode: "en", locationCode: 2124, country: "Canada" },
  es: { label: "Spanish", languageCode: "es", locationCode: 2724, country: "Spain" },
  "es-mx": { label: "Spanish (MX)", languageCode: "es", locationCode: 2484, country: "Mexico" },
  fr: { label: "French", languageCode: "fr", locationCode: 2250, country: "France" },
  de: { label: "German", languageCode: "de", locationCode: 2276, country: "Germany" },
  it: { label: "Italian", languageCode: "it", locationCode: 2380, country: "Italy" },
  pt: { label: "Portuguese", languageCode: "pt", locationCode: 2076, country: "Brazil" },
  "pt-pt": { label: "Portuguese (PT)", languageCode: "pt", locationCode: 2620, country: "Portugal" },
  nl: { label: "Dutch", languageCode: "nl", locationCode: 2528, country: "Netherlands" },
  sv: { label: "Swedish", languageCode: "sv", locationCode: 2752, country: "Sweden" },
  da: { label: "Danish", languageCode: "da", locationCode: 2208, country: "Denmark" },
  no: { label: "Norwegian", languageCode: "no", locationCode: 2578, country: "Norway" },
  fi: { label: "Finnish", languageCode: "fi", locationCode: 2246, country: "Finland" },
  pl: { label: "Polish", languageCode: "pl", locationCode: 2616, country: "Poland" },
  ja: { label: "Japanese", languageCode: "ja", locationCode: 2392, country: "Japan" },
  ko: { label: "Korean", languageCode: "ko", locationCode: 2410, country: "South Korea" },
  zh: { label: "Chinese (Simplified)", languageCode: "zh-CN", locationCode: 2156, country: "China" },
  "zh-tw": { label: "Chinese (Traditional)", languageCode: "zh-TW", locationCode: 2158, country: "Taiwan" },
  ar: { label: "Arabic", languageCode: "ar", locationCode: 2682, country: "Saudi Arabia" },
  hi: { label: "Hindi", languageCode: "hi", locationCode: 2356, country: "India" },
  tr: { label: "Turkish", languageCode: "tr", locationCode: 2792, country: "Turkey" },
  ru: { label: "Russian", languageCode: "ru", locationCode: 2643, country: "Russia" },
  cs: { label: "Czech", languageCode: "cs", locationCode: 2203, country: "Czech Republic" },
  ro: { label: "Romanian", languageCode: "ro", locationCode: 2642, country: "Romania" },
  hu: { label: "Hungarian", languageCode: "hu", locationCode: 2348, country: "Hungary" },
  el: { label: "Greek", languageCode: "el", locationCode: 2300, country: "Greece" },
  th: { label: "Thai", languageCode: "th", locationCode: 2764, country: "Thailand" },
  vi: { label: "Vietnamese", languageCode: "vi", locationCode: 2704, country: "Vietnam" },
  id: { label: "Indonesian", languageCode: "id", locationCode: 2360, country: "Indonesia" },
  ms: { label: "Malay", languageCode: "ms", locationCode: 2458, country: "Malaysia" },
  he: { label: "Hebrew", languageCode: "he", locationCode: 2376, country: "Israel" },
  uk: { label: "Ukrainian", languageCode: "uk", locationCode: 2804, country: "Ukraine" },
};

/** Get locale entry, defaulting to English/US. */
export function getLocale(language: string): LocaleEntry {
  return LOCALES[language] ?? LOCALES.en;
}

/** Sorted locale options for UI dropdowns. */
export function getLocaleOptions(): { value: string; label: string }[] {
  return Object.entries(LOCALES)
    .map(([value, entry]) => ({ value, label: `${entry.label} (${entry.country})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
