import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);

  const lastTouched = (p: (typeof posts)[number]) =>
    (p.data.dateModified ?? p.data.publishDate).valueOf();

  return rss({
    title: 'AltoRank Blog',
    description: 'SEO insights, content strategy, and agency growth, from the AltoRank team.',
    site: context.site!.toString(),
    // Readers and aggregators key on <language>; without it a feed of English
    // posts is untyped. lastBuildDate is the newest content date, not the build
    // time, so a redeploy with no new posts does not advertise a change.
    customData: [
      '<language>en-us</language>',
      `<lastBuildDate>${new Date(Math.max(...posts.map(lastTouched))).toUTCString()}</lastBuildDate>`,
    ].join(''),
    items: posts
      .sort((a, b) => lastTouched(b) - lastTouched(a) || a.id.localeCompare(b.id))
      .map((post) => ({
        title: post.data.title,
        pubDate: post.data.publishDate,
        description: post.data.description,
        link: `/blog/${post.id}/`,
        // Tags travel as <category>, which is how feed readers filter.
        categories: [post.data.category, ...post.data.tags],
        // RSS <author> is defined as an email address; a bare name is invalid
        // and a real address would be harvested, so it is omitted. The author
        // is in the page's BlogPosting schema, which is where it belongs.
      })),
  });
}
