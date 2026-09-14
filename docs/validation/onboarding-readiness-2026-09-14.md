# First-draft readiness — 14 September 2026

This continues the [previous follow-up](./onboarding-followup-2026-09-14.md). It changes when a selected onboarding or first-month article becomes a saved preview. This is an acceptance safeguard, not evidence that every accepted draft is correct or that onboarding conversion has improved.

## What changed

- Every essential evidence question must have supporting records. A comparison requires the **same two options** to have their own supporting facts across **every** core criterion. Vendor aliases and another option's facts cannot fill the missing side of the comparison. The chosen pair and required questions are passed to the writer.
- A separate, bounded 30-second source-readiness assessment tests whether the quotations actually answer those questions at the required specificity, for the correct audience and product. It receives quotations and scope, excluding the extraction model's unverified paraphrases. Missing answers or an incomplete assessment stop writing. This extra check remains a model judgment, not proof of entailment.
- How-to tasks are classified as procedures so evidence collection can follow observed help links for actual steps. Prompts and editorial review explicitly preserve consumer versus professional intent and check core task coverage.
- A completed candidate needs full editorial/claim-check coverage and no unresolved material findings before it is saved as a preview. Minor editorial suggestions can remain. High-risk figure checks also withhold the candidate. No automatic rewriting was enabled.
- A withheld candidate marks its new article row as an error, preserves its research diagnostics, leaves calendar entries unfulfilled and does not increment the successful free-draft counter. Existing customer articles are preserved on failure.
- Onboarding returns to the **same saved choices**, with the reason visible after reload. A user can retry, choose another topic or change the buyer/offering. A stale worker cannot reopen a finished run. First-month preparation continues to other topics without automatically regenerating a known material/evidence failure; incomplete checks retain the bounded retry.

## Real-provider controls

These used isolated local free accounts with a nonfunctional Stripe fixture key to exercise real quota counting. No Stripe API or payment was invoked. Discovery and voice were reused; these are not fresh complete onboardings. The local host was heavily loaded, so the durations are not reliable production latency estimates. Raw outputs and model responses remain outside Git in `onboarding-evidence-validation`.

| Control | Outcome | Quota used before → after | Interpretation |
| --- | --- | --- | --- |
| Brevo, initial readiness controls | Withheld before writing, 82.2 s | 0 → 0 | The same two vendors did not cover all core criteria. |
| Basecamp, initial readiness controls | Withheld after review, 260.1 s | 0 → 0 | The candidate included an unsupported searchable-thread capability and an outcome promise. One reviewer finding also overreached on a harmless hypothetical example; calibration still matters. |
| Fresha, initial readiness controls | Saved, 251.5 s | 0 → 1 | Audience focus improved, but implementer inspection found generic app evidence being used to fill in Fresha booking steps. This was a false acceptance for the desired quality bar, not a release success. |

The added source-readiness assessment was then tested on the saved Fresha source packet. It rejected the booking-steps requirement: the customer-app slogan and professional-app description did not establish the consumer workflow. The original false acceptance is retained above. The positive control accepted Basecamp's saved packet across all three essential questions; this means the source packet can support the task, not that the previously generated Basecamp prose was correct.

A final Fresha production-generator replay with the procedure classification and readiness controls withheld generation after **25.33 seconds**. Applicable procedure evidence was missing, so no writing call was needed. Quota and the successful-draft counter stayed at **zero**. The earlier saved Fresha candidate remains an evaluation artifact; it was not silently rewritten or treated as a clean acceptance.

## Verification status

The focused suite passed 77 tests across eight files, including readiness rejection, comparison coverage, incomplete reviews, route recovery and bounded first-month retry behavior. Changed-file lint passed. A broad local suite encountered timeouts under heavy host load and was interrupted; the browser run failed in global setup while deleting its warm-up test user, before either test body. These are not reported as passing runs. TypeScript briefly read an incomplete generated browser-test file while that server was running; its generated configuration was restored before the final check.

The final TypeScript check passed after the browser server stopped and its generated configuration was restored. The bounded-worker rerun passed **all 3,379 tests across 333 files**, with no skips. The added browser recovery spec exercises material and incomplete-check failures, reload persistence, unchanged allowance and selecting a different topic on the same run.

The browser rerun exposed a stale-message race: a retry still displayed the previous failure while its request was in flight, and the test mistook that old message for completion. The UI now hides the stale failure while submitting; the test waits for each distinct failure outcome and opens the second topic's collapsed brief before choosing it. CI runs recovery in both the standard suite and the gate-enabled lane. Subsequent CI results are tracked on the PR rather than treating the earlier failed attempt as a pass.

The PR remains in draft. Production migrations 090–093, deployment and production smoke checks remain outstanding. More importantly, fresh cohort acceptance is still required: these controls establish safer failure behavior, not consistently compelling first drafts.
