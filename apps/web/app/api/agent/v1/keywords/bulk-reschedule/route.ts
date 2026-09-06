import { z } from "zod";
import { withAgent, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAgency } from "@/lib/agent/data";
import { bulkReschedule, ISO_DATE, type RescheduleRequest } from "@/lib/plan/entries";
import { PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";

const isoDate = z.string().regex(ISO_DATE, "YYYY-MM-DD");

const bodySchema = z
  .object({
    workspace_id: z.uuid(),
    /** Each keyword to its own day. */
    items: z.array(z.object({ keyword_id: z.uuid(), date: isoDate })).min(1).max(PLAN_MAX_ENTRIES).optional(),
    /** Or: these keywords, all moved by the same number of days (negative allowed). */
    keyword_ids: z.array(z.uuid()).min(1).max(PLAN_MAX_ENTRIES).optional(),
    shift_days: z.number().int().min(-365).max(365).optional(),
  })
  .refine((b) => Boolean(b.items) !== Boolean(b.keyword_ids), { message: "Send either items or keyword_ids, not both." })
  .refine((b) => !b.keyword_ids || b.shift_days !== undefined, { message: "keyword_ids needs shift_days." });

/**
 * POST /api/agent/v1/keywords/bulk-reschedule
 *
 * Move planned keywords to other days. The same write the planner's drag does
 * (lib/plan/entries.ts), per keyword; one that cannot move does not stop the
 * rest, and the outcome list says why. Only unwritten entries move: once an
 * article exists, its dates belong to the article.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      "Send { workspace_id, items: [{ keyword_id, date: YYYY-MM-DD }] } or { workspace_id, keyword_ids: [...], shift_days: n }.",
    );
  }
  const workspace = await workspaceInAgency(ctx, body.data.workspace_id);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  const req: RescheduleRequest = body.data.items
    ? { items: body.data.items }
    : { keyword_ids: body.data.keyword_ids as string[], shift_days: body.data.shift_days as number };
  const outcomes = await bulkReschedule(ctx.supabase, workspace.id, req);
  const moved = outcomes.filter((o) => o.ok);
  const skipped = outcomes.filter((o) => !o.ok);

  return ok(
    { workspace_id: workspace.id, moved: moved.length, skipped: skipped.length, outcomes },
    skipped.length
      ? `Moved ${moved.length}, skipped ${skipped.length}. Each skipped outcome carries its reason; relay it rather than retrying the same id.`
      : `Moved ${moved.length} planned keyword${moved.length === 1 ? "" : "s"}. GET /keywords?workspace_id= shows the new planned_for days. Nothing was written or published.`,
    { _human: humanSummary(moved.length, skipped.length) },
  );
}, { scope: "write", mutation: true });

function humanSummary(moved: number, skipped: number) {
  return {
    title: "Plan rescheduled",
    summary_instructions: "One sentence: how many planned articles moved and, if any were skipped, why. Name the keywords, not the ids.",
    sections: [
      {
        label: "Result",
        items: [
          { field: "moved", label: "Moved", value_label: String(moved) },
          { field: "skipped", label: "Skipped", value_label: String(skipped) },
        ],
      },
    ],
  };
}
