// ---------------------------------------------------------------------------
// Shared helpers for AI providers
// ---------------------------------------------------------------------------

/**
 * Extract the H1 title and <meta-description> tag from generated HTML,
 * and return the cleaned HTML without the meta-description wrapper.
 */
/**
 * Strip a markdown code fence wrapping the whole response.
 *
 * Smaller models answer "write HTML" by handing back ```html ... ``` and the
 * fence used to survive into the stored article, so the published page opened
 * with a literal ```html. Observed from claude-haiku-4-5 on 2026-08-30; done
 * here rather than in the prompt because no instruction makes it impossible,
 * and every provider funnels through this function.
 */
function stripCodeFence(html: string): string {
  const trimmed = html.trim();
  if (!trimmed.startsWith("```")) return html;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/**
 * Unwrap links that go nowhere, keeping their text.
 *
 * The brief tells the model never to emit `href="#"`, and it does anyway: a
 * real run produced eight of them in one article. An instruction the model
 * follows most of the time is not a guarantee, and a dead link is worse than
 * plain text - it looks clickable, wastes a reader, and on a published page it
 * is an internal 404 for a crawler.
 *
 * Deterministic, so it does not depend on the model having a good day.
 *
 * `placeholders` also unwraps `{{internal-link:…}}` hrefs. Off by default
 * because this runs on the raw model output, before the resolver has had its
 * turn; the resolver switches it on for whatever it could not resolve.
 */
export function stripDeadLinks(
  html: string,
  opts: { placeholders?: boolean } = {},
): string {
  const dead = opts.placeholders
    ? /<a\b[^>]*href=["'](?:#|javascript:void\(0\)|\{\{internal-link:[^}]*\}\}|)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /<a\b[^>]*href=["'](?:#|javascript:void\(0\)|)["'][^>]*>([\s\S]*?)<\/a>/gi;
  return html.replace(dead, "$1");
}

export function extractArticleMeta(rawHtml: string): {
  title: string;
  metaDescription: string;
  cleanHtml: string;
} {
  const html = stripDeadLinks(stripCodeFence(rawHtml));

  // Extract title from <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? stripTags(h1Match[1]).trim() : "Untitled";

  // Extract meta-description
  const metaMatch = html.match(
    /<meta-description>([\s\S]*?)<\/meta-description>/i
  );
  const metaDescription = metaMatch ? metaMatch[1].trim() : "";

  // Remove the meta-description tag from the HTML
  const cleanHtml = html
    .replace(/<meta-description>[\s\S]*?<\/meta-description>/i, "")
    .trim();

  return { title, metaDescription, cleanHtml };
}

/**
 * Count words in an HTML string by stripping tags first.
 */
export function countWords(html: string): number {
  const text = stripTags(html);
  const words = text
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return words.length;
}

/**
 * Strip HTML tags from a string.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Remove the typography that reads as machine-written.
 *
 * The prompt already bans slop phrasing, but character-level style does not
 * survive on instructions alone: the first e2e draft used an em dash in
 * roughly every third sentence with the ban in the prompt. Post-processing is
 * deterministic, so the rule actually holds.
 *
 * Ranges between digits become an en dash (that is typography, not slop);
 * every other em dash becomes a comma or, after a list-item label, a colon.
 */
export function stripAiTypography(html: string): string {
  return (
    html
      // 2019—2024, 9—17: a range, keep it as an en dash.
      .replace(/(\d)\s*—\s*(\d)/g, "$1–$2")
      // <li><strong>Setmore</strong> — free for… : the dash is a label
      // separator and a colon is what a person writes there.
      .replace(/(<\/(?:strong|b)>)\s*—\s*/g, "$1: ")
      // Everything else: clause glue. A comma is the honest replacement; a
      // dash that a comma cannot replace is a sentence that needs rewriting,
      // which a post-processor cannot do, so comma is the floor.
      .replace(/\s*—\s*/g, ", ")
      // Double hyphens used as a dash.
      .replace(/(\w)\s*--\s*(\w)/g, "$1, $2")
      // Artifacts: ", ," or ",," from dashes that sat beside punctuation.
      .replace(/,\s*,/g, ",")
  );
}
