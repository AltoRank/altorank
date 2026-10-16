// ---------------------------------------------------------------------------
// How long a first look waits for anything
// ---------------------------------------------------------------------------
//
// A real signup's re-run (2026-10-15) reached qualification and then sat for
// 25 minutes until it was killed by hand. Its budget row held results pages
// and judge reads that had been granted and never settled, and nothing ever
// woke the run again: every term it had started waited on a call whose answer
// never came, and qualification waited for every term.
//
// Three of the awaits between a claim and its settle had no bound at all:
//
// - the run budget's own RPCs (claim, settle, room): supabase-js sends a
//   request with no timeout, so a request whose answer is lost holds its
//   caller for good;
// - a structured model call's reply: the Anthropic SDK's `timeout` is cleared
//   once the response headers arrive (client.js `fetchWithTimeout`), and the
//   body is read with no limit;
// - the spend row a structured call writes before it settles.
//
// So each gets a bound here, and qualification, which waits on all of them at
// once, gets a deadline of its own: past it the stage ends with what it has.
// One module, so the db tests can shorten every bound at once.

/**
 * One run-budget RPC (claim, settle, room) or the spend row a model call
 * writes. A locked one-row update answers in milliseconds; fifteen seconds is
 * a request that is not coming back. A claim that times out is refused (it
 * may still have been granted: the row then holds it at its estimate, the
 * safe side); a settle that times out leaves the claim at its estimate.
 */
export const BUDGET_RPC_TIMEOUT_MS = 15_000;

/**
 * One structured model call, end to end: both attempts the SDK makes
 * (lib/keyword-research/buyer-model.ts STRUCTURED_TIMEOUT_MS and
 * STRUCTURED_MAX_RETRIES), its backoff, and reading the reply. Past it the
 * call is aborted and is no decision.
 */
export const STRUCTURED_CALL_DEADLINE_MS = 250_000;

/**
 * One metered model call (lib/ai/metered.ts: the voice read, the profile
 * inference, the owner questions), end to end. The voice is read before the
 * plan, so a reply that never arrives held the whole first look.
 */
export const METERED_CALL_DEADLINE_MS = 300_000;

/**
 * A first look's qualification, from the start of planning: every results
 * page and judge read of the plan and of the first topic's pick. Production
 * first looks judge a batch in well under a minute; past this the stage ends
 * with what it has judged, the terms it did not finish stay not judged (no
 * verdict saved, nothing parked), and the run goes on to plan.
 */
export const FIRST_LOOK_QUALIFY_MS = 150_000;

// ---------------------------------------------------------------------------
// How long one draft may take, from the start of the invocation writing it
// ---------------------------------------------------------------------------
//
// The writer streamed with no end-to-end limit: the SDK's timeout stops when
// the headers arrive, and a stream that stalls after them holds the call for
// good. /api/internal/draft (a first look's body, the week's fan-out) is
// killed by the platform at its maxDuration, and a function killed there
// records nothing: no failed attempt, no retry for a body owed to the gate,
// and the writer's claim never settled. So the draft gets a deadline measured
// from the start of the invocation - everything before the writer (research,
// the outline) is already spent by the time it starts - and each step on the
// way gets a share of what is left, in this order from the end:
//
//   300s  invocation end   DRAFT_INVOCATION_MS after the route started
//   280s  draft deadline   DRAFT_RECORD_MS before it: the route records the outcome
//   265s  save             DRAFT_SAVE_MS before the deadline: score, store, or fail
//   250s  fact check       DRAFT_FACT_CHECK_MS at most, before the save
//   235s  writer stops     DRAFT_FINISH_MS before the deadline
//   175s  writer starts    at the latest: DRAFT_WRITER_MIN_MS before it must stop
//
// A writer that is still streaming when it must stop is aborted: its claim
// keeps its estimate (it may have been billed), nothing it wrote is saved,
// and the attempt fails the way any failed draft does - so a body owed to a
// first look's gate is tried again in its own invocation (PR #272).

/**
 * The platform's ceiling on one invocation that writes a draft: the
 * `maxDuration` of /api/internal/draft (a literal there; a test keeps the two
 * equal), and of the other routes that write one.
 */
export const DRAFT_INVOCATION_MS = 300_000;

/**
 * Kept after the draft, for the route to say how it ended: clear the body's
 * progress, save the run's timings, record the failure and send the retry
 * (one request), or stamp the run and send the email. Each is a write or two;
 * the budget RPCs inside are bounded at BUDGET_RPC_TIMEOUT_MS.
 */
export const DRAFT_RECORD_MS = 20_000;

/**
 * Kept at the end of the draft for what must happen whatever else did: the
 * score, the stored article and the job row, or on a failure, the row put
 * back and the job marked failed. Nothing optional runs into it.
 */
export const DRAFT_SAVE_MS = 15_000;

/**
 * Kept after the writer for the steps that turn its text into the article -
 * link checks, enrichment and images, the fact check, the featured image -
 * and the save. A writer that ends early leaves them all the time to the
 * deadline; one stopped at its limit leaves them this, and the images are
 * the first to go. So the writer of /api/internal/draft may stream until
 * 235s into the invocation: cron/generate measured a whole draft (research,
 * writer, checks, fact check) at 209s on 2026-09-09
 * (lib/content/generate-queue.ts), and a writer still going at 235s
 * leaves its checks and its save less than a minute before the kill.
 */
export const DRAFT_FINISH_MS = 45_000;

/**
 * The least time a writer is started with. A writer the research and the
 * outline left less than this cannot finish an article, so it is not asked
 * (nothing is claimed) and the attempt fails as out of time.
 */
export const DRAFT_WRITER_MIN_MS = 60_000;

/**
 * One outline call (lib/content/outline.ts), both asks of it together: a
 * structured reply of a few hundred tokens, measured in seconds. Past it the
 * body is written without an outline, the way it was before #272.
 */
export const DRAFT_OUTLINE_MS = 60_000;

/**
 * A lookup the writer is given but does not need: the related keywords and
 * the keyword's volume. DataForSEO answers these in seconds; past this the
 * writer goes without.
 */
export const DRAFT_LOOKUP_MS = 20_000;

/** The outbound link check, every link of it (each GET is bounded at 8s on its own). */
export const DRAFT_LINK_CHECK_MS = 15_000;

/** The video search, before the enrichment (each YouTube request is bounded on its own). */
export const DRAFT_VIDEO_MS = 15_000;

/**
 * The fact check's second pass, which opens the cited pages. Kept before the
 * save; past it the first pass's report is saved, with the claims it could
 * not open still marked as needing a check.
 */
export const DRAFT_FACT_CHECK_MS = 15_000;

/**
 * The section images, all of them, inside the enrichment. Sequential calls
 * of IMAGE_CALL_MS at most; past this, or once the draft's time runs short,
 * no further image is started and the article is saved without the rest.
 */
export const DRAFT_IMAGES_MS = 90_000;

/**
 * Kept inside the enrichment after its images, for its steps that follow
 * (the video, the charts, the call to action, the trust block, the FAQ
 * schema): an image never costs the article its disclaimer.
 */
export const DRAFT_ENRICH_TAIL_MS = 10_000;

/**
 * One image generation (gpt-image), end to end, retries included. The
 * OpenAI SDK's own default is ten minutes and two retries, and like the
 * Anthropic SDK's its timeout does not cover reading the reply.
 */
export const IMAGE_CALL_MS = 60_000;

/** One YouTube Data API request: a search answers in well under a second. */
export const YOUTUBE_REQUEST_MS = 10_000;
