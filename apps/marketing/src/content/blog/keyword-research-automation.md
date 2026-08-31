---
title: "Agency Keyword Research: A Workflow for Running It Across 10+ Clients"
description: "The agency keyword research workflow that scales: per-client keyword sets, AI prompt sets, opportunity scoring, and a monthly refresh cadence without burning the strategy team."
publishDate: 2026-05-24
author: "Mike Cecconello"
category: "seo"
tags: ["keyword research", "agency operations", "content strategy", "geo"]
featured: false
draft: false
faq:
  - question: "How is agency keyword research different from in-house SEO keyword research?"
    answer: "In-house teams optimize one keyword set for one domain. Agencies optimize 10–50 keyword sets across 10–50 domains, each with its own positioning, authority profile, and competitive landscape. The unit of work isn't a keyword list, it's a system that produces consistent keyword sets per client every month without the strategist becoming a bottleneck."
  - question: "Should agencies do keyword research monthly or quarterly?"
    answer: "Quarterly research treats the keyword set as a deliverable. Monthly research treats it as a backlog. The monthly cadence wins because SERPs shift, new competitors enter, and AI surfaces re-rank constantly. A quarterly refresh misses the inflection points where small wins compound. The catch: monthly only works if you've automated the data gathering. Manually rebuilding a 300-keyword set each month is not viable past three clients."
  - question: "What's the difference between keyword research and prompt set research?"
    answer: "A keyword is what someone types into Google. A prompt is what someone types into ChatGPT, Perplexity, or Claude: usually longer, more conversational, and shaped by context. Most agency clients in 2026 need both. The keyword set drives the SEO calendar; the prompt set drives the GEO (generative engine optimization) work. They overlap heavily but don't map one-to-one, and the agencies that ship visibility on AI surfaces treat the prompt set as a first-class artifact."
  - question: "Which keyword research tool is best for agencies?"
    answer: "There is no single best tool, there's a best stack for your client mix. Most agencies in 2026 use one or two heavy data tools (Ahrefs, Semrush, or DataForSEO) plus a workspace layer that holds the per-client keyword set, scoring logic, and monthly refresh. The data tool gives you raw volume and difficulty; the workspace turns it into a ranked, actionable backlog per client. Tools without the workspace layer leave the strategist doing CSV gymnastics."
  - question: "How do you score keyword opportunity for an agency client?"
    answer: "The standard formula multiplies search volume by relevance, divided by difficulty, then weighted by the client's commercial value. Variations exist, but the four inputs are non-negotiable: how big is the demand, how on-target is the topic, how hard is it to rank, and how much is a conversion worth. Agencies that skip the commercial-value weight end up chasing high-volume vanity keywords that don't move client revenue."
---

A single client's keyword research is a research problem. Ten clients' keyword research is a workflow problem. The unit of work an agency manages isn't a keyword list, it's a system that produces consistent, ranked, monthly keyword sets across the entire client portfolio without the head of strategy spending every Friday rebuilding spreadsheets.

This guide is the workflow. It assumes you already know how to run keyword research for one client and want to scale that craft into something repeatable.

## TL;DR

- Treat the per-client keyword set as a **backlog**, not a deliverable. Pull from the top, refresh from the bottom, on a monthly cadence.
- Score every opportunity on four axes (**volume, relevance, difficulty, commercial value**) and rank ruthlessly.
- Build a **prompt set** alongside the keyword set. AI visibility is a separate surface with overlapping but distinct queries.
- The strategist's job is editorial judgment over a ranked backlog. Data gathering is the dashboard's job.
- One strategist can hold 4–6 clients on this workflow comfortably. Without it, two is the practical ceiling.

## Why agency keyword research is its own discipline

In-house SEO teams optimize one keyword set for one domain. They go deep, months on a single content cluster, custom competitor maps, internal team alignment. Agencies don't get that luxury. The agency strategist holds five to ten clients in working memory, each with a different industry, authority profile, geography, and commercial model.

The agency-specific constraints:

- **Breadth across depth.** The strategist can't go as deep on any one cluster as an in-house team would. The system has to compensate.
- **Quality consistency across clients.** Client A's keyword set has to be as well-built as Client B's, even if Client A is the strategist's smallest account.
- **Recurring deliverable, not one-time research.** Most agency engagements are monthly retainers, which means the keyword work is a continuous artifact, not a quarterly project.
- **Cross-client pattern recognition.** When a tactic works on one client, the strategist should be able to surface it across the portfolio. That requires structured data, not narrative documents.

In-house research playbooks assume time the agency doesn't have. The agency playbook below is built around the constraints.

## Stage 1, Build the per-client baseline

The baseline is the structured starting point for every client. Built once during onboarding, refreshed quarterly. Without it, every monthly cycle restarts from zero.

A complete baseline contains:

- **Domain inventory**: every page currently on the client's domain, with its current ranking position, traffic, and intent classification (informational, commercial, transactional, navigational).
- **Competitor set**, 3–7 named competitors with overlapping SERPs. Not the client's brand-marketing competitors, the actual SERP competitors, which are often different.
- **Existing keyword footprint**, what the client currently ranks for, weighted by traffic.
- **Brand and entity coverage**, branded queries, branded variants, entity collisions (other companies/products that share the name).
- **Commercial value model**, how much is a conversion worth, broken down by intent type. Often the client's own funnel data, sometimes a default model the agency uses.

The mistake most agencies make is treating the baseline as a slide deck. It's not. It's a structured data set that gets queried every month. Build it in a database or a workspace, not a doc.

## Stage 2: Pull the opportunity pool

With the baseline in place, the monthly job becomes pulling a fresh opportunity pool, every keyword the client could realistically pursue, and scoring it.

### Where opportunities come from

- **Competitor gaps**, keywords competitors rank for that the client doesn't. The highest-leverage source.
- **Existing-content lift**, keywords the client ranks for in positions 4–20 that could move to 1–3 with on-page or topical work.
- **Topical clusters**, long-tail variants around the client's hero topics that fill out coverage.
- **Emerging queries**, newer search terms with rising volume that don't have entrenched winners yet.
- **Branded gaps**, high-intent branded queries the client doesn't own (e.g., review-style queries, comparison queries).

A useful opportunity pool typically lands at 200–500 keywords per client per month. Smaller than that and you're under-covering; larger and you're drowning the scoring layer.

### Tools at the data layer

Most agencies in 2026 pull this data from one or two of: [Ahrefs](https://ahrefs.com/), [Semrush](https://www.semrush.com/), [DataForSEO](https://dataforseo.com/), or a smaller specialist tool plugged into the agency's workspace. The choice matters less than the discipline of pulling consistently, the same sources, the same filters, the same competitor set, month over month. Inconsistent sourcing makes trend analysis impossible.

## Stage 3, Score and rank

Scoring is what turns 400 keywords into a ranked backlog the strategist can act on. The formula varies by agency, but the inputs are non-negotiable.

### The four inputs

1. **Volume**: monthly search volume, ideally with a 12-month trend so you can see whether it's growing or decaying.
2. **Relevance**, how closely the keyword maps to the client's offering. Score 0–10 against the positioning statement.
3. **Difficulty**, domain authority required to rank, given the current SERP. Most data tools provide a 0–100 score; calibrate against your own results because the [scoring methodology varies between providers](https://ahrefs.com/blog/keyword-difficulty/).
4. **Commercial value**: the dollar value of a conversion from this query, derived from intent type and the client's funnel data.

### A simple opportunity score

A workable formula:

```
opportunity = (volume × relevance × commercial_value) / difficulty
```

This is not a precise instrument, it's a sorting heuristic. Two keywords with identical opportunity scores will perform differently in practice. The point isn't to predict outcomes; it's to surface the right 20 keywords to spend the strategist's editorial attention on, instead of forcing them to evaluate all 400.

### Weighting against the client's authority

Don't score in isolation, score against the client's current domain authority and existing content. A KD-60 keyword is a fantasy target for a DR-20 site and a near-given for a DR-70 site. The same opportunity score should rank differently depending on who the client is.

This is the "where in the backlog" question. High-difficulty keywords go to the bottom for low-authority clients and get pulled forward as the client's authority climbs.

## Stage 4, Build the prompt set in parallel

If the agency is doing any GEO work, and by 2026 most should be, the keyword research workflow has a sibling: the prompt set.

### Why prompts are different from keywords

A keyword represents [intent in a search engine](https://developers.google.com/search/docs/fundamentals/seo-starter-guide). A prompt represents intent in an AI assistant. The differences:

- **Length.** Keywords are 1–5 words on average; prompts are often 10–30 words.
- **Context.** Searchers add context to prompts they wouldn't add to a search query ("I'm a 200-person agency looking for...").
- **Conversational shape.** Prompts often include the searcher's situation, constraints, or comparison frame.
- **Iteration.** Prompts often come in chains, the searcher refines based on the first answer.

A keyword like `crm for agencies` maps loosely to a prompt set that might include `what's the best CRM for a 50-person agency`, `I run a content agency: which CRM should I use`, and `compare HubSpot vs Pipedrive for an agency`. The keyword research won't surface these; only sales-team interviews and direct AI-search testing will.

### Building the prompt set

The reliable method: 30–60 minutes with the client's sales team, walking through the buyer's mental model. What do they ask when they first encounter a problem the client solves? What do they ask when they're evaluating vendors? What do they ask when they're ready to buy? Each phase produces 5–10 prompts.

Refresh quarterly. Run the set monthly against the major AI surfaces (ChatGPT, Perplexity, Gemini, Claude). Log citation outcomes. The set itself becomes part of the [PIN framework's Loop layer](/blog/how-to-rank-in-chatgpt), the input that feeds your AI visibility strategy.

### Where keyword sets and prompt sets converge

Most agency clients in 2026 need both, but the two artifacts feed different downstream workflows:

- Keyword set → SEO content calendar → blog and landing pages.
- Prompt set → GEO Network/Inventory work → citations, third-party mentions, schema reinforcement.

A single article can be designed to serve both, a strong blog post optimized for `agency keyword research workflow` (this post, in fact) also needs to surface in answers for `how should an agency run keyword research`. The brief covers both surfaces; the article serves both.

## Stage 5, The monthly cycle

With the system in place, the monthly cycle becomes mechanical. A working cadence for a mid-tier client:

- **Week 1**: pull the fresh opportunity pool, score, and rank. Run the prompt set against the AI surfaces. Update the citation log.
- **Week 2**, strategist reviews the top of the backlog and selects the month's content targets (typically 6–12 articles for a mid-market client). Build briefs.
- **Weeks 2–4**, writing and editing per [the agency content engine](/blog/seo-content-strategy-agencies).
- **End of month**, pull updated rankings on the keyword set, refresh the prompt set citations, prepare the monthly client review.

The strategist spends roughly two days per month per client on the keyword and prompt workflow itself. The rest is editorial judgment and client conversation. One strategist can hold 4–6 clients on this cadence; without the workflow, two is the practical ceiling.

## Stage 6, Make the data feed back

The loop closes when this month's outcomes inform next month's pulls.

- A keyword that ranked faster than the difficulty score predicted is a signal to pull more keywords in that cluster.
- A keyword that stalled after 90 days needs reassessment: was the brief wrong, was the SERP misread, or is the difficulty score miscalibrated?
- A prompt where the client lost AI citation share points to Network work, third-party mentions and PR pushes, not more articles.
- A competitor newly appearing in the gap analysis is a signal to harden the existing content before they outrank it.

This is the difference between an agency that compounds and an agency that stays flat. The compounding agency feeds outcomes back into inputs. The flat agency runs the same workflow every month and wonders why results aren't accelerating.

## When to consolidate the toolchain

Most agencies that hit this wall are running 5–7 tools and trying to glue them together with spreadsheets:

- One keyword data tool (Ahrefs or Semrush).
- One competitor tool (often the same).
- One ranking tracker.
- One brief generator.
- One content management workspace (Notion, Airtable, or similar).
- One AI writing tool.
- One CMS connector.

The integration tax is large. Every handoff loses fidelity. The pattern in 2026 has been consolidation: the agencies running the workflow above are moving to 2–3 tools that hold the per-client baseline, opportunity pool, prompt set, and production pipeline in one place. [AltoRank](/) is built for this consolidation, see the [comparison against existing tools](/alternatives/outrank) for the buyer's view.

The point isn't the specific tool. The point is that the workflow above is the artifact that matters; the toolchain should serve the workflow, not constrain it. If the agency is rebuilding spreadsheets every month, the toolchain has lost.

## What's next

This post sits inside the broader agency operating model:

- [The agency content engine (voice, inputs, production, measurement](/blog/seo-content-strategy-agencies)) where keyword research fits as Stage 2.
- [How to rank in ChatGPT, the PIN framework](/blog/how-to-rank-in-chatgpt), where the prompt set feeds AI visibility.
- [How to rank in Perplexity](/blog/how-to-rank-in-perplexity), where prompt-set tracking becomes most measurable.
- [Answer engine optimization, the multi-surface playbook](/blog/answer-engine-optimization), how the same prompt set extends across every AI surface.
- [Internal linking automation for agencies](/blog/internal-linking-seo), the production-side discipline that turns published articles into compounding traffic.

Keyword research is the input to the engine. Done at agency scale, it stops being a research deliverable and starts being a workflow asset: one that compounds across clients, surfaces patterns the strategist couldn't see manually, and frees editorial judgment for the parts of the job that actually require a human.
