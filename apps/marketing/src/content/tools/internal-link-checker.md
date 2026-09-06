---
title: "Free Internal Link Checker: Audit Anchors on Any Page"
slug: "internal-link-checker"
description: "Paste a page's HTML and get every internal link with its anchor text, flagged for generic anchors, repeated targets, image links with no alt and links to itself."
category: "technical"
heroHeadline: "Internal link checker: every link on the page, and what its anchor says."
heroSubhead: "Paste the HTML of a page and see its internal links in order, with the anchors that waste the link flagged. Nothing is fetched; the page never leaves your browser."
widget: "internal-links"
useCases:
  - "Find 'click here' and 'read more' anchors before a page publishes"
  - "Spot the same anchor text pointing at two different pages"
  - "Check that a new article links up to its pillar and across to its siblings"
  - "Catch image links with no alt text, which are links with no anchor at all"
relatedTools:
  - "seo-health-checker"
  - "slug-generator"
  - "schema-generator"
  - "keyword-cluster-mapper"
published: true
datePublished: 2026-09-05
dateModified: 2026-09-05
steps:
  - name: "Get the page's HTML"
    text: "View source in your browser, select all, copy. If the page is still a draft, paste the body HTML from the editor instead. The tool needs the markup, not the rendered text, because the anchors and hrefs live in the markup."
  - name: "Set the page URL"
    text: "The URL decides two things: how relative links such as /pricing resolve, and which links count as internal. Anything on the same host is internal; everything else is counted and set aside."
  - name: "Read the flags before the counts"
    text: "A generic anchor, an image link with no alt, a link to the page itself, and one anchor text used for two different targets are each a small loss. The counts tell you how many links there are; the flags tell you which ones are doing no work."
  - name: "Fix the anchors, not the number"
    text: "A page does not need more internal links, it needs anchors that say where they go. Rewrite 'click here' as the subject of the destination page, and give two links to the same target the same or compatible wording."
  - name: "Check the links in, not just out"
    text: "This tool reads one page. The links that matter most for a new article are the ones pointing at it from older pages, and those live elsewhere. Add the new page to the anchor list of its pillar and at least two siblings."
faq:
  - question: "What is an internal link checker?"
    answer: "A tool that lists the links from one page to other pages on the same site, with the anchor text on each, so you can see what the page connects to and how it describes those connections. This one runs on pasted HTML in your browser and does not crawl anything."
  - question: "Why does anchor text matter for internal links?"
    answer: "The anchor is the one description a crawler gets of the page behind the link, and it is also what a reader uses to decide whether to click. 'Click here' gives both of them nothing. An anchor that names the destination's subject passes relevance and earns the click."
  - question: "Is it bad to link to the same page twice?"
    answer: "Usually not. Two links to the same target with different, accurate anchors is normal on a long page. What causes trouble is the reverse: one anchor text used for two different targets, which tells a crawler two pages are about the same thing."
  - question: "How many internal links should a page have?"
    answer: "As many as the page has genuine reasons to reference, and no more. A count target produces padding. The useful questions are whether the page links up to its topic's pillar, across to its siblings, and whether older pages link back to it."
  - question: "Does this tool check for broken internal links?"
    answer: "No. It reads the HTML you paste and does not make requests, so it cannot know whether a target returns 200 or 404. It tells you what the page links to and how; a crawler tells you whether those targets still exist."
---

Most internal linking advice is about quantity: link more, link from every new post, build the hub. The quantity is rarely the problem. The problem is that the links that exist are wearing anchors that say nothing, so a page with twelve internal links gives a crawler twelve chances to learn what its neighbours are about and takes none of them.

The tool above reads one page's HTML and lists what it links to, in order, with the anchor text on each link. It flags the patterns that waste a link, and it does so without fetching anything, so it works on drafts as well as live pages.

## What the flags mean

**Generic anchor.** "Click here", "read more", "learn more", "this article". The link works; the anchor tells nobody where it goes. Rewrite it as the subject of the destination page, in the words that page uses for itself.

**Image link, no alt.** An image wrapped in a link, with no alt text, is a link with no anchor at all. The alt text is the anchor for an image link. Write one that describes the destination, not the picture.

**Same anchor, different target.** Two links whose anchor text is identical but which point at different pages. This is the one that actively confuses: a crawler reads two pages described by the same words and has to guess which one the words belong to. Split the wording.

**Links to itself.** A page linking to its own URL, usually from a template or a copied block. Harmless to readers, useless to everyone, and a sign the template needs a look.

**Target linked N times.** Informational, not a fault. A long page can reasonably link to its pillar twice. It becomes a fault only when the repeats carry generic anchors, in which case the first flag already caught it.

## What this tool cannot see

It reads one page, outbound. For a new article the more important question is inbound: which older pages link to it, and with what anchor. That lives on those pages, and the fix is editorial, not technical: add the new page to the pillar's link list and to two or three siblings, with anchors that name its subject.

It also does not follow the links. A target that has since been deleted looks identical to one that returns 200. Pair it with a crawl for status codes; use this for the anchors, which no crawler judges.

## Across a client roster

On one page this takes a minute. Across thirty client sites publishing weekly, it is a standing task: every new article needs anchors out to the right siblings and anchors in from the pages that already rank. That recurring pass is part of what AltoRank runs on every draft before a human approves it, and the approval screen shows the internal links it proposes so the person can change the anchor before anything publishes.
