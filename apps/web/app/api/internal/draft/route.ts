/**
 * Write exactly one draft, in its own invocation.
 *
 * Server-to-server only, authenticated with CRON_SECRET like the cron routes:
 * the callers are the onboarding worker (the first draft) and the trial resume
 * (the rest of the week, lib/plan/resume-week.ts), neither of which has a user
 * session to forward. See lib/content/fan-out.ts for why this exists at all -
 * briefly, a draft costs 103s against a 300s function, so the way to write
 * several quickly is several invocations rather than one longer one.
 *
 * One draft per request, never a loop. That is the whole point: the budget is
 * per invocation, and a loop here would rebuild the bottleneck it removes.
 *
 * With `runId` this is the last leg of an onboarding run: the worker chose the
 * keyword and passed the gates, and this writes the draft and stamps the run's
 * row - research done, then the article and the terminal status - so the
 * progress screen, which polls the row, sees "Wrote 1,240 words on X" the
 * moment it is true. The stamp is guarded on the row still being `running`,
 * so a run the start route has since closed as stale is not reopened.
 *
 * The "your draft is ready" email goes from here too, straight after that
 * stamp, because this is the one place that knows the draft is ready. It used
 * to be chained onto the worker's wait for this request, inside a worker
 * whose own budget the pipeline had mostly spent; when the platform cut the
 * worker off the email waited for cron/generate's sweep, and a real signup
 * (2026-09-22) read "your draft is ready" 42 minutes after the draft existed.
 *
 * With `entryId` and `claim` this is one entry of a resumed week: the resume
 * claimed the entry for `claim` (lib/plan/draft-claim.ts) and this writes it
 * only while that claim still stands, so a duplicated request or a second
 * delivery of the Stripe event writes nothing. When it is done, well or
 * badly, it starts the week's next draft, and the last one to land sends the
 * one email for the batch.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { generateArticle } from "@/lib/content/generate";
import { fulfilPlannedEntry } from "@/lib/onboarding/plan";
import { getQuota, quotaExceededMessage } from "@/lib/billing/quota";
import { trialCancelledReason, trialHoldReason } from "@/lib/billing/trial-hold";
import { stampRun } from "@/lib/onboarding/run-store";
import { announceDraftBatch } from "@/lib/email/draft-batch";
import { recordEntryFailure } from "@/lib/plan/draft-claim";
import { continueFrom } from "@/lib/plan/resume-week";
import { draftBudgetShort, draftCanBuyLookup, FIRST_DRAFT_MIN_USD, loadDraftBudget } from "@/lib/billing/run-budget";
import { isBudgetRefusal, withSpendScope } from "@/lib/billing/spend-scope";
import type { OnboardingEvent } from "@/lib/onboarding/events";
import type { RelatedKeyword, SerpData } from "@/lib/seo/brief-data";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RunClock, saveRunTimings, withRunClock } from "@/lib/onboarding/timings";
import { outlineHeadings, OutlineNotOwedError, type ArticleOutline } from "@/lib/content/outline";
import { claimOwedAttempt, giveUpOwedBody, OWED_BODY_MAX_ATTEMPTS, recordOwedBody, settleOwedBody, topUpOwedBudget, type OwedBody } from "@/lib/content/owed-bodies";
import { trialGateApplies } from "@/lib/billing/trial";
import { authorised, selfInvocation, selfInvoke } from "@/lib/content/fan-out";
import { recordEvent } from "@/lib/observability/record";
import { fullArticleOn } from "@/lib/onboarding/first-article-body";
import { recordRunTiming } from "@/lib/onboarding/funnel-event";
import { BODY_PROGRESS_VERSION, measureStream, type BodyProgress } from "@/lib/onboarding/body-progress";
import type { BodyStage } from "@/lib/onboarding/setup-progress";

/** The streamed text, for the owner's reader: often enough that it reads as typed. */
const STREAM_FLUSH_MS = 500;
/** The counts alone, with the text locked: the outline ticks once a second at most. */
const PROGRESS_FLUSH_MS = 1_000;

export const maxDuration = 300;

interface Body {
  workspaceId?: string;
  keywordId?: string | null;
  keyword?: string;
  /** The onboarding run this is the first draft of. */
  runId?: string;
  /** The planned entry a resumed week claimed, and the claim it holds. */
  entryId?: string;
  claim?: string;
  selection?: { reasons: string[]; score: number; difficulty: number | null; volume: number | null };
  /**
   * This draft's share of the run's one related-keyword lookup, when the
   * dispatcher bought the week in a single task (lib/content/fan-out.ts).
   * Absent means nobody looked and this draft buys its own.
   */
  relatedKeywords?: RelatedKeyword[];
  /**
   * With `resume`: the outlined article whose body is owed - a first look's
   * body that failed after its gate opened on the outline. Only what the
   * server recorded is owed (`owed_bodies`, lib/content/owed-bodies.ts): the
   * keyword, the outline, the run and the count of tries come from that
   * record, which this route claims a try on before anything is bought.
   * `attempt` is informational.
   */
  articleId?: string;
  resume?: boolean;
  attempt?: number;
  /** The results page the first look judged the keyword on, for the draft's research. */
  serp?: SerpData;
}

/** A first look's body is tried this many times in a row before the nightly sweep takes it. */
export const MAX_BODY_ATTEMPTS = 3;

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspaceId, selection } = body;
  // Replaced by the server's record of an owed body, below.
  let { keyword, runId } = body;
  let keywordId = body.keywordId ?? null;
  // A resumed entry is named by its id and its claim, both or neither.
  const claimed = body.entryId && body.claim ? { entryId: body.entryId, by: body.claim } : null;
  // A body owed to a stored outline, named by its article.
  const owed = body.resume === true && typeof body.articleId === "string" && body.articleId ? { articleId: body.articleId } : null;
  // The fan-out always names a plan entry; the first draft of a run may not
  // have one (a keyword recommended but not planned) and is keyed by the run.
  if (!workspaceId || !keyword || (!keywordId && !runId && !claimed && !owed) || Boolean(body.entryId) !== Boolean(body.claim)) {
    return NextResponse.json(
      { error: "workspaceId, keyword and keywordId (or runId, or entryId with claim) are required" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const stamp = (event: OnboardingEvent, opts?: Parameters<typeof stampRun>[3]) =>
    runId ? stampRun(supabase, runId, event, opts) : Promise.resolve(false);

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, account_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) {
    await stamp({ phase: "drafting", status: "failed", detail: "The workspace no longer exists." }, { finish: true });
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // A body owed to an outline the gate is showing: only what the server
  // recorded is owed, and this try is claimed there first - a duplicate, a
  // try past the last one, or an article nobody owes writes nothing. The
  // keyword, the outline and the run whose budget pays are the record's.
  let owedBody: OwedBody | null = null;
  if (owed) {
    const claim = await claimOwedAttempt(supabase, owed.articleId, workspaceId).catch((err: unknown) => {
      console.error(`[internal/draft] could not claim the owed body ${owed.articleId}: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (!claim || claim.kind === "none") return NextResponse.json({ status: "skipped", reason: "not-owed" }, { status: 200 });
    if (claim.kind === "spent") {
      await giveUpOwedBody(supabase, claim.body, "every try failed or three days passed");
      return NextResponse.json({ status: "skipped", reason: "given-up" }, { status: 200 });
    }
    owedBody = claim.body;
    if (!owedBody.runId) {
      await giveUpOwedBody(supabase, owedBody, "its first look is gone, so nothing bounds the try");
      return NextResponse.json({ status: "skipped", reason: "given-up" }, { status: 200 });
    }
    keyword = owedBody.keyword;
    keywordId = owedBody.keywordId;
    runId = owedBody.runId;
  }

  // Idempotence first, before any gate is asked: a request that does not hold
  // the entry it names - a duplicate, or one whose claim was handed to
  // another writer - must not record anything against somebody else's claim.
  const { data: entry } = claimed
    ? await supabase
        .from("calendar_entries")
        .select("id, article_id")
        .eq("id", claimed.entryId)
        .eq("workspace_id", workspaceId)
        .eq("draft_claimed_by", claimed.by)
        .is("article_id", null)
        .is("draft_failed_at", null)
        .maybeSingle()
    : keywordId
      ? await supabase
          .from("calendar_entries")
          .select("id, article_id")
          .eq("workspace_id", workspaceId)
          .eq("keyword_id", keywordId)
          .is("article_id", null)
          .maybeSingle()
      : { data: null };
  // A retried dispatch, or the cron reaching the same entry first, must not
  // produce a second article for one planned day. An entry that already
  // carries an article_id is done.
  if (!entry && !runId && !owed) {
    return NextResponse.json({ status: "skipped", reason: claimed ? "not-claimed" : "already-written" }, { status: 200 });
  }

  // What a resumed entry does once it is settled either way: hand the week
  // its next draft, and, when this was the last one, send the batch's email.
  const next = (): void => {
    if (claimed) after(() => chainNext(supabase, workspaceId, claimed.by));
  };

  // The same gates the cron and the onboarding pipeline use. The trial hold
  // first (lib/billing/trial-hold.ts): the onboarding's own first draft
  // passes it, anything after it waits for the trial, in the hold's words.
  // Then the cancelled trial: the week's burst runs through here, and a
  // person who cancels mid-burst has the rest of it refused at its next step.
  const quota = await getQuota(supabase, workspace.account_id as string);
  // An owed body adds no draft: its row is the one the claim counted.
  const held = trialHoldReason(quota, owed ? { adding: 0 } : {});
  const cancelled = held ? null : trialCancelledReason(quota);
  const refusal = held ?? cancelled ?? (quota.limit !== null && (quota.remaining ?? 0) <= 0 ? quotaExceededMessage(quota) : null);
  if (refusal) {
    await stamp({ phase: "drafting", status: "skipped", detail: refusal }, { finish: true });
    if (claimed) await recordEntryFailure(supabase, claimed.entryId, claimed.by, refusal);
    next();
    return NextResponse.json({ status: "skipped", reason: held ? "trial-hold" : cancelled ? "trial-cancelled" : "quota" }, { status: 200 });
  }

  // An onboarding run's first draft is paid from the run's budget, which the
  // worker opened (lib/billing/run-budget.ts): the draft stage's reserve,
  // plus whatever the research left. A budget that cannot cover a draft
  // skips it before anything is bought; a claim refused part-way stops it
  // the same way. Skipped, not failed: the plan stands, and the run says why.
  // A run with no row to read is held to the draft's reserve, never left
  // unbounded. The related keywords come in the body (the worker hands an
  // empty list when it did not buy them); with none, a budgeted draft buys
  // them only from room above what its writer needs.
  //
  // An owed body is paid from the same budget, every try of it. A body that
  // failed after the writer was billed leaves the run below a writer's
  // minimum; it gets one top-up to that minimum, once (owed-bodies.ts), and
  // past that it is given up rather than written outside the budget.
  const budget = runId ? await loadDraftBudget(supabase, runId) : null;
  let short = await draftBudgetShort(budget);
  if (short && owedBody && budget) {
    const room = await budget.room("draft").catch(() => null);
    if (room !== null && (await topUpOwedBudget(supabase, owedBody, room, FIRST_DRAFT_MIN_USD))) short = await draftBudgetShort(budget);
  }
  const relatedKeywords = Array.isArray(body.relatedKeywords)
    ? body.relatedKeywords
    : budget && !(await draftCanBuyLookup(budget)) ? [] : undefined;
  if (short && owedBody) {
    await giveUpOwedBody(supabase, owedBody, short);
    return NextResponse.json({ status: "skipped", reason: "budget" }, { status: 200 });
  }
  if (short) {
    await stamp({ phase: "drafting", status: "skipped", detail: short }, { finish: true });
    return NextResponse.json({ status: "skipped", reason: "budget" }, { status: 200 });
  }

  // The run's stopwatch, on the run's own axis, so the draft's stages land
  // on the worker's timeline (lib/onboarding/timings.ts).
  const clock = runId ? await runClock(supabase, runId) : null;
  const timedRun = <T,>(fn: () => Promise<T>): Promise<T> => (clock ? withRunClock(clock, fn) : fn());
  const saveTimings = async (outcome: string) => {
    if (!clock || !runId) return;
    clock.mark("run_done");
    const merged = await saveRunTimings(supabase, runId, clock);
    await recordRunTiming({ runId, workspaceId, accountId: workspace.account_id as string, timings: merged ?? clock.toJSON(), outcome });
  };

  // Before the trial the run is over once the outline exists: the gate shows
  // the article's shape, and its body is written behind it. A body that then
  // fails stays owed (`keepOnFailure`) and is tried again, never shown as a
  // broken gate. An account with no gate waits for the body, as before.
  const gated = trialGateApplies(quota);
  let outlinedId: string | null = owed?.articleId ?? null;
  let entryFulfilled = false;
  const onOutline = async ({ articleId, outline }: { articleId: string; outline: ArticleOutline }) => {
    outlinedId = articleId;
    // Owed from the moment the gate shows it: recorded by the server, so a
    // retry and the nightly sweep read what was shown, not the row.
    if (gated && runId && keyword) await recordOwedBody(supabase, { articleId, workspaceId, runId, keyword, keywordId, outline });
    // On the calendar now: the gate's card reads its day from the entry.
    if (entry) {
      await fulfilPlannedEntry(supabase, entry.id as string, articleId);
      entryFulfilled = true;
    }
    if (!runId) return;
    const sections = outlineHeadings(outline).length;
    const detail = `Outlined "${outline.title}": ${sections} section${sections === 1 ? "" : "s"}, about ${outline.targetWordCount.toLocaleString()} words` +
      (outline.sources.length ? `, ${outline.sources.length} source${outline.sources.length === 1 ? "" : "s"}` : "") + ". The full text is being written now.";
    if (gated) {
      clock?.mark("gate");
      // The body is owed from here: the gate shows it thinking at once.
      enterStage("thinking");
      void writeStream();
      await stamp(
        { phase: "drafting", status: "done", detail },
        { finish: true, article: { id: articleId, title: outline.title, keyword, wordCount: outline.targetWordCount, verdict: "unchecked", outlined: true } },
      );
      // The gate's moment is on the row even if the body never lands.
      if (clock) await saveRunTimings(supabase, runId, clock);
    } else {
      await stamp({ phase: "drafting", status: "active", detail });
    }
  };

  // While the first article's body is written behind its gate, the row
  // keeps two server-only records of it (migrations 107 and 108):
  //
  // - `body_progress`, always: counts only - the stage (thinking, writing,
  //   finishing), when it began, the H2s started and the words so far - so
  //   the gate ticks the outline off and shows the work moving, with the
  //   text locked (lib/onboarding/body-progress.ts). About once a second.
  // - `body_stream`, only with PRETRIAL_FULL_ARTICLE on: the writer's text
  //   so far, for the owner's reader, every half second, so it reads as
  //   typed rather than in two-second blocks (recorded 2026-10-12).
  //
  // Both are cleared once the body is saved or fails. Writes are chained so
  // they land in order, and a failed one is ignored: the body never waits
  // on its own progress.
  const progressing = gated && Boolean(runId || owedBody);
  const streaming = fullArticleOn() && progressing;
  let streamed = "";
  let streamWrite: Promise<unknown> = Promise.resolve();
  let lastStreamAt = 0;
  let stage: BodyStage = "thinking";
  let stageSince = new Date().toISOString();
  const enterStage = (next: BodyStage) => {
    stage = next;
    stageSince = new Date().toISOString();
  };
  const writeStream = (final = false) => {
    if (!outlinedId || !progressing) return;
    const id = outlinedId;
    const measured = measureStream(streamed);
    const progress: BodyProgress | null = final ? null : { v: BODY_PROGRESS_VERSION, stage, since: stageSince, ...measured };
    const update: Record<string, unknown> = { body_progress: progress };
    // Nothing to read yet is not an empty body: the column stays unset.
    if (streaming && (final || streamed)) update.body_stream = final ? null : streamed;
    streamWrite = streamWrite.then(() =>
      supabase.from("articles").update(update).eq("id", id).then(
        (r) => { if (r.error) console.warn(`[internal/draft] body progress not written: ${r.error.message}`); },
        () => undefined,
      ),
    );
    return streamWrite;
  };
  const onChunk = progressing
    ? (chunk: string) => {
        if (stage === "thinking") {
          enterStage("writing");
          lastStreamAt = 0;
        }
        streamed += chunk;
        const now = Date.now();
        if (now - lastStreamAt >= (streaming ? STREAM_FLUSH_MS : PROGRESS_FLUSH_MS)) {
          lastStreamAt = now;
          void writeStream();
        }
      }
    : undefined;
  const onWritten = progressing
    ? () => {
        enterStage("finishing");
        void writeStream();
      }
    : undefined;
  // An owed body tried again starts from thinking, with the gate already open.
  if (owedBody) void writeStream();

  try {
    const result = await timedRun(() => withSpendScope({ workspaceId, runId: runId ?? null, budget, stage: budget ? "draft" : null }, () => generateArticle({
      supabase,
      workspaceId,
      keyword,
      keywordId: keywordId ?? undefined,
      autonomous: true,
      selection,
      relatedKeywords,
      billToAccountId: workspace.account_id as string,
      ...(onChunk ? { onChunk } : {}),
      ...(onWritten ? { onWritten } : {}),
      // Read, not bought again: only a page shaped like one, for a first look's own draft.
      ...(runId && body.serp && Array.isArray(body.serp.organic) && Array.isArray(body.serp.peopleAlsoAsk) ? { serp: body.serp } : {}),
      ...(owedBody
        ? { articleId: owedBody.articleId, resumeOutline: owedBody.outline }
        : runId
          ? { outline: { onReady: onOutline, keepOnFailure: gated } }
          : {}),
      // The one boundary inside the draft: research is done, the model is
      // about to write. The same sentence the inline pipeline emits, so the
      // screen reads identically whichever invocation wrote the draft.
      onResearch: runId
        ? (research) =>
            void stamp({
              phase: "drafting",
              status: "active",
              detail:
                `Read ${research.competitors.length} ranking page${research.competitors.length === 1 ? "" : "s"}` +
                ` and ${research.peopleAlsoAsk.length} question${research.peopleAlsoAsk.length === 1 ? "" : "s"} people ask. Writing now.`,
            })
        : undefined,
    })));
    clock?.mark("body_done");
    if (progressing) await writeStream(true);
    if (outlinedId) await settleOwedBody(supabase, outlinedId);
    if (entry && !entryFulfilled) await fulfilPlannedEntry(supabase, entry.id as string, result.articleId);
    await stamp(
      {
        phase: "drafting",
        status: "done",
        detail: `Wrote ${result.wordCount.toLocaleString()} words on "${keyword}".`,
      },
      {
        finish: true,
        // A run that ended at its gate gets the body's sentence, nothing more.
        amend: Boolean(outlinedId && gated),
        article: {
          id: result.articleId,
          title: result.title,
          keyword,
          wordCount: result.wordCount,
          verdict: result.factCheck.verdict,
        },
      },
    );
    // The run's draft is ready the moment the row says so, and the email
    // says so at the same moment. Whether or not the stamp took - a run the
    // start route closed as stale still has a real draft in review.
    // `announceDraftBatch` never throws.
    if (runId || owedBody) await announceDraftBatch(supabase, workspaceId);
    await saveTimings("written");
    next();
    return NextResponse.json(
      { status: "generated", articleId: result.articleId, wordCount: result.wordCount },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (progressing) await writeStream(true);
    await saveTimings(isBudgetRefusal(err) ? "budget" : "failed");
    // A body owed to an outline the gate is already showing: tried again in
    // its own invocation, and the nightly sweep after that. The run stays as
    // it ended at the gate, and nobody is told setup failed: it did not.
    // Nothing is owed after all (the row was written meanwhile, or is not
    // the account's first draft): the record goes, and nothing is retried.
    if (owedBody && err instanceof OutlineNotOwedError) {
      await settleOwedBody(supabase, owedBody.articleId);
      return NextResponse.json({ status: "skipped", reason: "not-owed" }, { status: 200 });
    }
    if (outlinedId && (gated || owedBody)) {
      const attempt = owedBody?.attempts ?? 1;
      if (attempt >= OWED_BODY_MAX_ATTEMPTS) {
        await giveUpOwedBody(supabase, { articleId: outlinedId, workspaceId, runId: runId ?? null, attempts: attempt }, detail.slice(0, 200));
        return NextResponse.json({ status: "skipped", reason: "given-up", attempt }, { status: 200 });
      }
      const again = attempt < MAX_BODY_ATTEMPTS && !isBudgetRefusal(err) ? selfInvocation() : null;
      await recordEvent({
        level: "warn",
        source: "onboarding.body",
        message: `The first article's body failed after its outline was shown (attempt ${attempt} of ${MAX_BODY_ATTEMPTS})${again && !("skipped" in again) ? "; trying again now" : "; the nightly sweep writes it"}: ${detail.slice(0, 200)}`,
        workspaceId,
        accountId: workspace.account_id as string,
        context: { runId: runId ?? null, articleId: outlinedId, attempt },
      }, supabase);
      if (again && !("skipped" in again)) {
        const retry = { workspaceId, keyword, keywordId, runId, selection, articleId: outlinedId, resume: true, attempt: attempt + 1 };
        after(() => selfInvoke("/api/internal/draft", retry, again).then(() => undefined, (e: unknown) => console.error(`[internal/draft] retry could not be sent: ${e instanceof Error ? e.message : e}`)));
      }
      return NextResponse.json({ status: "owed", attempt, error: detail }, { status: 200 });
    }
    if (isBudgetRefusal(err)) {
      await stamp({ phase: "drafting", status: "skipped", detail: `${detail} A person picks the first article up.` }, { finish: true });
      return NextResponse.json({ status: "skipped", reason: "budget" }, { status: 200 });
    }
    await stamp({ phase: "drafting", status: "failed", detail }, { finish: true });
    // On the calendar, in words, and handed back: the next scheduled run
    // takes an entry whose draft failed whatever its date.
    if (claimed) await recordEntryFailure(supabase, claimed.entryId, claimed.by, detail);
    next();
    return NextResponse.json({ status: "error", error: detail }, { status: 500 });
  }
}

/**
 * Start the week's next draft, and when nothing is left in flight, tell the
 * account about the batch. Never throws: this runs after the response, and
 * whatever it cannot do is still owed, so the scheduled writer's next run
 * starts the chain again (lib/plan/resume-sweep.ts) and the draft sweep
 * announces what landed.
 *
 * The batch's email goes out the day it lands even when the account already
 * heard from us today. That is the ordinary case, not the exception: a trial
 * started on signup day follows the first draft's email by minutes, and the
 * once-a-day rule (lib/email/draft-batch.ts) would hold the week the person
 * just paid to open until tomorrow's sweep.
 */
async function chainNext(supabase: SupabaseClient, workspaceId: string, by: string): Promise<void> {
  try {
    const step = await continueFrom(supabase, workspaceId, { by });
    if (step.done) await announceDraftBatch(supabase, workspaceId, { evenIfToldToday: true });
    await step.settled;
  } catch (err) {
    console.error(`[internal/draft] could not start the next draft for ${workspaceId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** A clock on the run's own axis: its started_at, read once. Null when the run cannot be read. */
async function runClock(supabase: SupabaseClient, runId: string): Promise<RunClock | null> {
  const { data } = await supabase.from("onboarding_runs").select("started_at").eq("id", runId).maybeSingle();
  const startedAt = (data as { started_at?: string } | null)?.started_at;
  return startedAt ? new RunClock(startedAt) : null;
}
