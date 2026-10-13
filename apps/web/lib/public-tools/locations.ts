// ---------------------------------------------------------------------------
// Countries the data tools offer, as DataForSEO location + language
// ---------------------------------------------------------------------------
//
// The forms send an ISO 3166-1 alpha-2 code in lower case. DataForSEO wants a
// location code (Google Ads geo target: 2000 + the ISO numeric code) and one
// language that location supports. Where a country has more than one, the
// language is the one most of its searches are in.

export const COUNTRIES = {
  us: { locationCode: 2840, languageCode: "en", name: "United States" },
  gb: { locationCode: 2826, languageCode: "en", name: "United Kingdom" },
  ca: { locationCode: 2124, languageCode: "en", name: "Canada" },
  au: { locationCode: 2036, languageCode: "en", name: "Australia" },
  ie: { locationCode: 2372, languageCode: "en", name: "Ireland" },
  de: { locationCode: 2276, languageCode: "de", name: "Germany" },
  at: { locationCode: 2040, languageCode: "de", name: "Austria" },
  ch: { locationCode: 2756, languageCode: "de", name: "Switzerland" },
  fr: { locationCode: 2250, languageCode: "fr", name: "France" },
  it: { locationCode: 2380, languageCode: "it", name: "Italy" },
  es: { locationCode: 2724, languageCode: "es", name: "Spain" },
  nl: { locationCode: 2528, languageCode: "nl", name: "Netherlands" },
  be: { locationCode: 2056, languageCode: "nl", name: "Belgium" },
  se: { locationCode: 2752, languageCode: "sv", name: "Sweden" },
  dk: { locationCode: 2208, languageCode: "da", name: "Denmark" },
  pl: { locationCode: 2616, languageCode: "pl", name: "Poland" },
  pt: { locationCode: 2620, languageCode: "pt", name: "Portugal" },
  in: { locationCode: 2356, languageCode: "en", name: "India" },
  br: { locationCode: 2076, languageCode: "pt", name: "Brazil" },
  mx: { locationCode: 2484, languageCode: "es", name: "Mexico" },
} as const;

export type CountryCode = keyof typeof COUNTRIES;
export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

// ISO numeric -> alpha-2 for markets outside the list above, so a result
// that spans every market (website-worth-calculator) can name them.
const NUMERIC_TO_ALPHA2: Record<number, string> = {
  12: "DZ", 32: "AR", 50: "BD", 100: "BG", 152: "CL", 156: "CN", 170: "CO", 191: "HR",
  203: "CZ", 218: "EC", 818: "EG", 246: "FI", 300: "GR", 344: "HK", 348: "HU", 360: "ID",
  376: "IL", 392: "JP", 398: "KZ", 404: "KE", 410: "KR", 458: "MY", 504: "MA", 554: "NZ",
  566: "NG", 578: "NO", 586: "PK", 604: "PE", 608: "PH", 642: "RO", 643: "RU", 682: "SA",
  688: "RS", 702: "SG", 703: "SK", 705: "SI", 710: "ZA", 158: "TW", 764: "TH", 788: "TN",
  792: "TR", 804: "UA", 784: "AE", 858: "UY", 862: "VE", 704: "VN", 233: "EE", 428: "LV",
  440: "LT", 442: "LU", 196: "CY", 470: "MT", 352: "IS", 188: "CR", 591: "PA", 320: "GT",
  214: "DO", 630: "PR", 68: "BO", 600: "PY", 400: "JO", 414: "KW", 634: "QA", 48: "BH",
  512: "OM", 422: "LB", 144: "LK", 524: "NP", 116: "KH", 288: "GH", 834: "TZ", 800: "UG",
};

/** A readable name for a DataForSEO location code. Falls back to the code. */
export function locationName(locationCode: number): string {
  const known = Object.values(COUNTRIES).find((c) => c.locationCode === locationCode);
  if (known) return known.name;
  const alpha2 = NUMERIC_TO_ALPHA2[locationCode - 2000];
  if (alpha2) {
    try {
      const name = new Intl.DisplayNames(["en"], { type: "region" }).of(alpha2);
      if (name) return name;
    } catch {
      // fall through
    }
  }
  return `Location ${locationCode}`;
}

/** "en" -> "English". Falls back to the code. */
export function languageName(code: string | null | undefined): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
