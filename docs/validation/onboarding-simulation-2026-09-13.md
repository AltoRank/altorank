# Live onboarding and output evaluation — 13 September 2026

**Verdict: the choice-and-resume mechanism works, but the experience and writing are not consistently good enough to release unchanged.** Both completed drafts need substantive editing. This run establishes concrete defects and useful improvements; it does not establish higher conversion or an improvement over PR 214 under controlled conditions.

## What was tested

PR 215, commit `75102a6`, using its production Next.js build at `http://localhost:3125`, a fresh local account and local Supabase. The AltoRank journey used the actual browser, website fetches, Anthropic and DataForSEO, with fixtures disabled. It covered profile confirmation, progressive briefs, topic choice, reload during research/choice/drafting, completed calendar, article editor and editorial findings. The second topic was chosen deliberately.

Two additional fresh businesses ran through the production profile/research/recommendation/generation functions: Pimlico Plumbers (UK, local services) and Beardbrand (US search locale, ecommerce). Those are pipeline-only tests using the unedited inferred profile; they did not include owner confirmation, voice training or a browser journey. They test the default path and are not equivalent to a human-confirmed business evaluation.

Only local test rows were written. Email, Stripe, image generation and CMS publishing were disabled. Signup email delivery, hosted preview/trial conversion, checkout, entitlement webhooks and production hosting limits were not tested. Three runs shared the machine and provider account, so timings are samples, not latency benchmarks. No application code was changed during this evaluation.

## Results

| Case | First supported brief | Final topic result | Draft | Recorded provider cost |
| --- | --- | --- | --- | --- |
| AltoRank, full browser | 59 seconds after profile confirmation | Five choices ready at 2m 05s; all demand unmeasured | Selected second topic; 1,593 words; 2m 05s after selection | $0.590* |
| Pimlico Plumbers, pipeline | None | 100 stored candidates, 12 checked, zero qualified; stopped on budget after 5m 20s | None; refused to invent a topic | $0.496 |
| Beardbrand, pipeline | 4m 46s from inference start | 100 stored candidates, 18 checked, three qualified; stopped on budget | 1,034 words; 1m 44s generation; total run 7m 27s | $0.827 |

AltoRank's profile was observed ready within 25 seconds of entry. Its research and generation stages took about 4m 10s combined, excluding time spent reviewing the profile and choosing a topic. The first-brief/choice timings come from two-second local database observations; they are not exact browser paint timings. The failed Pimlico run's terminal time uses its final report write timestamp.

*Total recorded spend was approximately **$1.913**. AltoRank's separate voice-analysis call does not record spend, so this is not a complete invoice total. All recorded rows had costs; that does not prove all calls were recorded.*

Machine-readable evidence: [results.json](./onboarding-simulation-2026-09-13/results.json).

## What worked

- The live site read populated priority buyer, offering and conversion destination. The capability panel distinguished checked evidence-backed items from unconfirmed items and linked sources.
- Briefs appeared while qualification continued. Unknown demand was explicitly labelled, and the pipeline did not invent volumes.
- Research, choices and drafting survived reload. Exactly zero articles existed before choice. Exactly one article was created afterward, matching the selected second topic and the approved headline.
- The finished article remained in review, unapproved and unpublished. Its calendar entry points to the correct article.
- Editorial findings were retained and exposed in the editor; flagged prose was not destructively deleted.
- The research screen fit a 390px viewport without horizontal overflow. No browser errors were captured. The editor did emit a duplicate-image-extension warning.

## Highest-priority findings

### 1. The writer still needs a quality improvement pass

[Unedited AltoRank draft](./onboarding-simulation-2026-09-13/altorank-draft.md): **How to compare bulk AI content generation tools**.

The title is preserved and the advice to test a real batch is useful. However:

- The opening definition is repeated later, and the article repeatedly makes the same approval/crawlability argument.
- A forced internal-link phrase produces “open source ai seo tools compared style self-hosted infrastructure”. Other anchors read like raw search queries rather than natural prose.
- The comparison table invents broad categories and asserts their typical speed, review controls and client support without evidence. No named alternatives are assessed. A reader gets a publisher-weighted checklist rather than a concrete shortlist or worked comparison.
- The article presents three workspaces as a general AltoRank limit. That is the Managed limit; Agency and self-hosting differ. This is a source-context failure, not an invented number. [AltoRank pricing](https://altorank.co/pricing/).
- It uses GPTBot to support a discussion of assistant search visibility without distinguishing training from search. Those controls are independent. [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots).
- It implies different crawl access for Google Search and AI Overviews without support from the cited page. Google's AI-features documentation describes Googlebot as the access control for Search including AI features. [Google documentation](https://developers.google.com/search/docs/appearance/ai-features).
- The approved conversion destination was `/pricing`; the final CTA sends readers to the homepage.

[Unedited Beardbrand draft](./onboarding-simulation-2026-09-13/beardbrand-draft.md): **Best beard care products by type: oils, balms, washes, and conditioners**.

The categories, headings and table are readable. It still falls short of the buying task: no specific product shortlist, meaningful product comparison, prices or documented recommendation methodology. It cites Wikipedia for skin-related claims and an entire subreddit as support for a supposed community consensus, without a specific discussion. It recommends oil very broadly and uses fixed washing frequencies without adequately distinguishing skin types; the AAD gives different moisturizer recommendations for acne-prone, normal/dry and sensitive skin. [AAD beard-care guidance](https://www.aad.org/public/everyday-care/skin-care-secrets/face/healthy-beard).

### 2. Business evidence is still lost or misapplied

AltoRank's five final topics included two CMS-selection guides, even though the confirmed offering was AI-assisted content generation with editorial approval. The independent task editor correctly redirects those queries toward selecting a CMS, but product fit is not checked again against that corrected task. In my assessment, three topics are directly relevant; two are weak first-session recommendations. This is one reviewer's judgment, not a precision metric.

The broader tests show the opposite problem too:

- Beardbrand's inferred profile omitted explicit wash and balm products. The qualifier then rejected those terms for lacking offering support, though both appear on the actual site. These are demonstrated business-evidence omissions; final editorial suitability still requires its own check. [Beardbrand catalog](https://www.beardbrand.com/).
- Pimlico's qualifier rejected a Croydon query because coverage was unconfirmed, while its website explicitly lists Croydon. This establishes missing location evidence, not that the query necessarily deserves an article. [Pimlico service area](https://www.pimlicoplumbers.com/).
- The Pimlico pricing-comparison rejection says pricing guidance is not editorial while acknowledging buying guides in the results. Several other decisions remained incomplete. Zero accepted topics therefore does not establish zero worthwhile opportunities.

### 3. Review findings are neither complete nor fully actionable

AltoRank's five editorial flags include useful findings, false positives and omissions. A claim about remediation/page generation is flagged despite those actions appearing in the supplied evidence quote. The plan-specific workspace error and unsupported category table are missed.

Beardbrand's editorial review returned **unavailable**, with product, qualitative and structure checks all **not checked**. The draft stayed in review, which is correct. The exact cause of the unavailable result was not established; it must not be described as a clean review or assumed to be a provider outage.

Clicking AltoRank's second “Find this passage” button twice reports that the sentence no longer exists even though it is present across an internal link. The locator searches individual text nodes; full-sentence findings can span several nodes. This is a reproducible functional defect in the new review workflow. [Screenshot](/private/tmp/altorank-onboarding-simulation/11-editor-finding.png).

The 85 SEO / 64 GEO scores are heuristic outputs, not quality grades. The editor flags a missing definition despite an explicit definition paragraph, and a missing takeaway block despite a summary list. One message says nothing overstates the evidence while another flags unsupported claims. Those mixed messages reduce trust.

### 4. The waiting and completion screens do not consistently describe the current state

- Profile confirmation promises a “30-day plan”; research promises up to five ideas. The inner card says “about a minute” while the page says a few minutes.
- After selection, the page still says it is finishing checks “before you choose a draft”, while the inner log correctly says it is writing the selected draft.
- “Why it fits” exposes internal criticism of a discarded angle, including statements about what “the proposed angle” got wrong. Some explanations are cut off mid-sentence. Users need the rationale for the final recommendation.
- The progress log mixes counts of decisions with counts accepted/rejected and displays implementation details. The Speed tab exposes `PAGESPEED_API_KEY` configuration instructions after a rate-limit response. This proves a poor error presentation locally, not a production outage.
- In this self-host configuration, completion leads to the full calendar and then the editor rather than displaying the article immediately. The hosted trial preview path was not exercised.
- The mini-calendar displays the selected second draft on today as well as its scheduled day, although the real calendar correctly retains September 17.

Evidence: [choice screen](/private/tmp/altorank-onboarding-simulation/07-choice.png), [drafting screen](/private/tmp/altorank-onboarding-simulation/08-drafting.png), [completion screen](/private/tmp/altorank-onboarding-simulation/10-completed.png).

### 5. Latency and mobile draft reading need attention

The two established businesses needed many sequential buyer-fit calls before useful qualification. The collection cap does not bound the combined pool of new candidates plus existing ranked terms before the full buyer test. Pimlico recorded 20 buyer-fit calls, Beardbrand 25, including subsequent qualification batches. This is a credible latency bottleneck; the local timing does not establish hosted timeout behavior.

At 390px, the downstream article editor has a document width of 957px. Closing its navigation drawer does not fix it; the rewrite panel pushes article content out of view. This is an observed onboarding-destination problem, not an established regression introduced by this PR. [Mobile screenshot](/private/tmp/altorank-onboarding-simulation/13-mobile-editor-closed-menu.png).

## Recommended next pass

1. Carry product and location evidence with its conditions, fetch missing details selectively, and recheck business fit after correcting an article's task. Do not relax qualification simply to fill five slots.
2. Improve the final writing against a concrete reader task: supported examples and comparisons, natural link anchors, no repeated definitions, accurate claim context and the selected conversion link. Recheck the resulting draft after revisions.
3. Make review failures explicit and actionable; fix cross-node passage location and separate heuristic scores from factual confidence.
4. Give each onboarding stage accurate copy and show the chosen draft as the main completion result. Bound and prioritize the initial candidate work so established sites see value sooner. Make the draft readable on mobile.
5. Rerun these saved cases after fixes, then perform the planned independent business evaluation and hosted Stripe sandbox checks. Conversion improvement still needs measurement with real users.

These tests are sufficient to identify the next fixes. They are not a blinded human evaluation, a complete factual audit, a controlled before/after comparison or a release sign-off.
