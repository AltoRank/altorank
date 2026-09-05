import {
  SITE_URL,
  APP_NAME,
  AUTHOR_NAME,
  AUTHOR_URL,
  OSS_REPO_PUBLIC,
  OSS_REPO_URL,
  OSS_LICENSE_URL,
} from '@/constants';

// The one logo file the schema points at. Was `/logo.png`, which has never
// existed in public/, so every page's Organization.logo 404'd. 512x512 PNG,
// above Google's 112px minimum for a publisher logo.
export const LOGO_URL = `${SITE_URL}/brand/altorank-icon.png`;

export function buildOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: APP_NAME,
    url: SITE_URL,
    logo: LOGO_URL,
    // Description kept consistent with the off-site profile boilerplate (LinkedIn,
    // Crunchbase, G2, …), cross-source consistency is what resolves the entity.
    // See memory/research/strategy/2026-06-21-entity-authority-asset-pack.md.
    // ICP CHANGED 2026-08-30 (Mike): the homepage no longer leads with agencies.
    // Reason: the 180-day $9k MRR target is unreachable from the 274-agency list
    // (~45 paying = 16% of every agency identified), and an agency-only site
    // strands the OSS distribution bet, which is top-line strategy. Agencies
    // remain a pricing tier and keep /for/agencies; they are not the lead.
    // This supersedes the 2026-08-15 "agencies broadly" resolution in
    // memory/hot-cache.md, which is now stale on this point.
    // Previously said "European e-commerce agencies", which contradicted the
    // homepage, PRODUCT.md, and branch ee08349. See memory/hot-cache.md.
    // Text last changed 2026-09-02 to match the one line in
    // altorank-notes/POSITIONING.md ("Articles that rank, published to your
    // site every week"). The previous text said "across every client brand",
    // which described an agency tool a month after agencies stopped being the
    // lead. Agencies are a tier; the entity description is for everyone.
    description:
      'AltoRank is an open-source AI SEO content engine: articles that rank, published to your site every week. It researches keywords, drafts in your voice, and publishes to eleven CMSs, and nothing goes live until a person approves it. Self-host it free, or use the hosted version. Built by SUPALABS SRL in Italy.',
    slogan: 'Articles that rank, published to your site every week.',
    areaServed: 'Europe',
    knowsAbout: [
      'Search engine optimization',
      'Generative engine optimization',
      'AI content',
      'Content marketing',
      'Open source software',
    ],
    // sameAs: AltoRank's verified off-site profiles, the entity-resolution signal.
    // Add each URL only once the profile is live (see the asset pack). Pending:
    // Crunchbase, G2, Capterra, Product Hunt, X.
    // The GitHub org is the single highest-value addition here (DR 97 source),
    // it lands automatically when OSS_REPO_PUBLIC flips.
    sameAs: [
      'https://www.linkedin.com/company/altorank',
      ...(OSS_REPO_PUBLIC ? [OSS_REPO_URL] : []),
    ],
    founder: { '@type': 'Person', name: AUTHOR_NAME, url: AUTHOR_URL },
  };
}

export function buildProductSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: APP_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: SITE_URL,
    description: 'The open-source, approval-first AI SEO content engine. Keyword research, drafting, and publishing to eleven CMSs, and self-hostable on your own infrastructure.',
    // Range spans the three rungs in @/data/pricing: €0 self-host, €69
    // managed, €199 agency. All euros since 2026-08-30.
    // Keep offerCount in sync with PLANS.length.
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'EUR',
      lowPrice: '0',
      highPrice: '199',
      offerCount: '3',
    },
    // Only emitted once the repo is genuinely public, asserting a license for
    // source nobody can obtain is the same class of claim as fabricated traction.
    ...(OSS_REPO_PUBLIC && {
      license: OSS_LICENSE_URL,
      isAccessibleForFree: true,
      codeRepository: OSS_REPO_URL,
    }),
  };
}

export function buildArticleSchema(post: {
  title: string;
  description: string;
  publishDate: Date;
  dateModified?: Date;
  author: string;
  authorType?: 'Person' | 'Organization';
  authorUrl?: string;
  url: string;
  image?: string;
  /** Blog posts are BlogPosting; case studies and other long-form stay Article. */
  type?: 'Article' | 'BlogPosting';
  tags?: string[];
  lang?: string;
}) {
  // dateModified is required by Google's article rich-result guidance and read
  // by every AI crawler as the freshness signal. A post that has never been
  // revised was last modified when it was published, so that date is the
  // honest default; the frontmatter field overrides it only for real edits.
  const modified = post.dateModified ?? post.publishDate;
  return {
    '@context': 'https://schema.org',
    '@type': post.type ?? 'Article',
    headline: post.title,
    description: post.description,
    datePublished: post.publishDate.toISOString(),
    dateModified: modified.toISOString(),
    inLanguage: post.lang ?? 'en',
    author: {
      '@type': post.authorType ?? 'Person',
      name: post.author,
      ...(post.authorType === 'Organization'
        ? { url: SITE_URL }
        : post.authorUrl
          ? { url: post.authorUrl, sameAs: [post.authorUrl] }
          : {}),
    },
    publisher: {
      '@type': 'Organization',
      name: APP_NAME,
      url: SITE_URL,
      logo: { '@type': 'ImageObject', url: LOGO_URL },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': post.url },
    ...(post.image && { image: post.image }),
    ...(post.tags && post.tags.length > 0 && { keywords: post.tags.join(', ') }),
  };
}

export function buildItemListSchema(items: Array<{ name: string; url?: string; description?: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.url && { url: item.url }),
      ...(item.description && { description: item.description }),
    })),
  };
}

export function buildFAQSchema(faq: { question: string; answer: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

export function buildHowToSchema(howto: {
  name: string;
  description: string;
  steps: { name: string; text: string }[];
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: howto.name,
    description: howto.description,
    step: howto.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  };
}

export function buildBreadcrumbSchema(crumbs: { label: string; href: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.label,
      item: crumb.href.startsWith('/') ? `${SITE_URL}${crumb.href}` : crumb.href,
    })),
  };
}

export function buildSoftwareAppSchema(tool: {
  name: string;
  description: string;
  url: string;
  category: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: tool.name,
    description: tool.description,
    url: tool.url,
    applicationCategory: tool.category,
    operatingSystem: 'Web',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };
}
