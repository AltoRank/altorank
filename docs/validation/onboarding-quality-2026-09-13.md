# Onboarding quality follow-up — 13 September 2026

This batch follows PR #214's first qualification and checkout fixes. Real provider runs exposed two problems that unit tests alone could not show: descriptive seeds had no indexed demand, and unfiltered People Also Ask questions became irrelevant article sections.

## Changes

- Propose a mix of established category seeds and specific buying tasks. When fewer than three seeds have measured demand, recover up to eight short category seeds and price them in one extra batch. Probe at most five suggestion seeds in total, including unknown-demand seeds when necessary. Explicit low-volume measurements stay excluded; unknown demand never becomes a measured zero. Suggestions can replace an unknown seed with measured data without creating a duplicate.
- Keep the existing endpoint roles: `keyword_overview` measures exact phrases; `keyword_suggestions` expands seeds; competitor `ranked_keywords` supplies market evidence; live SERPs qualify editorial suitability. Suggestions are still candidates, not permission to write. [DataForSEO documents the full-text seed mechanism](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/).
- Before writing or generating a content brief, require affirmative question-relevance decisions. Use the approved article audience, buying job and angle; retain original questions and decisions in saved research. Missing, malformed or conflicting decisions omit the question. Limit the check to ten distinct questions. FAQ prompts no longer require padding to meet a question count.
- Preserve the searcher's task when choosing an angle. Editorial comparisons and buyer guides count as articles; competing pages need not mention this product's exact differentiators. Bump qualification version to invalidate earlier cached decisions. Use the approved angle for the default article structure, while preserving explicit owner settings.
- Carry the workspace's country into article research rather than deriving country only from language. State the requested language explicitly for qualification fields and generated headings.
- Add a repeatable benchmark that accepts only a loopback Supabase destination, creates separate local accounts, and loads an allowlist of provider credentials. It supports fresh discovery, explicit keyword regressions, a failed-seed recovery replay, and controlled candidate-pool replays. It does not test browser signup, payments, images or CMS publishing.

## Validation

3,144 unit tests passed across 308 test files; 70 tests in the wider suite remain skipped. TypeScript and focused lint pass. The onboarding pipeline tests now mock their external DNS check; domain reachability has separate tests. The production build passes with 95 generated static pages. The last prompt-only cleanup also passes all 21 focused prompt tests.

The sanitized companion JSON preserves successful and unsuccessful runs. Completed drafts and raw local benchmark reports are in the notes workspace under `research/onboarding-quality-2026-09-13/`. These are small diagnostic samples, not conversion, ranking or acquisition evidence. The provider/model outputs are stochastic; the saved-input replay distinguishes qualification changes from changed discovery inputs.

## Findings

- The original 15 failed seeds produced seven shorter recovery candidates; DataForSEO measured four: `seo content writing software` (110/month), `ai writing assistant tools` (50), `content strategy software` (30), and `technical seo audit tools` (210), English/US. These measurements do not establish buyer fit, attainable ranking or recommended article priority.
- The therapy regression removed both “Can ChatGPT do therapy?” and “What is the 2 year rule in therapy?”, while retaining website cost and booking integration questions. Its completed 1,908-word draft stayed on website/platform selection, replacing the observed clinical-question detour.
- An initial SaaS draft remained verbose at 1,899 words and included generic ChatGPT background. After tightening focus, a subsequent 970-word draft followed a single draft-to-publish workflow. These runs selected different topics and are not a controlled word-count comparison.
- Another SaaS run found eight measured seeds but rejected all twelve tested candidates. Review of the saved reasons showed over-rejection of legitimate category comparisons because they lacked AltoRank's exact differentiators. The final qualification replay uses that unchanged profile and candidate order: two qualified, nine rejected, one pending, and a completed 2,021-word implementation guide with practical steps and platform tradeoffs. It remains in review for claim checking.
- The Italian discovery run rejected the consumer question about hourly trainer prices, but its approved headline remained English over an Italian body. That exposed the explicit-language fix and motivated a second keyword regression. Its 1,835-word draft had the Italian title “I 5 migliori CRM per personal trainer: confronto funzionalità e costi”. The checker marked a GDPR citation high risk because it could not match a figure in the fetched page; that is a verification issue, not evidence by itself that the statement is false.

The six completed drafts are iterative samples across three businesses; two use manually selected regression keywords and one replays a saved candidate pool. They are not six independent fresh-signup success tests. One fresh discovery run correctly stopped with no qualified topic rather than generating a replacement.

The last inspection also found contradictory writer instructions: a hardcoded English summary heading and a quota of three numerical claims. Both were removed after the draft samples above. Those last prompt edits passed focused tests and the production build, but have not had another full provider draft replay.

## Remaining limits

The fact checker is not a semantic quality guarantee. The therapy draft received `clean` despite unsupported generalizations about embedded scheduling widgets and vendor capabilities. The SaaS draft also mixed visual accessibility checks with AI crawlability. The Italian draft made vendor and compliance claims that need source-level review. Removing irrelevant questions fixes an observed input failure; it does not prove every generated claim is correct. Stronger source-grounded vendor comparisons and an independent final intent/claim review remain the next quality work.

Recorded spend is incomplete: profile inference does not record its model usage, and early benchmark runs left discovery DataForSEO costs unattributed. The final harness attributes those DataForSEO calls to the local benchmark workspace. Draft timings exclude discovery/qualification and are not signup completion latency. Images were intentionally disabled for these text-quality checks.

PR #214 remains a draft. Production migrations 088/089 and hosted Stripe sandbox verification remain outstanding as documented in the earlier assessment. No app deployment is implied by these local results.
