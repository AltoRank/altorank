// ---------------------------------------------------------------------------
// Search-intent classification
// ---------------------------------------------------------------------------
//
// Deliberately deterministic: no model call. Intent decides the shape of the
// article (a "best X" list is not a how-to, and a buying page is neither), so
// it runs on every generation. A model call there would add latency and cost to
// the hot path and make the same keyword classify differently between runs.
//
// Two independent signal families:
//
//   Lexical    keyword tokens against a per-language lexicon. Strong signal,
//              but only for languages we have a lexicon for.
//   SERP shape what Google actually returned. Language-independent, so it is
//              the only signal that works across all 36 locales.
//
// When there is no lexicon for the language, classification falls back to SERP
// shape alone and says so via `lexicon: false` rather than quietly scoring the
// keyword with English rules, which would misread most non-English keywords.

import type { SerpData } from "./brief-data";

/** Matches the `intent` check constraint on the `keywords` table. */
export type SearchIntent = "info" | "commercial" | "transactional" | "navigational";

export interface IntentSignal {
  intent: SearchIntent;
  weight: number;
  reason: string;
}

export interface IntentClassification {
  intent: SearchIntent;
  confidence: "high" | "medium" | "low";
  /** Every signal that fired, so a human can see why. */
  signals: IntentSignal[];
  /** False when the language has no lexicon and only SERP shape was used. */
  lexicon: boolean;
}

// ── Lexicons ───────────────────────────────────────────────────────────────
//
// Covers English plus the EU locales the ICP sells into. Multi-word entries are
// matched as phrases; single words as whole tokens.

type Lexicon = Record<SearchIntent, string[]>;

const LEXICONS: Record<string, Lexicon> = {
  en: {
    info: ["how", "what", "why", "when", "guide", "tutorial", "examples", "ideas",
      "meaning", "definition", "tips", "checklist", "explained", "vs"],
    commercial: ["best", "top", "review", "reviews", "versus", "comparison", "compare",
      "alternative", "alternatives", "which", "cheapest", "rated"],
    transactional: ["buy", "price", "pricing", "cost", "order", "shop", "discount",
      "coupon", "deal", "deals", "for sale", "near me", "free trial", "download", "hire"],
    navigational: ["login", "log in", "sign in", "dashboard", "official", "contact", "careers"],
  },
  it: {
    info: ["come", "cosa", "perché", "perche", "quando", "guida", "tutorial", "esempi",
      "idee", "significato", "definizione", "consigli"],
    commercial: ["migliore", "migliori", "recensione", "recensioni", "confronto",
      "alternativa", "alternative", "quale"],
    transactional: ["comprare", "acquistare", "prezzo", "prezzi", "costo", "costi",
      "offerta", "offerte", "sconto", "preventivo", "vendita", "vicino a me"],
    navigational: ["login", "accedi", "contatti", "area clienti"],
  },
  es: {
    info: ["como", "cómo", "que", "qué", "por qué", "cuando", "cuándo", "guía", "guia",
      "tutorial", "ejemplos", "ideas", "significado", "definición", "consejos"],
    commercial: ["mejor", "mejores", "reseña", "reseñas", "opiniones", "comparativa",
      "alternativa", "alternativas", "cuál", "cual"],
    transactional: ["comprar", "precio", "precios", "costo", "coste", "oferta", "ofertas",
      "descuento", "presupuesto", "venta", "cerca de mí"],
    navigational: ["iniciar sesión", "acceso", "contacto"],
  },
  fr: {
    info: ["comment", "quoi", "pourquoi", "quand", "guide", "tutoriel", "exemples",
      "idées", "idees", "signification", "définition", "conseils"],
    commercial: ["meilleur", "meilleurs", "meilleure", "avis", "comparatif", "comparaison",
      "alternative", "alternatives", "quel", "quelle"],
    transactional: ["acheter", "prix", "tarif", "tarifs", "coût", "cout", "offre", "promo",
      "remise", "devis", "vente", "près de moi"],
    navigational: ["connexion", "se connecter", "contact"],
  },
  de: {
    info: ["wie", "was", "warum", "wann", "anleitung", "leitfaden", "tutorial", "beispiele",
      "ideen", "bedeutung", "definition", "tipps"],
    commercial: ["beste", "bester", "besten", "test", "vergleich", "bewertung", "bewertungen",
      "alternative", "alternativen", "welche", "welcher"],
    transactional: ["kaufen", "preis", "preise", "kosten", "angebot", "angebote", "rabatt",
      "gutschein", "bestellen", "in meiner nähe"],
    navigational: ["anmelden", "login", "kontakt"],
  },
  pt: {
    info: ["como", "o que", "por que", "porque", "quando", "guia", "tutorial", "exemplos",
      "ideias", "significado", "definição", "dicas"],
    commercial: ["melhor", "melhores", "análise", "avaliação", "comparação", "comparativo",
      "alternativa", "alternativas", "qual"],
    transactional: ["comprar", "preço", "preços", "custo", "oferta", "ofertas", "desconto",
      "orçamento", "venda", "perto de mim"],
    navigational: ["entrar", "login", "contato", "contacto"],
  },
  nl: {
    info: ["hoe", "wat", "waarom", "wanneer", "gids", "handleiding", "tutorial", "voorbeelden",
      "ideeën", "betekenis", "definitie", "tips"],
    commercial: ["beste", "review", "reviews", "vergelijking", "vergelijken", "alternatief",
      "alternatieven", "welke"],
    transactional: ["kopen", "prijs", "prijzen", "kosten", "aanbieding", "korting", "offerte",
      "bij mij in de buurt"],
    navigational: ["inloggen", "contact"],
  },
};

/**
 * Domains whose presence in the top 10 means Google reads the query as
 * something to buy rather than something to read. Marketplaces and price
 * comparators, weighted toward the EU because that is the ICP.
 */
const MARKETPLACE_DOMAINS = [
  "amazon.", "ebay.", "etsy.", "aliexpress.", "walmart.", "temu.",
  "zalando.", "otto.de", "bol.com", "cdiscount.", "fnac.", "mediamarkt.",
  "subito.it", "idealo.", "trovaprezzi.", "kelkoo.", "pccomponentes.",
];

const SHOP_URL_PATTERNS = [/\/product\//i, /\/products\//i, /\/shop\//i, /\/p\/\d/i, /\/dp\//i];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Unicode-aware tokenisation; keeps accented characters as word characters. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function matchesLexeme(keyword: string, tokens: Set<string>, lexeme: string): boolean {
  if (lexeme.includes(" ")) {
    // Phrase: match on a normalised copy so punctuation does not defeat it.
    const haystack = ` ${tokenize(keyword).join(" ")} `;
    return haystack.includes(` ${tokenize(lexeme).join(" ")} `);
  }
  return tokens.has(lexeme);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Classify a keyword's search intent.
 *
 * `serp` is optional: without DataForSEO credentials there is no SERP to read,
 * and the lexicon alone still produces a usable answer for supported languages.
 * `languageCode` is the DataForSEO-style code (`en`, `it`, `zh-CN`), so only
 * the part before the hyphen is used to select a lexicon.
 */
export function classifyIntent(
  keyword: string,
  languageCode = "en",
  serp?: SerpData | null,
): IntentClassification {
  const signals: IntentSignal[] = [];
  const base = languageCode.split("-")[0].toLowerCase();
  const lexicon = LEXICONS[base];

  // --- Lexical signals -----------------------------------------------------
  if (lexicon) {
    const tokens = new Set(tokenize(keyword));
    for (const intent of Object.keys(lexicon) as SearchIntent[]) {
      const hits = lexicon[intent].filter((lexeme) => matchesLexeme(keyword, tokens, lexeme));
      if (hits.length) {
        // Weight per hit, capped: three transactional words are not three times
        // as transactional as one, and uncapped stacking drowns SERP evidence.
        signals.push({
          intent,
          weight: Math.min(hits.length * 2, 4),
          reason: `keyword contains ${hits.map((h) => `"${h}"`).join(", ")}`,
        });
      }
    }
  } else {
    signals.push({
      intent: "info",
      weight: 0,
      reason: `no lexicon for language "${base}"; classified on SERP shape alone`,
    });
  }

  // --- SERP-shape signals --------------------------------------------------
  if (serp) {
    const paa = serp.peopleAlsoAsk.length;
    if (paa >= 3) {
      signals.push({ intent: "info", weight: 2, reason: `${paa} People Also Ask entries` });
    } else if (paa >= 1) {
      signals.push({ intent: "info", weight: 1, reason: `${paa} People Also Ask entry` });
    }

    const wordCounts = serp.organic
      .map((r) => r.wordCount)
      .filter((n): n is number => typeof n === "number" && n > 0);
    const medianWords = median(wordCounts);

    if (medianWords !== null && wordCounts.length >= 3) {
      if (medianWords >= 1800) {
        signals.push({
          intent: "info",
          weight: 1.5,
          reason: `ranking pages are long (median ${Math.round(medianWords)} words)`,
        });
      } else if (medianWords <= 400) {
        signals.push({
          intent: "transactional",
          weight: 1.5,
          reason: `ranking pages are thin (median ${Math.round(medianWords)} words)`,
        });
      }
    }

    const shopHits = serp.organic.filter(
      (r) =>
        MARKETPLACE_DOMAINS.some((d) => r.domain.includes(d)) ||
        SHOP_URL_PATTERNS.some((p) => p.test(r.url)),
    ).length;
    if (shopHits >= 3) {
      signals.push({
        intent: "transactional",
        weight: 2.5,
        reason: `${shopHits} of the top results are shop or marketplace pages`,
      });
    } else if (shopHits >= 1) {
      signals.push({
        intent: "transactional",
        weight: 1,
        reason: `${shopHits} shop or marketplace page in the top results`,
      });
    }

    // Navigational: the keyword names a domain that then ranks first for it.
    const kwTokens = tokenize(keyword);
    const first = serp.organic[0];
    if (first && kwTokens.length <= 3) {
      const domainWord = first.domain.replace(/^www\./, "").split(".")[0];
      if (domainWord.length >= 4 && kwTokens.some((t) => t === domainWord)) {
        signals.push({
          intent: "navigational",
          weight: 3,
          reason: `keyword names ${first.domain}, which ranks first`,
        });
      }
    }
  } else {
    signals.push({
      intent: "info",
      weight: 0,
      reason: "no SERP data available; classified on keyword wording alone",
    });
  }

  // --- Resolve -------------------------------------------------------------
  const totals: Record<SearchIntent, number> = {
    info: 0, commercial: 0, transactional: 0, navigational: 0,
  };
  for (const s of signals) totals[s.intent] += s.weight;

  const ranked = (Object.keys(totals) as SearchIntent[])
    .map((intent) => ({ intent, score: totals[intent] }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const margin = top.score - ranked[1].score;

  // Informational is the safe default: a how-to written for a commercial query
  // reads as a weak article, while a sales page written for a how-to query
  // reads as spam and is the more expensive mistake.
  const intent: SearchIntent = top.score === 0 ? "info" : top.intent;

  let confidence: IntentClassification["confidence"] = "low";
  if (top.score >= 3 && margin >= 2) confidence = "high";
  else if (top.score >= 2 && margin >= 1) confidence = "medium";

  return { intent, confidence, signals, lexicon: Boolean(lexicon) };
}

/** Article-shape guidance per intent, injected into the generation prompt. */
export const INTENT_GUIDANCE: Record<SearchIntent, string> = {
  info: "The searcher wants to understand something. Answer the question in the " +
    "first paragraph, then build depth. Prefer definitions, steps and worked " +
    "examples over persuasion.",
  commercial: "The searcher is comparing options before deciding. Lead with a " +
    "comparison or a shortlist, give explicit selection criteria, and state " +
    "trade-offs plainly. Do not write a single-vendor pitch.",
  transactional: "The searcher is ready to act. Put the practical detail early " +
    "(what it costs, what is included, how to start) and keep background short.",
  navigational: "The searcher is looking for a specific destination. Keep it " +
    "short and factual, and point at the thing they are looking for rather than " +
    "writing around it.",
};
