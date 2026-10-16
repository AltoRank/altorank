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
