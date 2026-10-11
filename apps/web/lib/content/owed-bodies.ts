// ---------------------------------------------------------------------------
// Bodies owed to an outline the owner has already seen
// ---------------------------------------------------------------------------
//
// A first look before the trial ends on its first article's outline: the
// gate shows the title, the headings, the length and the sources, and the
// body is written behind it (lib/content/outline.ts). /api/internal/draft
// tries the body three times in a row. What still has no body after that -
// a provider down for an hour, a deploy that killed every try - is owed, and
// this is the sweep that pays it: the daily generate cron hands each one back
// to the draft route, one try a day, for three days.
//
// Owed is not abandoned, so the stale-draft sweep (./stale-drafts.ts) leaves
// these rows alone while they are young enough to be written. Past that the
// row is marked errored like any draft that never finished, and the gate says
// so honestly ("Your first article did not finish") rather than showing an
// outline nothing will ever fill.

import type { SupabaseClient } from "@supabase/supabase-js";
import { outlineOf } from "./outline";
import { selfInvocation, selfInvoke, type SelfInvokeDeps } from "./fan-out";
import { recordEvent } from "@/lib/observability/record";

/** How long an outlined body stays owed before it is given up on. */
export const OWED_BODY_GIVE_UP_MS = 3 * 86_400_000;
/** A row touched this recently may be being written right now. */
export const OWED_BODY_QUIET_MS = 15 * 60_000;
/** Bodies one sweep hands back; each is its own invocation. */
const SWEEP_LIMIT = 10;

/** Whether a `drafting` row is a body owed to its outline, not a run that died. */
export function isOwedBody(row: { instructions_snapshot?: unknown; created_at?: string | null }, now: number = Date.now()): boolean {
  if (!outlineOf(row.instructions_snapshot)) return false;
  const created = Date.parse(String(row.created_at ?? ""));
  return Number.isFinite(created) && now - created < OWED_BODY_GIVE_UP_MS;
}

export interface OwedSweep {
  dispatched: string[];
  gaveUp: string[];
  /** Settles when every handed-back request has answered; the cron keeps it alive with after(). */
  settled: Promise<void>;
}

/**
 * Hand every owed body back to the draft route, and give up on the ones past
 * OWED_BODY_GIVE_UP_MS. Never throws: a sweep that cannot run is tomorrow's.
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
      .from("articles")
      .select("id, workspace_id, keyword, keyword_id, created_at, updated_at, instructions_snapshot")
      .eq("status", "drafting")
      .lt("updated_at", new Date(now - OWED_BODY_QUIET_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) {
      console.error(`[owed-bodies] could not read outlined drafts: ${error.message}`);
      return out;
    }
    const rows = ((data ?? []) as Array<{ id: string; workspace_id: string; keyword: string | null; keyword_id: string | null; created_at: string; instructions_snapshot: unknown }>)
      .filter((r) => outlineOf(r.instructions_snapshot));
    const how = selfInvocation(deps);
    for (const row of rows) {
      if (!isOwedBody(row, now)) {
        const at = new Date(now).toISOString();
        const { error: giveUpError } = await supabase.from("articles").update({ status: "error", updated_at: at }).eq("id", row.id).eq("status", "drafting");
        if (giveUpError) continue;
        out.gaveUp.push(row.id);
        await recordEvent({
          level: "error",
          source: "onboarding.body",
          message: "An outlined first article never got its body; given up after three days and marked errored.",
          workspaceId: row.workspace_id,
          context: { articleId: row.id },
        }, supabase);
        continue;
      }
      if (out.dispatched.length >= SWEEP_LIMIT || "skipped" in how || !row.keyword) continue;
      // The last attempt the route allows: this sweep's try, and no chain.
      // Fired, not awaited: the route answers once the body is written.
      const id = row.id;
      sent.push(selfInvoke("/api/internal/draft", {
        workspaceId: row.workspace_id,
        keyword: row.keyword,
        keywordId: row.keyword_id,
        articleId: id,
        resume: true,
        attempt: 3,
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
