---
title: "Free Word Counter and Readability Checker"
slug: "word-counter"
description: "Words, sentences, reading time and a Flesch grade. Plus why word count is a symptom, not a target."
category: "content"
heroHeadline: "Word counter and readability checker."
heroSubhead: "Word count, reading time and a readability grade for any draft. The useful part is not the total — it is the average sentence length hiding underneath it."
widget: "word-counter"
useCases:
  - "Check a draft against a client's length brief before you send it"
  - "Find the sentences making a technical page unreadable"
  - "Sanity-check reading time for a newsletter or landing page"
  - "Compare a draft's readability against the pages already ranking"
relatedTools:
  - "keyword-density-analyzer"
  - "meta-description-generator"
  - "content-brief-generator"
published: true
datePublished: 2026-09-04
dateModified: 2026-09-04
steps:
  - name: "Paste the draft, not the outline"
    text: "Readability is a property of finished sentences. An outline scores well because bullet fragments are short, which tells you nothing about the prose a reader will meet."
  - name: "Read the average sentence length first"
    text: "It is the number with the most leverage. Flesch reading ease is driven far more by sentence length than by vocabulary, so a page full of ordinary words can still score as graduate-level if the sentences run to forty words."
  - name: "Target a band, not a number"
    text: "Aim for plain English (roughly 60 to 70 reading ease, 8th to 9th grade) for most commercial content, and accept 50 to 60 for genuinely technical material. Chasing a specific score produces stilted writing."
  - name: "Only then look at word count"
    text: "Compare against the pages currently ranking for your query rather than a universal target. If the top results answer the question in 900 words, a 3,000-word version is padding, and padding is the thing readers and models both discard."
  - name: "Fix the longest sentences, not the longest words"
    text: "Split the worst three sentences and re-run. The score moves more than any amount of synonym substitution, and the writing gets better rather than simpler."
faq:
  - question: "Is word count a ranking factor?"
    answer: "No. Google has said repeatedly that there is no minimum or ideal length. Longer pages correlate with better rankings mostly because thorough answers tend to be longer, not because length itself is rewarded. The causation runs through completeness."
  - question: "What is a good readability score for SEO?"
    answer: "For most commercial content, a Flesch reading ease of 60 to 70 — plain English, around 8th to 9th grade — is a sensible target. Technical documentation legitimately sits lower. The score matters less than consistency: a page that swings between very simple and very dense reads as though two people wrote it."
  - question: "How is reading time calculated?"
    answer: "This tool uses 225 words per minute, a common average for adult silent reading of general prose. It is an estimate: a dense technical page reads slower and a listicle reads faster, so treat it as an order of magnitude rather than a promise to your reader."
  - question: "Does readability affect AI citations?"
    answer: "Indirectly, and through structure more than through score. Assistants extract passages they can lift cleanly, and a clear short sentence that answers a question is far easier to quote than the same fact buried in a subordinate clause. Optimising for extractability tends to improve readability as a side effect."
  - question: "Why does the grade level disagree with other tools?"
    answer: "Because syllable counting without a pronunciation dictionary is a heuristic, and different tools guess differently. Treat the band as the signal and the exact number as noise. What is reliable is the direction it moves when you edit."
---

## Why word count is the wrong target

Every content brief specifies a word count and almost none of them should. The number is a proxy that
escaped its purpose: someone noticed that thorough pages tend to be longer, wrote "1,500 words" on a
brief, and the writer padded to hit it.

What the brief meant was *cover the question completely*. Those are different instructions, and only
one of them produces a page worth reading. A 700-word page that answers the query and stops is
stronger than a 2,000-word page with the same answer and 1,300 words of preamble, because the padding
is exactly what a reader skims past and what a model discards when it extracts a passage.

The one legitimate use of word count is comparative. If the pages ranking for your query all run to
about 1,200 words, that tells you something real about what the query demands. It is a floor
discovered from evidence, not a target invented in a brief.

## The number that actually matters

Flesch reading ease is a two-variable formula: average sentence length and average syllables per word.
Sentence length dominates. This means the most common readability problem is not vocabulary — it is
writers joining three ideas with commas because each one felt too small to be its own sentence.

The fix is mechanical and it works. Find your three longest sentences and split each one. Re-run the
count. The score moves further than any thesaurus exercise, and the prose improves rather than getting
dumber, which is the failure mode of writing to a grade level.

## Where this fits

Length and readability are the last checks, not the first. They tell you whether a draft is well
written; they cannot tell you whether it was worth writing. That question is answered before the
draft exists, by whether the query has demand you can realistically rank for — which is what a
keyword plan is for, and why this tool sits in a set that starts with the plan rather than the prose.
