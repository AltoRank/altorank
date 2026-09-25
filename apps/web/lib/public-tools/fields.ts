// ---------------------------------------------------------------------------
// Input fields shared by the paid tools
// ---------------------------------------------------------------------------
//
// The field names, limits and options mirror the forms on altorank.co (the
// marketing repo's src/data/server-tools.ts): a tool's schema must accept
// exactly what its form sends. Change one, change the other.
//
// Messages are shown to the visitor as-is, so they are sentences.

import { z } from "zod";
import { parsePublicDomain } from "@/lib/public-check/domain";
import { COUNTRY_CODES, type CountryCode } from "./locations";

/** A required single-line text field, trimmed. */
export function requiredText(what: string, max: number) {
  return z
    .string({ error: `Enter ${what}.` })
    .trim()
    .min(1, `Enter ${what}.`)
    .max(max, `Keep ${what} under ${max} characters.`);
}

/**
 * An optional single-line text field. The form sends "" for an empty field;
 * that, whitespace, null and a missing key all become undefined.
 */
export function optionalText(what: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, `Keep ${what} under ${max} characters.`)
    .nullish()
    .transform((v) => (v ? v : undefined));
}

export function countWords(s: string): number {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Pasted text: 20,000 characters at most, and optionally a word cap. */
export function pastedText(maxWords?: number) {
  const base = z
    .string({ error: "Paste some text to work on." })
    .trim()
    .min(1, "Paste some text to work on.")
    .max(20_000, "That is more than 20,000 characters. Paste a shorter passage.");
  if (!maxWords) return base;
  return base.refine((v) => countWords(v) <= maxWords, {
    message: `That is more than ${maxWords.toLocaleString("en-US")} words. Paste a shorter passage, or run it section by section.`,
  });
}

/** One of the form's select options. A missing value takes the form's default. */
export function choice<const T extends readonly [string, ...string[]]>(options: T, fallback: T[number], what: string) {
  return z.enum(options, { error: `Choose a ${what} from the list.` }).default(fallback);
}

export const countryInput = z
  .enum(COUNTRY_CODES as unknown as [CountryCode, ...CountryCode[]], { error: "Choose a country from the list." })
  .default("us");

/** A public registrable domain, normalised: scheme, path and www. removed. */
export const publicDomain = z
  .string({ error: "Enter a domain, for example example.com." })
  .max(253, "That domain is too long.")
  .transform((v, ctx) => {
    const r = parsePublicDomain(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.domain;
  });
