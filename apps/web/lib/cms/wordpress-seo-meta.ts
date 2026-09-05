// ---------------------------------------------------------------------------
// SEO plugin fields on a WordPress post
// ---------------------------------------------------------------------------
//
// A WordPress post's title tag and meta description are not core fields: each
// SEO plugin keeps its own post meta and reads only that. So an article that
// arrives with a meta description and no plugin field gets whatever the plugin
// generates from the first paragraph, which is exactly the text we spent a
// generation step getting right.
//
// The four plugins that between them run most WordPress sites, and the keys
// each reads. Written blind - all four, every publish - because writing a meta
// key no plugin reads costs one harmless row, while detecting which plugin is
// installed costs a request and is wrong the day the customer switches.
//
// Shared by the REST adapter (which sends these as `meta` on wp/v2/posts) and
// mirrored in packages/wordpress-plugin/altorank/includes/api.php, which
// writes them with update_post_meta. Same keys; keep the two lists together.

export type SeoFields = {
  title: string;
  metaDescription?: string;
  focusKeyword?: string;
};

export const SEO_META_KEYS = {
  rankMath: {
    title: "rank_math_title",
    description: "rank_math_description",
    focusKeyword: "rank_math_focus_keyword",
  },
  yoast: {
    title: "_yoast_wpseo_title",
    description: "_yoast_wpseo_metadesc",
    focusKeyword: "_yoast_wpseo_focuskw",
  },
  seopress: {
    title: "_seopress_titles_title",
    description: "_seopress_titles_desc",
    focusKeyword: "_seopress_analysis_target_kw",
  },
  aioseo: {
    title: "_aioseo_title",
    description: "_aioseo_description",
    focusKeyword: "_aioseo_keyphrases",
  },
} as const;

/**
 * The post meta to write for an article. Empty values are left out rather than
 * written as "", because an empty Yoast title makes Yoast render an empty
 * <title>, whereas an absent one makes it fall back to the post title.
 */
export function seoPluginMeta(fields: SeoFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plugin of Object.values(SEO_META_KEYS)) {
    if (fields.title) out[plugin.title] = fields.title;
    if (fields.metaDescription) out[plugin.description] = fields.metaDescription;
    if (fields.focusKeyword) out[plugin.focusKeyword] = fields.focusKeyword;
  }
  return out;
}
