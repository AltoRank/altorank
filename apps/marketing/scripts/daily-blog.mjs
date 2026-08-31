#!/usr/bin/env node
// Daily blog post generator. Pops one pre-researched keyword from
// data/blog-queue.json, calls Claude Sonnet 4.6 to draft the article, runs
// hard audit gates, and writes the result to src/content/blog/<slug>.md
// with draft: true. The GitHub Actions workflow at .github/workflows/
// daily-blog.yml schedules this; a successful run commits + pushes,
// triggering the Cloudflare Pages auto-deploy.
//
// Editorial control: posts ship with draft: true by default. Mike reviews,
// edits if needed, then flips to draft: false to publish. To switch to
// veto-by-default auto-publish, change DRAFT_DEFAULT below to false.
//
// Required env vars:
//   ANTHROPIC_API_KEY  — repo secret, set in GitHub Settings → Secrets
//
// Local dry-run:
//   ANTHROPIC_API_KEY=sk-... node scripts/daily-blog.mjs --dry-run
//
// Force a specific slug (skips queue pop):
//   ANTHROPIC_API_KEY=sk-... node scripts/daily-blog.mjs --slug=<slug>

import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const QUEUE_PATH = resolve(ROOT, 'data', 'blog-queue.json');
const BLOG_DIR = resolve(ROOT, 'src', 'content', 'blog');

const DRAFT_DEFAULT = true;

// This script cannot import apps/web's lib/ai/models.ts: it is a standalone
// build-time .mjs in the Astro app, and the two apps share no package. Until
// the generator is extracted into packages/core (see the port plan), this is a
// deliberate second copy, kept honest by reading the same env var name so a
// deployment that pins a model pins it in both places.
const MODEL = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5';
const MAX_TOKENS = 8192;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DRY_RUN = !!args['dry-run'];
const FORCE_SLUG = args['slug'];

// ── Pick keyword ─────────────────────────────────────
const queueRaw = await readFile(QUEUE_PATH, 'utf8');
const queueData = JSON.parse(queueRaw);

let entry;
let remainingQueue;
if (FORCE_SLUG) {
  entry = queueData.queue.find((e) => e.slug === FORCE_SLUG);
  if (!entry) throw new Error(`Slug not in queue: ${FORCE_SLUG}`);
  remainingQueue = queueData.queue;
} else {
  if (!queueData.queue.length) {
    console.log('Queue is empty. Refill data/blog-queue.json with aaron-flow keyword research.');
    process.exit(0);
  }
  [entry, ...remainingQueue] = queueData.queue;
}

// Skip if the post already exists (idempotency on re-runs).
// The blog collection accepts both .md and .mdx, so both extensions have to be
// checked. Testing only .md meant an existing .mdx post was invisible here and
// the generator would write a second article targeting the same keyword: exactly
// the cannibalisation this pipeline is supposed to avoid. `how-to-rank-in-chatgpt`
// is live as .mdx and is still queued, so this was reachable, not hypothetical.
const targetPath = resolve(BLOG_DIR, `${entry.slug}.md`);
const existingPath = await (async () => {
  for (const candidate of [targetPath, resolve(BLOG_DIR, `${entry.slug}.mdx`)]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
})();

if (existingPath) {
  console.log(`Post already exists at ${existingPath} — popping from queue without regen.`);
  if (!DRY_RUN && !FORCE_SLUG) {
    await writeFile(QUEUE_PATH, JSON.stringify({ ...queueData, queue: remainingQueue }, null, 2) + '\n');
  }
  process.exit(0);
}

console.log(`Generating ${entry.slug} (target ${entry.target_word_count}w, KD-area "${entry.intent}")`);

// ── Prompt construction ──────────────────────────────
const systemPrompt = `You are writing a long-form SEO article for AltoRank, an agency-focused SEO content engine.

Voice and tone (must follow):
- Warm but sharp. Direct. Has opinions.
- No marketing fluff. No filler phrases like "In today's digital landscape", "Let's dive into", "It's worth noting that", "basically", "essentially".
- Fragment sentences are fine. Active voice. Trust the reader.
- Honest about anti-personas — say when a competitor wins for a specific use case rather than strawmanning every alternative.

Hard rules (the build will reject the article if you break these):
- Do NOT use the phrases "430+ agencies", "180,000 articles", "180k articles", "12k backlinks", "12,000 backlinks" — these are aspirational stats from PRODUCT.md and the site has been explicitly scrubbed of them.
- Do NOT invent customer names, case studies, or specific traffic-growth numbers. AltoRank is pre-launch.
- Do NOT claim AltoRank ranks #1 at anything or has any specific customer count.
- Cite competitors by name with at least one outbound link suggestion per major competitor section ([linktext](https://competitor.com)).
- Include an FAQ section with 4-6 question/answer pairs at the end.
- Include a TL;DR or comparison table near the top.

Article structure required:
1. H1 — uses the primary keyword naturally.
2. Opening paragraph (4 sentences max) that fully answers the search intent — Google's AI Overview will lift this verbatim.
3. Honest framing of when this article is NOT for the reader (signal of editorial integrity).
4. Comparison table OR TL;DR list immediately under the hero.
5. 5-9 H2 sections that map to evaluation criteria, tool reviews, or pillar subtopics.
6. Decision matrix or "which tool / approach for which agency type" near the end.
7. FAQ section with 4-6 entries.
8. Closing CTA paragraph linking to /pricing (markdown link).

Markdown formatting:
- Use standard markdown. No HTML except where needed for tables.
- Do NOT include any YAML frontmatter — the script adds it.
- Use **bold** sparingly, only for genuinely emphatic terms.
- Use tables for comparisons. Use ordered lists for procedural steps. Use unordered lists for parallel attributes.

AltoRank pricing (use these exact figures, do not invent):
- Self-host €0 — AGPL-3.0, your infrastructure, your API keys, no feature gates
- Managed €69/mo — 100 articles/mo included, model costs included
- Agency €199/mo — 400 articles/mo included, white-label reports, role-based permissions

AltoRank differentiators (use these, do not invent others):
- Open source under AGPL-3.0 — everything ships open, no paid tier held back
- White-label included from the €199 Agency tier, not gated behind a premium tier
- Per-client voice profile training from 3-5 sample articles per client
- 12+ CMS integrations (WordPress, Webflow, Shopify, Ghost, Framer, Wix, Notion, HubSpot, Magento, WooCommerce, webhook, HTML)
- Referral traffic exchange, opt-in (credit-based, DR-weighted, many-to-many). Describe it as a REFERRAL/TRAFFIC network, never as a link-equity or backlink-building network.
- Content decay detection — flags aging articles, auto-drafts refreshes
- Real-time rank tracking via DataForSEO
- Editorial approval workflow (Owner / Admin / Editor permissions) — nothing publishes unreviewed

Do not invent customer logos or case-study figures. Cite competitors honestly.`;

const userPrompt = `Write an article targeting the primary keyword "${entry.primary_keyword}".

Slug: ${entry.slug}
Title (final): ${entry.title}
Secondary keywords to weave in naturally: ${entry.secondary_keywords.join(', ')}
Target word count: ${entry.target_word_count} (±20% acceptable, will be audited)
Editorial intent: ${entry.intent}
Wedge / unique angle: ${entry.wedge}

Competitors to cover honestly (do not strawman):
${entry.competitors_to_cover.map((c) => `- ${c}`).join('\n')}

SERP context (from real brightdata pull):
${entry.serp_notes}

Format: pure markdown article body, ready to drop under the frontmatter. Do not include the H1 separately — render it as the first markdown heading. Do not include any YAML.`;

if (DRY_RUN) {
  console.log('--- DRY RUN — would call Claude with:');
  console.log('System prompt length:', systemPrompt.length);
  console.log('User prompt:', userPrompt.slice(0, 500), '...');
  process.exit(0);
}

// ── Call Claude ──────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in GitHub repo Settings → Secrets, or pass it locally.');
  process.exit(1);
}

const resp = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }),
});

if (!resp.ok) {
  const errText = await resp.text();
  throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
}

const result = await resp.json();
const articleBody = result.content?.[0]?.text;
if (!articleBody) {
  throw new Error('No content returned from Claude');
}

console.log(`Drafted ${articleBody.split(/\s+/).length} words; running audit gates…`);

// ── Audit gates — reject thin or aspirational output ──
const audit = runAudit(articleBody, entry);
if (!audit.passed) {
  console.error('AUDIT FAILED — not committing:\n' + audit.failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(2);
}
console.log('Audit passed:\n' + audit.checks.map((c) => `  ✓ ${c}`).join('\n'));

// ── Build frontmatter + write file ───────────────────
const today = new Date();
const yyyymmdd = today.toISOString().slice(0, 10);
const description = extractDescription(articleBody, entry);

const frontmatter = `---
title: "${entry.title.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
publishDate: ${yyyymmdd}
author: "AltoRank Team"
category: "${entry.category}"
tags: [${entry.tags.map((t) => `"${t}"`).join(', ')}]
featured: false
draft: ${DRAFT_DEFAULT}
---

`;

const finalContent = frontmatter + articleBody.trim() + '\n';

await writeFile(targetPath, finalContent);
console.log(`✓ Wrote ${targetPath} (draft: ${DRAFT_DEFAULT})`);

// Pop the consumed entry from the queue
if (!FORCE_SLUG) {
  await writeFile(QUEUE_PATH, JSON.stringify({ ...queueData, queue: remainingQueue }, null, 2) + '\n');
  console.log(`✓ Popped ${entry.slug} from queue (${remainingQueue.length} remaining)`);
}

// ── Helpers ──────────────────────────────────────────

function runAudit(body, entry) {
  const checks = [];
  const failures = [];

  const words = body.split(/\s+/).length;
  const minWords = Math.round(entry.target_word_count * 0.7);
  const maxWords = Math.round(entry.target_word_count * 1.3);
  if (words < minWords) failures.push(`Word count ${words} below floor ${minWords}`);
  else if (words > maxWords) failures.push(`Word count ${words} above ceiling ${maxWords}`);
  else checks.push(`Word count ${words} within [${minWords}, ${maxWords}]`);

  const h1Count = (body.match(/^# [^#]/gm) || []).length;
  if (h1Count !== 1) failures.push(`Expected 1 H1, found ${h1Count}`);
  else checks.push('Exactly 1 H1');

  const h2Count = (body.match(/^## [^#]/gm) || []).length;
  if (h2Count < 4) failures.push(`Expected ≥4 H2 sections, found ${h2Count}`);
  else checks.push(`${h2Count} H2 sections`);

  const hasFAQ = /^##\s+(faq|frequently)/im.test(body);
  if (!hasFAQ) failures.push('Missing FAQ section (## FAQ or ## Frequently Asked Questions)');
  else checks.push('FAQ section present');

  const hasTable = /\|.*\|.*\|/.test(body);
  if (!hasTable) failures.push('Missing comparison table (no markdown table found)');
  else checks.push('Comparison table present');

  // Hard anti-pattern keyword filter — reject if any appear
  const banned = [
    /430\+\s*agencies/i,
    /180[,\s]?000\s*articles/i,
    /180k\s*articles/i,
    /12[,\s]?000\s*backlinks/i,
    /12k\s*backlinks/i,
    /in today's digital landscape/i,
    /let's dive into/i,
    /it's worth noting that/i,
    /in this article, we will/i,
  ];
  for (const re of banned) {
    if (re.test(body)) failures.push(`Banned phrase matched: ${re.source}`);
  }
  if (!failures.some((f) => f.startsWith('Banned'))) checks.push('No banned phrases');

  // Primary keyword must appear in first 200 words
  const firstWords = body.split(/\s+/).slice(0, 200).join(' ');
  if (!firstWords.toLowerCase().includes(entry.primary_keyword.toLowerCase())) {
    failures.push(`Primary keyword "${entry.primary_keyword}" missing from first 200 words`);
  } else checks.push('Primary keyword in opening 200 words');

  return { passed: failures.length === 0, failures, checks };
}

function extractDescription(body, entry) {
  // Use the first non-heading paragraph as the meta description (≤ 160 chars).
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (l.startsWith('#') || l.startsWith('|') || l.startsWith('-')) continue;
    const text = l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '');
    if (text.length > 60) {
      return text.length > 158 ? text.slice(0, 155).trim() + '…' : text;
    }
  }
  // Fallback to keyword-driven description
  return `${entry.title} — agency-fit criteria, real comparisons, no marketing fluff.`;
}
