// ---------------------------------------------------------------------------
// Shared helpers for AI providers
// ---------------------------------------------------------------------------

/**
 * Extract the H1 title and <meta-description> tag from generated HTML,
 * and return the cleaned HTML without the meta-description wrapper.
 */
export function extractArticleMeta(html: string): {
  title: string;
  metaDescription: string;
  cleanHtml: string;
} {
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
