import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishDate: z.coerce.date(),
    // Set only when a post is genuinely revised. Drives the visible "Updated"
    // line, Article dateModified, and sitemap lastmod, so it must reflect real
    // edits rather than being bumped to manufacture freshness.
    dateModified: z.coerce.date().optional(),
    author: z.string(),
    category: z.enum(['seo', 'content', 'agencies', 'case-study', 'product']),
    tags: z.array(z.string()).default([]),
    ogImage: z.string().optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    faq: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })).optional(),
  }),
});

const tools = defineCollection({
  loader: glob({ base: './src/content/tools', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    category: z.enum(['keyword', 'content', 'technical', 'analytics']),
    heroHeadline: z.string(),
    heroSubhead: z.string(),
    useCases: z.array(z.string()),
    relatedTools: z.array(z.string()).default([]),
    // Gates indexation. A tool page is noindex'd (and kept out of the sitemap,
    // see astro.config.ts) until its content is a genuinely useful guide, not a
    // thin stub. Flip to true only when the page earns it.
    published: z.boolean().default(false),
    datePublished: z.coerce.date().optional(),
    dateModified: z.coerce.date().optional(),
    // Optional ordered steps. When present, the page emits HowTo schema and can
    // render the method as a numbered walkthrough.
    steps: z.array(z.object({
      name: z.string(),
      text: z.string(),
    })).optional(),
    faq: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })).optional(),
  }),
});

const successStories = defineCollection({
  loader: glob({ base: './src/content/success-stories', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    company: z.string(),
    slug: z.string(),
    industry: z.string(),
    description: z.string(),
    results: z.object({
      trafficGrowth: z.string(),
      timeToFirstRank: z.string(),
      articlesPublished: z.string().optional(),
      backlinksGained: z.string().optional(),
    }),
    publishDate: z.coerce.date(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog, tools, 'success-stories': successStories };
