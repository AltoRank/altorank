/**
 * Small HTML helpers shared across the audit modules.
 *
 * Extracted so the schema generator and the markdown converter decode entities
 * identically. They diverged once already: an undecoded `&ndash;` meant a page
 * title never split on its separator and the whole tagline was proposed as a
 * company name.
 *
 * Deliberately dependency-free and DOM-free so this lifts into packages/core
 * and runs in a Worker, a CLI, or a test with no environment assumptions.
 */

const BASE_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "…",
  // Typographic entities are load-bearing: they carry the separators and
  // punctuation that downstream parsing keys off.
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  middot: "·", bull: "•", laquo: "«", raquo: "»", rarr: "→", larr: "←",
  times: "×", euro: "€", pound: "£", copy: "©", reg: "®", trade: "™",
  deg: "°", plusmn: "±", frac12: "½", sup2: "²", sup3: "³",
};

/**
 * Accented letters, which matter more than they look: the target market is
 * European agency sites and Italian markup is full of `&agrave;`, `&egrave;`
 * and `&ugrave;`. Left undecoded they surface as literal "attivit&agrave;" in
 * generated Markdown, which is exactly the kind of detail that makes output
 * look machine-mangled to the client whose site it describes.
 */
const ACCENTS: Record<string, string> = {
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ", ograve: "ò",
  oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù",
  uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", szlig: "ß",
};

const ENTITIES: Record<string, string> = { ...BASE_ENTITIES, ...ACCENTS };
// Uppercase named entities (&Agrave;) map to the uppercase letter. Derived
// rather than listed so the two tables cannot drift apart.
for (const [name, char] of Object.entries(ACCENTS)) {
  ENTITIES[name[0].toUpperCase() + name.slice(1)] = char.toUpperCase();
}

/**
 * Resolve HTML entities, leaving whitespace untouched.
 *
 * Kept separate from `decode` because the Markdown converter inserts newlines
 * to carry block structure and then runs entity decoding over the whole
 * document. A decoder that collapses `\s+` destroys those newlines, which
 * silently runs every heading into the paragraph after it.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    const name = m.slice(1, -1);
    if (ENTITIES[name]) return ENTITIES[name];
    const lower = name.toLowerCase();
    if (ENTITIES[lower]) return ENTITIES[lower];
    try {
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    } catch {
      return m; // out-of-range code point: leave the source text alone
    }
    return m; // unknown named entity: leave it rather than mangle it
  });
}

/** Resolve entities and collapse all whitespace to single spaces. */
export const decode = (s: string): string =>
  decodeEntities(s).replace(/\s+/g, " ").trim();

/** Drop all tags and decode what is left. */
export const stripTags = (s: string): string => decode(s.replace(/<[^>]+>/g, " "));

/** Resolve a possibly-relative URL against a base, returning undefined if invalid. */
export function absoluteUrl(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}
