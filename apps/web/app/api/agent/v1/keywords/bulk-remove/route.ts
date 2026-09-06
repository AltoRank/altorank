import { z } from "zod";
import { withAgent, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAgency } from "@/lib/agent/data";
import { bulkRemove } from "@/lib/plan/entries";
import { PLAN_MAX_ENTRIES } from "@/lib/onboarding/plan";

const bodySchema = z.object({
  workspace_id: z.uuid(),
  keyword_ids: z.array(z.uuid()).min(1).max(PLAN_MAX_ENTRIES),
});

/**
 * POST /api/agent/v1/keywords/bulk-remove
 *
 * Take planned keywords off the calendar. Same semantics as the planner's
 * Remove (lib/plan/entries.ts): the calendar entry goes, the keyword stays
 * tracked with `plan_excluded_at` set so the planner does not put it straight
 * back. Nothing is deleted from the keywords table; there is no call that does.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      `Send { workspace_id, keyword_ids: [...] } (max ${PLAN_MAX_ENTRIES}).`,
    );
  }
  const workspace = await workspaceInAgency(ctx, body.data.workspace_id);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  const outcomes = await bulkRemove(ctx.supabase, workspace.id, [...new Set(body.data.keyword_ids)]);
  const removed = outcomes.filter((o) => o.ok);
  const skipped = outcomes.filter((o) => !o.ok);

  return ok(
    { workspace_id: workspace.id, removed: removed.length, skipped: skipped.length, outcomes, keywords_deleted: 0 },
    (removed.length
      ? `Removed ${removed.length} from the plan. The keywords are still tracked and marked excluded, so the planner will not re-add them; a human can clear that in the dashboard. `
      : "Nothing removed. ") +
      (skipped.length ? `${skipped.length} skipped; each outcome says why. Do not retry the same ids.` : "Nothing was deleted or published."),
    {
      _human: {
        title: "Removed from plan",
        summary_instructions: "Say which keywords came off the calendar and that they remain tracked. Mention skipped ones with their reason.",
        sections: [
          {
            label: "Result",
            items: [
              { field: "removed", label: "Removed from plan", value_label: String(removed.length) },
              { field: "skipped", label: "Skipped", value_label: String(skipped.length) },
              { field: "keywords_deleted", label: "Keywords deleted", value_label: "0", description: "Removal never deletes a keyword." },
            ],
          },
        ],
      },
    },
  );
}, { scope: "write", mutation: true });
