// ---------------------------------------------------------------------------
// Bodies owed to an outline the owner has already seen
// ---------------------------------------------------------------------------
//
// A first look before the trial ends on its first article's outline: the
// gate shows the title, the headings, the length and the sources, and the
// body is written behind it (lib/content/outline.ts). /api/internal/draft
// tries the body up to three times in a row. What still has no body after
// that - a provider down for an hour, a deploy that killed every try - is
// owed, and this is the sweep that pays it: the daily generate cron hands
// each one back to the draft route, one try a day, until the body lands, the
// tries run out, or three days pass.
//
// What is owed is the server's record, never the article row. Every column
// of `articles` is writable by a member's own client (migration 097), and the
// first version of this read status, outline, keyword and timestamps off the
// row: an owner could turn their first article back into an owed body any
// night and the cron bought a full draft of whatever keyword they wrote
// there, with no budget (round-1 review). So the draft route records the
// debt in `owed_bodies` (migration 107: server only) the moment the gate
// opens on the outline, claims every try there first, and deletes the row
// when the body is saved or given up. The keyword, the outline and the run
// whose budget pays come from that row.
//
// Every try is paid from the first look's own budget (lib/billing/run-budget.ts),
// and a body that the budget can no longer write gets one top-up, once
// (`topUpOwedBudget`), so a first look whose body failed after it was billed
// still ends with an article. A first look therefore costs at most its
// ceiling plus one writer's minimum, and only when a billed body was thrown
// away.

import type { SupabaseClient } from "@supabase/supabase-js";
import { outlineOf, readOutline, type ArticleOutline } from "./outline";
import { selfInvocation, selfInvoke, type SelfInvokeDeps } from "./fan-out";
import { recordEvent } from "@/lib/observability/record";

/** How long an outlined body stays owed before it is given up on. */
export const OWED_BODY_GIVE_UP_MS = 3 * 86_400_000;
/** A body tried this recently may be being written right now. */
export const OWED_BODY_QUIET_MS = 15 * 60_000;
/** Tries in all, the first included: three in a row, then two nightly. */
export const OWED_BODY_MAX_ATTEMPTS = 5;
/** Bodies one sweep hands back; each is its own invocation. */
const SWEEP_LIMIT = 10;
/** Rows one sweep reads: the oldest-tried first. */
const SWEEP_READ = 50;

/**
 * Whether a `drafting` row looks like a body owed to its outline: young, and
 * carrying one. Read off the row, so a client can make any row look like
 * this; it is used only to keep the stale-draft sweep (./stale-drafts.ts)
 * from erroring a row the gate may be showing - never to decide that
 * anything is bought.
 */
export function isOwedBody(row: { instructions_snapshot?: unknown; created_at?: string | null }, now: number = Date.now()): boolean {
  if (!outlineOf(row.instructions_snapshot)) return false;
  const created = Date.parse(String(row.created_at ?? ""));
  return Number.isFinite(created) && now - created < OWED_BODY_GIVE_UP_MS;
}

/** A body owed, as the server recorded it. */
export interface OwedBody {
  articleId: string;
  workspaceId: string;
  runId: string | null;
  keyword: string;
  keywordId: string | null;
  outline: ArticleOutline;
  attempts: number;
  allowanceUsd: number;
  owedSince: string;
  lastTriedAt: string;
}

const COLUMNS = "article_id, workspace_id, run_id, keyword, keyword_id, outline, attempts, allowance_usd, owed_since, last_tried_at";

function toOwed(row: Record<string, unknown> | null | undefined): OwedBody | null {
  if (!row) return null;
  const outline = readOutline(row.outline);
  if (!outline || typeof row.article_id !== "string" || typeof row.workspace_id !== "string" || typeof row.keyword !== "string") return null;
  return {
    articleId: row.article_id,
    workspaceId: row.workspace_id,
    runId: typeof row.run_id === "string" ? row.run_id : null,
    keyword: row.keyword,
    keywordId: typeof row.keyword_id === "string" ? row.keyword_id : null,
    outline,
    attempts: Math.max(0, Math.floor(Number(row.attempts) || 0)),
    allowanceUsd: Math.max(0, Number(row.allowance_usd) || 0),
    owedSince: String(row.owed_since ?? ""),
    lastTriedAt: String(row.last_tried_at ?? ""),
  };
}

/** Whether `body` has run out of tries or of time. */
export function owedBodySpent(body: Pick<OwedBody, "attempts" | "owedSince">, now: number = Date.now()): boolean {
  const since = Date.parse(body.owedSince);
  return body.attempts >= OWED_BODY_MAX_ATTEMPTS || !Number.isFinite(since) || now - since >= OWED_BODY_GIVE_UP_MS;
}

/**
 * Record that the gate is showing `articleId`'s outline and its body is owed:
 * the first try is the one starting now. Service role only. Never throws;
 * false when it could not be written (then a failed body is not tried again,
 * and the stale sweep's own rules end it).
 */
export async function recordOwedBody(
  db: SupabaseClient,
  body: { articleId: string; workspaceId: string; runId: string | null; keyword: string; keywordId: string | null; outline: ArticleOutline },
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  try {
    const { error } = await db.from("owed_bodies").insert({
      article_id: body.articleId,
      workspace_id: body.workspaceId,
      run_id: body.runId,
      keyword: body.keyword,
      keyword_id: body.keywordId,
      outline: body.outline,
      attempts: 1,
      owed_since: at,
      last_tried_at: at,
    });
    if (error) {
      console.error(`[owed-bodies] ${body.articleId}: could not record the owed body: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[owed-bodies] ${body.articleId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export type OwedClaim =
  | { kind: "claimed"; body: OwedBody }
  /** Nothing is owed for this article in this site, or another try claimed it first. */
  | { kind: "none" }
  /** Owed, but out of tries or of time: the caller gives it up. */
  | { kind: "spent"; body: OwedBody };

/**
 * Claim the next try of an owed body, before anything is bought: one more
 * attempt counted, in a conditional update, so two requests for the same try
 * cannot both write it.
 */
export async function claimOwedAttempt(db: SupabaseClient, articleId: string, workspaceId: string, now: number = Date.now()): Promise<OwedClaim> {
  const { data, error } = await db.from("owed_bodies").select(COLUMNS).eq("article_id", articleId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error(`Could not read the owed body: ${error.message}`);
  const body = toOwed(data as Record<string, unknown> | null);
  if (!body) return { kind: "none" };
  if (owedBodySpent(body, now)) return { kind: "spent", body };
  const at = new Date(now).toISOString();
  const { data: won, error: claimError } = await db
    .from("owed_bodies")
    .update({ attempts: body.attempts + 1, last_tried_at: at })
    .eq("article_id", articleId)
    .eq("attempts", body.attempts)
    .select("article_id");
  if (claimError) throw new Error(`Could not claim the owed body's next try: ${claimError.message}`);
  if (!(won ?? []).length) return { kind: "none" };
  return { kind: "claimed", body: { ...body, attempts: body.attempts + 1, lastTriedAt: at } };
}

/** The body landed (or there is nothing left to owe): the record goes. Never throws. */
export async function settleOwedBody(db: SupabaseClient, articleId: string): Promise<void> {
  try {
    const { error } = await db.from("owed_bodies").delete().eq("article_id", articleId);
    if (error) console.error(`[owed-bodies] ${articleId}: could not clear the owed body: ${error.message}`);
  } catch (err) {
    console.error(`[owed-bodies] ${articleId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Give an owed body up: the article is marked errored - while it is still
 * being written, so a body that landed meanwhile is untouched - the record
 * goes, and it is said. The gate then says "Your first article did not
 * finish" rather than showing an outline nothing will fill. Never throws.
 */
export async function giveUpOwedBody(db: SupabaseClient, body: Pick<OwedBody, "articleId" | "workspaceId" | "runId" | "attempts">, why: string, now: number = Date.now()): Promise<void> {
  try {
    await db.from("articles").update({ status: "error", updated_at: new Date(now).toISOString() }).eq("id", body.articleId).eq("status", "drafting");
    await settleOwedBody(db, body.articleId);
    await recordEvent({
      level: "error",
      source: "onboarding.body",
      message: `An outlined first article never got its body; given up after ${body.attempts} tr${body.attempts === 1 ? "y" : "ies"} and marked errored: ${why}`,
      workspaceId: body.workspaceId,
      context: { articleId: body.articleId, runId: body.runId, attempts: body.attempts },
    }, db);
  } catch (err) {
    console.error(`[owed-bodies] ${body.articleId}: could not give up: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The one top-up an owed body's run budget may get: enough to bring what the
 * draft stage can still claim up to `needUsd`, once per body. A body that
 * failed after the writer was billed leaves the run below a writer's minimum,
 * and without this it could never be written. Recorded on the owed row
 * before the ceiling moves, so a second try cannot take it again. False when
 * it was already used, there is no run, or nothing could be written.
 */
export async function topUpOwedBudget(db: SupabaseClient, body: Pick<OwedBody, "articleId" | "runId" | "allowanceUsd">, roomUsd: number, needUsd: number): Promise<boolean> {
  const topUp = Math.round(Math.max(0, needUsd - Math.max(0, roomUsd)) * 1e6) / 1e6;
  if (!body.runId || body.allowanceUsd > 0 || topUp <= 0) return false;
  const { data: run, error: readError } = await db.from("run_budgets").select("ceiling_usd").eq("run_id", body.runId).maybeSingle();
  if (readError || !run) return false;
  const { data: took, error: takeError } = await db
    .from("owed_bodies")
    .update({ allowance_usd: topUp })
    .eq("article_id", body.articleId)
    .eq("allowance_usd", 0)
    .select("article_id");
  if (takeError || !(took ?? []).length) return false;
  const ceiling = Number((run as { ceiling_usd: unknown }).ceiling_usd);
  const { data: raised, error: raiseError } = await db
    .from("run_budgets")
    .update({ ceiling_usd: Math.round((ceiling + topUp) * 1e6) / 1e6, updated_at: new Date().toISOString() })
    .eq("run_id", body.runId)
    .eq("ceiling_usd", (run as { ceiling_usd: unknown }).ceiling_usd as string)
    .select("run_id");
  if (raiseError || !(raised ?? []).length) {
    console.error(`[owed-bodies] ${body.articleId}: the run's budget could not be topped up${raiseError ? `: ${raiseError.message}` : ""}`);
    return false;
  }
  return true;
}

export interface OwedSweep {
  dispatched: string[];
  gaveUp: string[];
  /** Settles when every handed-back request has answered; the cron keeps it alive with after(). */
  settled: Promise<void>;
}

/**
 * Hand every owed body back to the draft route, and give up on the ones out
 * of tries or past OWED_BODY_GIVE_UP_MS. Reads `owed_bodies` only. Never
 * throws: a sweep that cannot run is tomorrow's.
 */
export async function resumeOwedBodies(
  supabase: SupabaseClient,
  deps: SelfInvokeDeps & { now?: number } = {},
): Promise<OwedSweep> {
  const now = deps.now ?? Date.now();
  const sent: Promise<unknown>[] = [];
  const out: OwedSweep = { dispatched: [], gaveUp: [], settled: Promise.resolve() };
  try {
    const { data, error } = await supabase
      .from("owed_bodies")
      .select(COLUMNS)
      .lt("last_tried_at", new Date(now - OWED_BODY_QUIET_MS).toISOString())
      .order("last_tried_at", { ascending: true })
      .limit(SWEEP_READ);
    if (error) {
      console.error(`[owed-bodies] could not read the owed bodies: ${error.message}`);
      return out;
    }
    const how = selfInvocation(deps);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const body = toOwed(row);
      if (!body) continue;
      if (owedBodySpent(body, now)) {
        await giveUpOwedBody(supabase, body, body.attempts >= OWED_BODY_MAX_ATTEMPTS ? "every try failed" : "three days passed", now);
        out.gaveUp.push(body.articleId);
        continue;
      }
      if (out.dispatched.length >= SWEEP_LIMIT || "skipped" in how) continue;
      // Fired, not awaited: the route answers once the body is written. It
      // claims the try itself (`claimOwedAttempt`), so a duplicate does nothing.
      const id = body.articleId;
      sent.push(selfInvoke("/api/internal/draft", {
        workspaceId: body.workspaceId,
        keyword: body.keyword,
        keywordId: body.keywordId,
        runId: body.runId,
        articleId: id,
        resume: true,
      }, how).then(
        (res) => { if (!res.ok) console.error(`[owed-bodies] ${id}: the draft route answered ${res.status}`); },
        (err: unknown) => console.error(`[owed-bodies] ${id}: ${err instanceof Error ? err.message : String(err)}`),
      ));
      out.dispatched.push(id);
    }
    out.settled = Promise.allSettled(sent).then(() => undefined);
  } catch (err) {
    console.error(`[owed-bodies] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
