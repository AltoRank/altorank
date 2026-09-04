---
title: "JSON-LD Schema: Describe the Page, Do Not Dress It Up"
slug: "schema-generator"
description: "Generate valid Article, FAQPage and BreadcrumbList JSON-LD, and the one rule that keeps it from backfiring."
category: "technical"
heroHeadline: "Structured data, generated and valid."
heroSubhead: "Article, FAQPage and BreadcrumbList JSON-LD you can paste straight into your head. Schema describes what a page already says — the moment it describes something else, it is a liability."
widget: "schema-generator"
useCases:
  - "Add Article schema to a blog post with a real author"
  - "Mark up an FAQ block that already exists on the page"
  - "Emit breadcrumbs that match your actual URL hierarchy"
  - "Hand a developer valid JSON-LD instead of a description of it"
relatedTools:
  - "robots-txt-generator"
  - "seo-health-checker"
  - "meta-description-generator"
published: true
datePublished: 2026-09-04
dateModified: 2026-09-04
steps:
  - name: "Only mark up what is on the page"
    text: "This is the rule that matters. Structured data describing content a visitor cannot see is against Google's guidelines and is the single most common cause of a structured-data manual action. If the FAQ is not rendered, it does not get FAQPage markup."
  - name: "Name a real author"
    text: "A Person with a name and a URL that resolves to a real profile is worth considerably more than an Organization byline, both for E-E-A-T and for an assistant deciding whether a claim has a source. A fabricated author is worse than none."
  - name: "Keep dates honest"
    text: "dateModified should change when the content changes, not on every deploy. Bumping it without editing anything is a signal you are training search engines to ignore."
  - name: "Validate before you ship"
    text: "Paste the output into Google's Rich Results Test and Schema.org's validator. They disagree occasionally, and where they do, Google's is the one that governs what appears in Google."
  - name: "Put it in the head, once"
    text: "One block per type per page. Duplicate Organization or Article nodes on the same page are a common source of confusing validator output, usually because a plugin is already emitting one."
faq:
  - question: "Does schema markup improve rankings?"
    answer: "Not directly. Google has been consistent that structured data is not a ranking factor. What it does is make a page eligible for rich results and easier for a machine to parse, which affects click-through and citation rather than position. That is still worth having; it is just not the mechanism people assume."
  - question: "Does FAQPage still show rich results?"
    answer: "Google reduced FAQ rich results substantially in 2023, so treat the visual snippet as unlikely rather than expected. The markup remains useful as machine-readable question-and-answer structure, which is exactly the shape an assistant extracts, so the value moved rather than disappeared."
  - question: "Can I mark up an FAQ that is hidden behind an accordion?"
    answer: "Yes. Content inside a collapsed accordion is present in the HTML and visible on interaction, which satisfies the guideline. Content that is not in the HTML at all, or is display:none with no way to reveal it, does not."
  - question: "What happens if my schema is wrong?"
    answer: "Usually nothing dramatic: invalid markup is ignored and you lose the eligibility you were hoping for. Markup that misrepresents the page is different — that is a guidelines violation and can attract a manual action, which is why the honest-description rule is not pedantry."
  - question: "Do I need schema for AI search?"
    answer: "It helps and it is not sufficient. Schema tells a model what the page is unambiguously, which reduces the chance of being mischaracterised. But assistants extract from body content, so a page with perfect markup and no clear answer in the prose still does not get cited. Structure the writing first, then describe it."
---

## The one rule

Structured data is a description of the page for machines. Everything good about it and every way it
goes wrong follows from that.

If the description is accurate, you have made the page easier to parse, easier to attribute, and
eligible for richer presentation. If it is not — an FAQ that is not on the page, a rating nobody
gave, an author who does not exist — you have made a false claim in a machine-readable format, which
is the easiest kind to detect and act on.

The temptation is real because the markup is invisible to visitors. Treat it as public statement
anyway, because that is how it is read.

## Which types are worth the effort

**Article** on anything editorial, with a real named author whose URL resolves. This is the highest-value
markup for most sites and the one most often left as a bare Organization byline.

**BreadcrumbList** where you have a genuine hierarchy. It is cheap, it is hard to get wrong, and it
still affects how the URL line displays.

**FAQPage** only where an FAQ block genuinely exists. Rich results for it are now rare, so the return
is machine-readability rather than a snippet — worth doing, not worth inventing questions for.

Everything else — Product, Recipe, Event, HowTo — is worth it when the page is genuinely that thing.
Nothing is worth it when the page is not.

## Where markup sits in the order of work

Schema is the last 10% of making a page readable by machines, not the first. A page that cannot be
crawled, or that never states its answer in plain prose, gains nothing from perfect JSON-LD. Fix
access, then structure, then describe.
