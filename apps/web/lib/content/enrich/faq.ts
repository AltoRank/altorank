// ---------------------------------------------------------------------------
// Step 7: FAQPage structured data from a FAQ the article already has
// ---------------------------------------------------------------------------
//
// Extracted, never written. `extractFaqPairs` in lib/audit/schema-generator is
// the same reader the site audit uses on customers' pages, so a draft and a
// live page are judged by one rule. The schema is returned, not injected: the
// editor holds prose, `articles` has no schema column, and a `<script>` in the
// body would be stored as a paragraph of JSON by the Tiptap converter. The
// publishing adapters are where it belongs, and they get it from the report.

import { extractFaqPairs } from "@/lib/audit/schema-generator";
import { matchesAnyHeading } from "@/lib/i18n/locale";
import { splitSections, stripTags } from "./html";

/**
 * A FAQ heading in any language the locale contract describes: the prompt
 * asks for one in the article's language ("Sıkça sorulan sorular"), and this
 * is the reader that has to recognise what the prompt asked for.
 */
export function isFaqHeading(text: string): boolean {
  return matchesAnyHeading("faq", text);
}

export interface FaqSchema {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: {
    "@type": "Question";
    name: string;
    acceptedAnswer: { "@type": "Answer"; text: string };
  }[];
}

/**
 * Whether the body has a FAQ-shaped part: a heading that says so, or at least
 * three question headings. Same rule as the audit tab's `faq-section` check.
 */
export function hasFaqShape(html: string): boolean {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => stripTags(m[2]));
  if (headings.some(isFaqHeading)) return true;
  return headings.filter((h) => h.trim().endsWith("?")).length >= 3;
}

export function buildFaqSchema(html: string): { schema: FaqSchema | null; count: number } {
  if (!hasFaqShape(html)) return { schema: null, count: 0 };

  // Prefer the pairs under the FAQ heading itself, so a rhetorical question
  // heading elsewhere in the article does not become a FAQ entry.
  const { sections } = splitSections(html);
  const faqSection = sections.find((s) => isFaqHeading(s.headingText));
  const source = faqSection ? faqSection.body : html;

  const pairs = extractFaqPairs(source);
  if (pairs.length < 2) return { schema: null, count: 0 };

  return {
    count: pairs.length,
    schema: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: pairs.map((p) => ({
        "@type": "Question",
        name: p.question,
        acceptedAnswer: { "@type": "Answer", text: p.answer },
      })),
    },
  };
}
