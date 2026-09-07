// ---------------------------------------------------------------------------
// Structured data that travels with the published body
// ---------------------------------------------------------------------------
//
// The generation step computes FAQPage data (lib/content/enrich/faq.ts) and
// the audit tab grades a page on Article schema, and until now neither
// reached a CMS: `articles` has no schema column, the editor holds prose,
// and the publish payload carried title/html/slug/meta and nothing else. So
// the "FAQ schema" switch in Article settings produced a number in a report
// and no markup anywhere.
//
// The schema is rebuilt from the final HTML at publish time, not read from
// the generation report: the FAQ the editor ends with is the one that ships.
// It rides as a <script type="application/ld+json"> at the end of the body
// for destinations that store raw HTML, and as a field on the webhook
// article. Destinations that parse the body into their own blocks (Notion,
// Wix, Webflow, Framer) get nothing: the tag would come back as a paragraph
// of JSON for readers to see.

import type { CMSConfig } from "@/lib/types";
import { buildFaqSchema, type FaqSchema } from "@/lib/content/enrich/faq";

/** Destinations whose body field keeps a <script> tag as written. */
export const SCRIPT_CAPABLE: ReadonlySet<CMSConfig["type"]> = new Set<CMSConfig["type"]>([
  "wordpress",
  "wordpress-plugin",
  "woocommerce",
  "ghost",
  "shopify",
  "hubspot",
  "git",
]);

export const SCHEMA_MARKER = "data-altorank-schema";

export interface BlogPostingInput {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  /** First publish, or now for one that has none yet. */
  datePublished: string;
  dateModified: string;
  keyword?: string | null;
  /** The business name from the wizard, else the bare domain. */
  publisherName: string;
  language?: string | null;
}

export interface BlogPostingSchema {
  "@context": "https://schema.org";
  "@type": "BlogPosting";
  headline: string;
  description?: string;
  image?: string;
  datePublished: string;
  dateModified: string;
  keywords?: string;
  inLanguage?: string;
  author: { "@type": "Organization"; name: string };
  publisher: { "@type": "Organization"; name: string };
}

/** A BlogPosting for the article as it is about to go out. No URL: it is not known until the far side answers. */
export function blogPostingSchema(input: BlogPostingInput): BlogPostingSchema {
  const org = { "@type": "Organization" as const, name: input.publisherName };
  const schema: BlogPostingSchema = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title.trim().slice(0, 110),
    datePublished: input.datePublished,
    dateModified: input.dateModified,
    author: org,
    publisher: org,
  };
  if (input.description?.trim()) schema.description = input.description.trim();
  if (input.imageUrl?.trim()) schema.image = input.imageUrl.trim();
  if (input.keyword?.trim()) schema.keywords = input.keyword.trim();
  if (input.language?.trim()) schema.inLanguage = input.language.trim();
  return schema;
}

/** Everything the article should carry: the posting, and the FAQ when the switch is on and the body has one. */
export function structuredDataFor(html: string, posting: BlogPostingInput, faqEnabled: boolean): Array<BlogPostingSchema | FaqSchema> {
  const out: Array<BlogPostingSchema | FaqSchema> = [blogPostingSchema(posting)];
  if (faqEnabled) {
    const { schema } = buildFaqSchema(html);
    if (schema) out.push(schema);
  }
  return out;
}

/** One script tag per schema. `</` is escaped so a question containing "</script>" cannot end the tag early. */
export function jsonLdScript(schema: object): string {
  const json = JSON.stringify(schema).replace(/<\//g, "<\\/");
  return `<script type="application/ld+json" ${SCHEMA_MARKER}>${json}</script>`;
}

/** Append the tags to the body, once: a retry of a publish that already carried them adds nothing. */
export function appendJsonLd(html: string, schemas: object[]): string {
  if (schemas.length === 0 || html.includes(SCHEMA_MARKER)) return html;
  return `${html}\n${schemas.map(jsonLdScript).join("\n")}`;
}
