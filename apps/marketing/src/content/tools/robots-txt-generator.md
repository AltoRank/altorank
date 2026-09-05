---
title: "Free robots.txt Generator With AI Crawler Rules"
slug: "robots-txt-generator"
description: "Build a robots.txt with AI crawler rules. Which bots train models, which answer questions, and why it matters."
category: "technical"
heroHeadline: "robots.txt generator: decide which AI crawlers can read you."
heroSubhead: "A robots.txt builder that separates the crawlers fetching to train a model from the ones fetching to answer a question — because blocking the second group is what removes you from the answers."
widget: "robots-txt"
useCases:
  - "Write a robots.txt without hand-editing syntax"
  - "Allow answer engines while blocking training crawlers"
  - "Audit whether you are accidentally invisible to ChatGPT and Perplexity"
  - "Give a client a defensible AI-crawler policy rather than a default"
relatedTools:
  - "seo-health-checker"
  - "schema-generator"
  - "slug-generator"
published: true
datePublished: 2026-09-04
dateModified: 2026-09-04
steps:
  - name: "Separate training from retrieval"
    text: "GPTBot, ClaudeBot, Google-Extended, CCBot and Applebot-Extended fetch pages to train models. OAI-SearchBot, ChatGPT-User, Claude-User and PerplexityBot fetch pages to answer a question someone is asking right now. They are different decisions with different consequences."
  - name: "Decide what you are actually protecting"
    text: "Blocking training crawlers is a reasonable position on how your work is used. Blocking retrieval crawlers is a decision to not appear in AI answers, which for most commercial sites is a decision to be absent from a growing share of discovery."
  - name: "Write the rules explicitly"
    text: "A missing user-agent block means the crawler falls back to User-agent: *. If your wildcard rule is permissive, you are allowing every AI crawler by default, whether or not you decided to."
  - name: "Keep the sitemap line"
    text: "It is unrelated to the bot rules and it is the cheapest discovery win in the file. One line, absolute URL."
  - name: "Verify rather than assume"
    text: "Fetch your own /robots.txt after deploying. A staging file that shipped with Disallow: / is one of the most expensive one-line mistakes in SEO, and it is invisible from inside the CMS."
faq:
  - question: "Does blocking GPTBot remove me from ChatGPT?"
    answer: "Not from live answers. GPTBot is the training crawler; OAI-SearchBot and ChatGPT-User are the ones that fetch pages to answer a question in the moment. If you want to be cited in ChatGPT while declining to be training data, allow those and block GPTBot — which is the third option in the builder above."
  - question: "Should I allow AI crawlers at all?"
    answer: "If you publish content to be found, allowing the retrieval crawlers is close to a necessity: a page no assistant may fetch cannot be a page any assistant cites. Training crawlers are a genuine judgement call and reasonable publishers land on both sides."
  - question: "Is robots.txt legally binding?"
    answer: "No. It is a convention that well-behaved crawlers respect voluntarily. Major AI companies document their user-agents and honour the file, but it is not access control. If content must not be fetched, it needs authentication rather than a polite request."
  - question: "Does Disallow stop a page being indexed?"
    answer: "No, and this is the most common robots.txt misunderstanding. Disallow stops crawling. A URL that is linked from elsewhere can still be indexed without its content, which produces a result with no snippet. To keep a page out of the index, allow the crawl and use a noindex meta tag."
  - question: "Where does the file have to live?"
    answer: "At the root of the host, exactly /robots.txt. It applies per host and per protocol, so a subdomain needs its own file, and the file at the root of your CDN domain does not govern your main site."
---

## The distinction almost every robots.txt gets wrong

There are two kinds of AI crawler and they are usually treated as one.

**Training crawlers** fetch pages to build a model: `GPTBot`, `ClaudeBot`, `Google-Extended`, `CCBot`,
`Applebot-Extended`. Blocking them is a statement about how your work is used. It has no effect on
whether you appear in answers today.

**Retrieval crawlers** fetch a page because a person just asked a question it might answer:
`OAI-SearchBot`, `ChatGPT-User`, `Claude-User`, `PerplexityBot`. Blocking these removes you from AI
answers. That is the whole consequence, and it is usually applied by accident, by someone pasting a
"block AI bots" snippet from a forum.

The builder above offers the split explicitly because it is the configuration most publishers
actually want and almost nobody writes by hand.

## What a permissive wildcard already decided for you

If your file ends with `User-agent: *` and a short `Disallow` list, you have allowed every AI crawler
that exists and every one that ships next year. That may be exactly right. It should still be a
decision rather than an inheritance, which is why writing the user-agent blocks explicitly is worth
the extra lines.

## The one line people forget

`Sitemap:` has nothing to do with bot policy and belongs in the file anyway. It is an absolute URL,
it costs one line, and it is the most direct way to tell every crawler what exists on your site.

## Robots.txt is a prerequisite, not a strategy

Getting this file right does not make a page citable. It makes a page *reachable*, which is the step
before. Of 274 sites we checked against the nine technical signals an assistant needs to read a page,
86 failed every one — and crawl access is only the first of the nine.
