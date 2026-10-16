// ---------------------------------------------------------------------------
// Business claims the site does not support, taken out of a draft
// ---------------------------------------------------------------------------
//
// The writer is told to state nothing about the business beyond what its own
// pages and profile say (lib/ai/prompts.ts), and nothing checked that it
// didn't. The first draft is an article about the owner's own business, read
// before they pay: a phone number, a town, "30 years" or a guarantee the
// business never stated is the line they stop at. Measured on 59 drafts for
// ten small-business sites (2026-10-15): the writer mostly kept to what it
// was given (several "invented" facts a reviewer flagged were on the site),
// but it pasted the owner's first-person about-page greeting mid-article.
//
// So after the writer, every sentence about the business (it names the
// business, or says "we"/"our") is read for the claims that can be checked
// against what the writer was given - contact details, places, years, counts,
// initials, free offers and guarantees, accreditations - and a sentence with a
// claim nothing the business said supports is removed, and listed for the
// reviewer. Deterministic on purpose: no model call, the same draft gives the
// same answer, and the check costs nothing on the first look's budget.
//
// The evidence is the business's own: its profile, its site facts and what
// the owner told us. Never the research - a ranking page's phone number or a
// rival's "since 1990" is exactly what must not become this business's.

import { decodeEntities, stripTags } from "@/lib/audit/html-utils";
import { foldCase } from "@/lib/i18n/locale";
import { splitSentencesHtml } from "@/lib/content/enrich/html";
import type { SiteFacts } from "@/lib/ai/types";

export type BusinessClaimKind =
  | "phone"
  | "email"
  | "address"
  | "years"
  | "count"
  | "place"
  | "initials"
  | "offer"
  | "accreditation"
  | "bio";

export interface RemovedBusinessClaim {
  kind: BusinessClaimKind;
  /** The words that made the claim, as written. */
  claim: string;
  /** The sentence taken out, as text. */
  sentence: string;
}

export interface BusinessEvidence {
  /** The names the business goes by: its name, its domain's name. */
  names: string[];
  /** Everything the business itself said, folded for matching. */
  text: string;
  /** Its about page's own words, to catch a copy pasted into the article. */
  about: string | null;
}

/**
 * The business's own words, from what the writer was given about it.
 * `profile` is `workspaces.business_profile`; any string in it counts.
 */
export function businessEvidence(input: {
  domain: string | null | undefined;
  profile: unknown;
  facts: SiteFacts | null | undefined;
  instructions?: string | null;
  answers?: Array<{ question: string; answer: string }>;
}): BusinessEvidence {
  const parts: string[] = [];
  const collect = (v: unknown, depth = 0) => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => collect(x, depth + 1));
    else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => collect(x, depth + 1));
  };
  collect(input.profile);
  const f = input.facts;
  if (f) {
    collect(f.offerings.map((o) => [o.name, o.url]));
    collect(f.work.map((w) => [w.name, w.url]));
    collect(f.headings.map((h) => h.items));
    collect(f.stated.map((s) => s.text));
    collect(f.about?.text);
    collect(f.people.map((p) => [p.name, p.role]));
    collect(f.pages.map((p) => [p.name, p.url]));
    collect(f.conversion?.url);
  }
  collect(input.instructions);
  collect(input.answers?.map((a) => a.answer));
  if (input.domain) parts.push(input.domain);

  const profileName = (input.profile as { name?: unknown } | null)?.name;
  const names = new Set<string>();
  if (typeof profileName === "string" && profileName.trim()) names.add(profileName.trim());
  const host = (input.domain ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/.]/)[0];
  if (host && host.length >= 3) names.add(host);
  return { names: [...names], text: fold(parts.join("\n")), about: f?.about?.text ? fold(f.about.text) : null };
}

function fold(s: string): string {
  // Hyphens read as spaces: "5-year" and "5 year" are the same claim.
  return foldCase(decodeEntities(s)).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[-‐‑–]/g, " ").replace(/\s+/g, " ");
}

const digits = (s: string) => s.replace(/\D/g, "");

/** First person plural (and the singular a pasted bio uses), per language. */
const FIRST_PERSON = /\b(we|we're|we've|our|ours|i'm|noi|nostr[oaie]|siamo|abbiamo|nosotros|nuestr[oa]s?|somos|nous|notre|nos|wir|unser(?:e|er|em|en|es)?)\b/i;
const BIO = /\b(my name is|mi chiamo|me llamo|je m'appelle|ich hei(?:ss|ß)e)\b/i;

const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?){2,4}\d{2,4}/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
/** UK postcode, or an Italian/Spanish/French/German 5-digit code before a capitalised town. */
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b|\b(\d{5})\s+[A-Z][\p{L}'-]+/gu;
const STREET = /\b\d{1,4}[a-z]?,?\s+[A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'-]+)*\s+(?:Road|Rd|Street|St|Lane|Avenue|Ave|Way|Close|Drive)\b|\b(?:Via|Viale|Piazza|Corso|Calle|Rue|Straße|Strasse)\s+[A-Z][\p{L}'. -]+?,?\s+\d{1,4}\b/gu;
const YEARS = /\b(?:over|more than|almost|nearly|oltre|più di|quasi|da|más de|plus de|über|seit)?\s*(\d{1,3})\+?\s*(years?|anni|años|ans|jahre[n]?)\b/gi;
const SINCE = /\b(?:since|established in|founded in|est\.?|dal|fondat[ao] nel|nat[ao] nel|desde|depuis|seit|gegründet)\s+(1[89]\d\d|20[0-2]\d)\b/gi;
const COUNT = /\b(\d[\d.,]*)\+?\s*(?:happy\s+|satisfied\s+)?(clients?|customers?|projects?|installations?|jobs|homes|students|trainees|reviews|employees|staff|engineers|technicians|specialists|clienti|progetti|installazioni|interventi|lavori|dipendenti|tecnici|recensioni|studenti|clientes|proyectos|empleados|clients|projets|kunden|projekte|mitarbeiter)\b/gi;
const PLACE = /\b(?:based in|located in|headquartered in|head office in|offices? in|with (?:a |its )?(?:base|office|showroom) in|con sede a|ha sede a|sede (?:a|in)|situat[ao] a|si trova a|con sede en|basée? à|ansässig in|mit sitz in)\s+([\p{Lu}][\p{L}'-]+(?:[\s-][\p{Lu}][\p{L}'-]+)?)/gu;
const OFFER = /\b(free(?: of charge)?|no[- ]obligation|money[- ]back|guarantee[ds]?|guaranteed|warrant(?:y|ies)|gratuit[aoie]?|gratis|senza impegno|garanzi[ae]|garantit[aoie]|gratuito|garantía|gratuite?|garantie|kostenlos|garantie)\b/gi;
const QUALIFIER = /\b(lifetime|life-long|\d{1,2}[- ]years?|\d{1,2}[- ]month|a vita|\d{1,2} anni|\d{1,2} mesi|de por vida|\d{1,2} años|à vie|\d{1,2} ans|lebenslang|\d{1,2} jahre)\b/i;
const ACCREDITATION = /\b(Gas Safe(?: registered)?|OFTEC|HETAS|NICEIC|NAPIT|TrustMark|Which\?|Checkatrade|ISO\s?\d{3,5}|F-?gas|FGAS|accredited|certified|registered|approved|chartered|qualified|certificat[aoie]|accreditat[aoie]|iscritt[aoie]|abilitat[aoie]|certificad[oa]s?|zertifiziert)\b/gi;

/** The sentence is about this business: it names it, or speaks as it. */
/** Italian and Spanish say "we" in the verb: "offriamo", "ofrecemos". */
const FIRST_PERSON_VERB = /(?<![\p{L}])\p{L}{2,}(?:iamo|amos|emos|imos)(?![\p{L}])/iu;

function aboutBusiness(text: string, ev: BusinessEvidence): boolean {
  if (FIRST_PERSON.test(text) || FIRST_PERSON_VERB.test(text)) return true;
  const t = fold(text);
  return ev.names.some((n) => {
    const name = fold(n);
    return name.length >= 3 && t.includes(name);
  });
}

function supported(term: string, ev: BusinessEvidence): boolean {
  const t = fold(term).trim();
  if (!t) return false;
  // Whole words only: "free" is not supported by "freephone", nor "Ilkeston" by "Ilk".
  return new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(ev.text);
}

/**
 * The number with what it counts, near each other in the business's words:
 * "27 years" is not supported by "27 reviews".
 */
function countSupported(n: string, unit: string, ev: BusinessEvidence): boolean {
  const num = n.replace(/[.,](?=\d{3}\b)/g, "");
  const stem = fold(unit).slice(0, 4);
  const text = ev.text.replace(/(\d)[.,](?=\d{3}\b)/g, "$1");
  const re = new RegExp(`(?<![\\d.,])${num}(?![\\d]|[.,]\\d)\\+?[^.\\d]{0,24}?${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
  return re.test(text);
}

function numberSupported(n: string, ev: BusinessEvidence): boolean {
  const needle = n.replace(/[.,](?=\d{3}\b)/g, "");
  return new RegExp(`(?<![\\d.,])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d]|[.,]\\d)`).test(ev.text.replace(/(\d)[.,](?=\d{3}\b)/g, "$1"));
}

/** Initials of the business name spelled out in brackets, e.g. "ACR (Assistenza Climatizzatori Refrigeratori)". */
function inventedInitials(text: string, ev: BusinessEvidence): string | null {
  for (const n of ev.names) {
    for (const acr of n.split(/\s+/).filter((w) => /^[A-Z]{2,6}$/.test(w))) {
      const words = String.raw`((?:[\p{L}'-]+\s+){${acr.length - 1},${acr.length + 3}}[\p{L}'-]+)`;
      const re = new RegExp(String.raw`\b${acr}\b\s*\(${words}\)|${words}\s*\(${acr}\)`, "u");
      const m = text.match(re);
      const expansion = m?.[1] ?? m?.[2];
      if (!expansion) continue;
      const initials = expansion.split(/\s+/).filter((w) => w.length > 2).map((w) => w[0].toUpperCase()).join("");
      if (initials.startsWith(acr[0]) && !supported(expansion, ev)) return `${acr} (${expansion})`;
    }
  }
  return null;
}

/** Ten or more words in a row copied from the about page. */
function pastedAbout(text: string, ev: BusinessEvidence): boolean {
  if (!ev.about) return false;
  const words = fold(text).split(" ").filter(Boolean);
  for (let i = 0; i + 10 <= words.length; i++) {
    if (ev.about.includes(words.slice(i, i + 10).join(" "))) return true;
  }
  return false;
}

/** The first unsupported claim a sentence makes about the business, or null. */
export function unsupportedClaim(sentence: string, ev: BusinessEvidence): { kind: BusinessClaimKind; claim: string } | null {
  const text = decodeEntities(sentence).replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Contact details and addresses are this business's wherever they appear:
  // an article has no reason to print anyone else's.
  for (const m of text.matchAll(PHONE)) {
    const d = digits(m[0]);
    if (d.length >= 9 && d.length <= 15 && !/^(19|20)\d{2}$/.test(d) && !digits(ev.text).includes(d)) {
      // A run of numbers in prose ("10 12 14 16") is not a phone number.
      if (/[\s.-]/.test(m[0].trim()) || m[0].trim().startsWith("+") || m[0].trim().startsWith("0")) return { kind: "phone", claim: m[0].trim() };
    }
  }
  for (const m of text.matchAll(EMAIL)) if (!supported(m[0], ev)) return { kind: "email", claim: m[0] };
  for (const m of text.matchAll(POSTCODE)) {
    const code = (m[1] ?? m[2]).replace(/\s/g, "");
    if (!fold(ev.text).replace(/\s/g, "").includes(fold(code))) return { kind: "address", claim: m[0].trim() };
  }
  for (const m of text.matchAll(STREET)) if (!supported(m[0], ev)) return { kind: "address", claim: m[0].trim() };

  if (BIO.test(text) || pastedAbout(text, ev)) return { kind: "bio", claim: text.slice(0, 60) };

  const initials = inventedInitials(text, ev);
  if (initials) return { kind: "initials", claim: initials };

  // Everything else is only a claim about the business when the sentence is
  // about the business: "a boiler needs a service every 12 months" is advice.
  if (!aboutBusiness(text, ev)) return null;
  for (const m of text.matchAll(SINCE)) if (!numberSupported(m[1], ev)) return { kind: "years", claim: m[0].trim() };
  for (const m of text.matchAll(YEARS)) {
    if (!/experience|esperienza|experiencia|expérience|erfahrung|trading|in business|attivit|settore|mercato|operat|lavor|serv/i.test(text)) continue;
    if (!countSupported(m[1], m[2], ev)) return { kind: "years", claim: m[0].trim() };
  }
  for (const m of text.matchAll(COUNT)) if (!countSupported(m[1], m[2], ev)) return { kind: "count", claim: m[0].trim() };
  for (const m of text.matchAll(PLACE)) if (!supported(m[1], ev)) return { kind: "place", claim: m[0].trim() };
  for (const m of text.matchAll(OFFER)) {
    if (!supported(m[0], ev)) return { kind: "offer", claim: m[0] };
    // "a lifetime guarantee" is not supported by "a 5-year guarantee".
    const near = text.slice(Math.max(0, (m.index ?? 0) - 24), (m.index ?? 0) + m[0].length + 24);
    const q = near.match(QUALIFIER);
    if (q && !supported(q[0], ev)) return { kind: "offer", claim: `${q[0]} ${m[0]}` };
  }
  for (const m of text.matchAll(ACCREDITATION)) {
    // A generic adjective ("qualified", "registered") is a claim only when
    // the business's own words never use it.
    if (!supported(m[0], ev)) return { kind: "accreditation", claim: m[0] };
  }
  return null;
}

const BLOCK = /<(p|li|td|th|blockquote|figcaption)(\b[^>]*)>([\s\S]*?)<\/\1>/gi;

/**
 * Take every sentence with an unsupported business claim out of `html`.
 * A block left empty goes too. Headings are left alone: the outline the
 * owner saw is held to elsewhere, and a heading states no such claim.
 */
export function removeUnsupportedBusinessClaims(html: string, ev: BusinessEvidence): { html: string; removed: RemovedBusinessClaim[] } {
  const removed: RemovedBusinessClaim[] = [];
  const out = html.replace(BLOCK, (whole, tag: string, attrs: string, inner: string) => {
    const kept: string[] = [];
    let changed = false;
    for (const sentence of splitSentencesHtml(inner)) {
      const text = stripTags(sentence);
      const hit = unsupportedClaim(text, ev);
      if (hit) {
        removed.push({ ...hit, sentence: text.replace(/\s+/g, " ").trim() });
        changed = true;
      } else kept.push(sentence);
    }
    if (!changed) return whole;
    const body = kept.join("").trim();
    return stripTags(body).trim() ? `<${tag}${attrs}>${body}</${tag}>` : "";
  });
  return { html: out, removed };
}

/** The reviewer's note for what was taken out, or null. */
export function businessClaimsNote(removed: RemovedBusinessClaim[]): string | null {
  if (!removed.length) return null;
  const list = removed.slice(0, 5).map((r) => `"${r.claim}"`).join(", ");
  return `Removed ${removed.length} sentence${removed.length === 1 ? "" : "s"} stating something about the business that its own pages and profile do not say (${list}${removed.length > 5 ? ", …" : ""}). Add it back only if it is true.`;
}
