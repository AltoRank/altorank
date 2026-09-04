---
title: "SEO Health Check: The Agency Audit Checklist"
slug: "seo-health-checker"
description: "A repeatable SEO health check: crawl, indexation, structure and AI-readiness, in problem-finding order."
category: "technical"
heroHeadline: "Know exactly what is holding a page back."
heroSubhead: "Most SEO health checks return a long list of warnings and no decision. This is the shorter checklist we run, ordered so the problems that actually block ranking surface first."
useCases:
  - "Run a consistent health check across every client site"
  - "Separate real blockers from cosmetic warnings"
  - "Catch indexation problems before they cost a quarter"
  - "Check whether a site is readable by AI crawlers, not just Google"
relatedTools:
  - "serp-analyzer"
  - "keyword-cluster-mapper"
published: true
datePublished: 2026-08-22
dateModified: 2026-08-22
steps:
  - name: "Confirm the page can be crawled"
    text: "Check robots.txt does not block the path, and that the page returns a 200 rather than a redirect chain or a soft 404. Nothing below this matters if the crawler cannot reach the page."
  - name: "Confirm the page can be indexed"
    text: "Look for a noindex meta tag or X-Robots-Tag header, and check the canonical points at the page itself rather than somewhere else. A crawlable page that says noindex is invisible, and this is the single most common silent failure."
  - name: "Check the sitemap and the robots meta agree"
    text: "A URL listed in the sitemap but carrying noindex sends contradictory instructions. Reconcile them so both say the same thing."
  - name: "Check the on-page structure"
    text: "One H1, a heading order with no skipped levels, a title under about 60 characters, and a meta description that describes the page. These are cheap to fix and they compound."
  - name: "Check structured data and entity signals"
    text: "Validate the JSON-LD parses, that it matches the visible content, and that Organization schema carries a populated sameAs. Schema contradicting the page is worse than no schema."
  - name: "Check AI crawler access"
    text: "Confirm robots.txt does not block GPTBot, PerplexityBot, ClaudeBot, or Google-Extended unless that is a deliberate policy choice. Being invisible to answer engines is now its own failure mode."
faq:
  - question: "What is an SEO health check?"
    answer: "An SEO health check is a structured pass over a site to find the technical and structural problems that stop pages ranking. A useful one is ordered by consequence, starting with whether the page can be crawled and indexed at all, rather than returning an undifferentiated list of warnings."
  - question: "What should a website SEO health check cover first?"
    answer: "Crawlability and indexability, in that order. A page blocked in robots.txt or carrying a noindex tag cannot rank no matter how good the content is, so every other check is wasted effort until those two pass."
  - question: "What is the most common silent SEO failure?"
    answer: "A noindex tag left on a page after a staging deploy, or a canonical tag pointing at the wrong URL. Both fail quietly: the page renders perfectly for a human visitor and simply never appears in search results."
  - question: "Do I need a paid tool to run an SEO health check?"
    answer: "No. The checks that find most real blockers can be done with a browser, a view-source, and Google Search Console. Paid crawlers add speed and scale across large sites, which matters when you are auditing many client domains, but they are not required to find the problems that matter most."
  - question: "How often should agencies run a health check on client sites?"
    answer: "Quarterly for stable sites, and immediately after any CMS migration, theme change, or template edit. Migrations are when indexation problems are introduced, and they fail open: the site looks fine to everyone except the crawler."
---

Most SEO health checks produce a report with two hundred warnings, of which four matter. The useful version is ordered by consequence: check the things that make a page invisible before you check the things that make it slightly less good.

## Order the checks by consequence

The sequence matters more than the checklist. Work down, and stop treating anything lower as urgent until everything above it passes.

1. **Can the crawler reach it?** robots.txt, redirect chains, server errors.
2. **Can it be indexed?** noindex meta, X-Robots-Tag header, canonical target.
3. **Do the signals agree?** Sitemap membership versus robots meta.
4. **Is the structure sound?** Headings, title, description.
5. **Are the entity signals clean?** Structured data, sameAs, schema matching the page.
6. **Can answer engines read it?** AI crawler access.

Items 1 and 2 are binary and they are where the expensive failures live. A page with a stray noindex is not a page that ranks badly. It is a page that does not exist as far as search is concerned, and it looks completely normal to every human who visits it.

## The checks that find real problems

**Contradictory indexation signals.** A URL in your sitemap that also carries a noindex tag is telling Google to crawl something you then tell it to drop. This happens constantly after a site restructure, and neither signal is wrong on its own, so no single-purpose tool flags it.

**Canonical pointing elsewhere.** A canonical tag is a strong hint that the real version of this page lives at another URL. Pointed wrongly, it hands your page's relevance to a different one. Check that the canonical on a page resolves to that same page unless you deliberately intend otherwise.

**Heading levels that skip.** An H2 followed by an H4 breaks the document outline that both screen readers and extraction pipelines use to understand structure. It is trivial to fix and it improves how cleanly your content can be quoted.

**Schema that contradicts the page.** Structured data claiming a price, a rating, or an organisation name that does not appear in the rendered content is worse than shipping no schema at all. Validate that it parses, then read it against the page.

**AI crawler blocks.** Many robots.txt files still block or omit GPTBot, PerplexityBot, and ClaudeBot by inheritance from an old template. If a client wants to be visible in AI answers, that file is the first gate, and it is frequently closed by accident rather than by decision.

## The scoring sheet

Record one row per page so results are comparable across audits and across clients:

`URL | Crawlable | Indexable | Sitemap agrees | H1 count | Heading skips | Schema valid | sameAs present | AI crawlers allowed | Blocker?`

The `Blocker?` column collapses everything into the only field a client cares about: is this page capable of ranking right now, yes or no. Keep the detail for your own remediation queue.

## Doing this across a client roster

Running this on one site is an afternoon. Running it across twenty client domains every quarter, then tracking which findings were actually fixed, is the part that does not scale by hand. That is what AltoRank automates: crawl, check, generate what is missing, and publish behind an approval gate so nothing changes on a client site without a human saying yes. See the [alternatives comparisons](/alternatives) for how it compares, or read [how to read a SERP](/tools/serp-analyzer) if your problem is keyword selection rather than technical health.
