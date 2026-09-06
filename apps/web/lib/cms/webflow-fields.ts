// ---------------------------------------------------------------------------
// Webflow field mapping: which collection field gets which part of an article
// ---------------------------------------------------------------------------
//
// A Webflow collection has whatever fields its designer gave it. The adapter
// used to assume four slugs (name, slug, post-body, post-summary) - the ones
// Webflow's own blog template ships with - and any collection built by hand
// answered every publish with a 400. The connect dialog now reads the
// collection's fields and proposes a map; this module is the proposal, kept
// pure so it is tested without a token.
//
// Only the field *types* the Data API reports drive the choice; display names
// and slugs break ties. Anything unmatched stays unmapped and is not sent.

import type { WebflowFieldMap } from "@/lib/types";

/** Shape the picker works with: the subset of a Data API field it needs. */
export interface WebflowFieldLike {
  slug: string;
  displayName: string;
  type: string;
  isRequired?: boolean;
  isEditable?: boolean;
}

/** What every connection made before the picker existed still uses. */
export const DEFAULT_WEBFLOW_FIELD_MAP: WebflowFieldMap = {
  title: "name",
  slug: "slug",
  body: "post-body",
  summary: "post-summary",
};

export const WEBFLOW_MAP_ROLES = ["title", "slug", "body", "summary", "image"] as const;
export type WebflowMapRole = (typeof WEBFLOW_MAP_ROLES)[number];

/** Which Data API field types can hold each part of an article. */
export const WEBFLOW_ROLE_TYPES: Record<WebflowMapRole, readonly string[]> = {
  title: ["PlainText"],
  slug: ["PlainText"],
  body: ["RichText"],
  summary: ["PlainText"],
  image: ["Image"],
};

export const WEBFLOW_ROLE_LABELS: Record<WebflowMapRole, string> = {
  title: "Title",
  slug: "Slug",
  body: "Article body",
  summary: "Meta description",
  image: "Featured image",
};

const SLUG_HINTS: Record<WebflowMapRole, readonly string[]> = {
  title: ["name", "title"],
  slug: ["slug"],
  body: ["post-body", "body", "content", "article", "rich-text"],
  summary: ["post-summary", "summary", "excerpt", "meta-description", "description", "meta", "seo"],
  image: ["main-image", "featured-image", "thumbnail", "cover", "hero", "image"],
};

function hintRank(field: WebflowFieldLike, hints: readonly string[]): number {
  const hay = `${field.slug} ${field.displayName}`.toLowerCase();
  const i = hints.findIndex((h) => hay.includes(h));
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** The fields that could hold a role, best guess first. */
export function candidatesFor(role: WebflowMapRole, fields: WebflowFieldLike[]): WebflowFieldLike[] {
  return fields
    .filter((f) => WEBFLOW_ROLE_TYPES[role].includes(f.type) && f.isEditable !== false)
    .map((f, i) => ({ f, i, rank: hintRank(f, SLUG_HINTS[role]) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.f);
}

/**
 * Propose a map for a collection's fields.
 *
 * Title and slug are Webflow's two built-in required fields, so they always
 * resolve when the collection is a real one. Body needs a RichText field; a
 * collection without one cannot take an article and the result says so via
 * `missing`. Summary and image are optional and left out rather than guessed
 * when nothing plausible exists: an unmapped field is not sent, a wrongly
 * mapped one is a 400.
 */
export function suggestWebflowFieldMap(
  fields: WebflowFieldLike[],
): { map: WebflowFieldMap | null; missing: WebflowMapRole[] } {
  const used = new Set<string>();
  const pick = (role: WebflowMapRole): string | undefined => {
    const hit = candidatesFor(role, fields).find((f) => !used.has(f.slug));
    if (hit) used.add(hit.slug);
    return hit?.slug;
  };

  // Slug before title: both are PlainText, and "slug" has exactly one hint, so
  // claiming it first stops the title picker from taking it on a collection
  // whose name field is not literally called "name".
  const slug = pick("slug");
  const title = pick("title");
  const body = pick("body");
  const summary = pick("summary");
  const image = pick("image");

  const missing: WebflowMapRole[] = [];
  if (!title) missing.push("title");
  if (!slug) missing.push("slug");
  if (!body) missing.push("body");
  if (missing.length) return { map: null, missing };

  return {
    map: {
      title: title!,
      slug: slug!,
      body: body!,
      ...(summary ? { summary } : {}),
      ...(image ? { image } : {}),
    },
    missing,
  };
}

/**
 * A field map from what the dialog posted. Null when the required three are
 * not all present - the server then refuses rather than saving a connection
 * that would fail on first publish.
 */
export function parseWebflowFieldMap(raw: unknown): WebflowFieldMap | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
  const title = str("title");
  const slug = str("slug");
  const body = str("body");
  if (!title || !slug || !body) return null;
  const summary = str("summary");
  const image = str("image");
  return { title, slug, body, ...(summary ? { summary } : {}), ...(image ? { image } : {}) };
}

/** "Title → name · Slug → slug · …", for the dialog's confirmation line. */
export function describeWebflowFieldMap(map: WebflowFieldMap): string {
  return WEBFLOW_MAP_ROLES.filter((r) => map[r])
    .map((r) => `${WEBFLOW_ROLE_LABELS[r]} → ${map[r]}`)
    .join(" · ");
}
