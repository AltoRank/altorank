export interface Industry {
  slug: string;
  name: string;
  headline: string;
  description: string;
  challenges: string[];
  benefits: string[];
  faq: { question: string; answer: string }[];
}

// Only e-commerce remains, the lead vertical per the resolved ICP (agencies
// broadly, e-commerce as the lead vertical). The 'saas' and 'agencies' entries
// were removed 2026-08-22: each rendered a templated page carrying only ~110-130
// words of unique copy, 'saas' is off-ICP entirely, and 'agencies' restated the
// homepage's own pitch. Both URLs now redirect, see public/_redirects.
export const INDUSTRIES: Industry[] = [
  {
    slug: 'ecommerce',
    name: 'E-commerce',
    headline: 'The SEO content engine built for Shopify, Magento & WooCommerce',
    description: 'E-commerce pages are under-represented in AI answers. Rank on Google and get cited, with buying guides and schema.',
    challenges: [
      'Scaling content across hundreds of product categories and collections',
      'Ranking for commercial-intent keywords against Amazon and marketplace listings',
      'Getting cited in AI search results: AI Overviews rarely surface store-owned pages',
      'Generating product page schema and structured data at scale',
      'Publishing consistently across Shopify, Magento, or WooCommerce without developer help',
    ],
    benefits: [
      'Automated buying guides and category content that rank for commercial intent',
      'Product page schema auto-generated for every product and collection',
      'Agent-readiness checks so assistants can actually read the site',
      'Native Shopify, Magento, and WooCommerce publishing, no copy-paste',
      'Voice profiles per brand so every store sounds authentic at scale',
    ],
    faq: [
      { question: 'Can AltoRank generate product descriptions?', answer: 'AltoRank focuses on SEO content: blog posts, buying guides, category pages, and product comparisons. For individual product descriptions, we recommend pairing AltoRank with a product-specific tool.' },
      { question: 'Does AltoRank work with Shopify?', answer: 'Yes. AltoRank publishes directly to Shopify blogs, generates product page schema, and optimizes collection page content. No developer or app install needed beyond the initial connection.' },
      { question: 'How does AltoRank help with AI search visibility?', answer: 'AltoRank structures content for LLM retrieval: entity coverage, answer-ready passages, and schema markup. It also checks whether an assistant can read the site at all, covering AI crawler rules, structured data, entity resolution and a machine-readable copy, and generates the missing pieces.' },
    ],
  },
];
