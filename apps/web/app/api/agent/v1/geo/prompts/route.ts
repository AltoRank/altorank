import { z } from "zod";
import { withAgent, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAccount } from "@/lib/agent/data";
import { addPrompts, removePrompts } from "@/lib/geo/setup";
import { GEO_PROMPT_LIMIT } from "@/lib/geo/prompts";

/**
 * GET  /api/agent/v1/geo/prompts?workspace_id=   the questions and the switch
 * POST /api/agent/v1/geo/prompts                 { workspace_id, add?, remove? }
 *
 * The question set a site's AI visibility is measured on. The set IS the
 * measurement: changing it changes the number, so an agent should change it
 * only when a human asked, and say that the trend restarts.
 */
export const GET = withAgent(async (request, ctx) => {
  const workspaceId = request.nextUrl.searchParams.get("workspace_id");
  if (!workspaceId) return fail("invalid_request", "workspace_id is required.", "Pass ?workspace_id= from GET /workspaces.");
  const workspace = await workspaceInAccount(ctx, workspaceId);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  const { data, error } = await ctx.supabase
    .from("geo_prompts")
    .select("id, prompt, enabled, created_at")
    .eq("workspace_id", workspace.id)
    .order("created_at");
  if (error) throw new Error(error.message);
  const tracking = Boolean((workspace as { geo_tracking?: boolean }).geo_tracking);
  return ok(
    { workspace_id: workspace.id, tracking, limit: GEO_PROMPT_LIMIT, prompts: data ?? [] },
    `${data?.length ?? 0} question(s); tracking is ${tracking ? "on" : "off"}. ` +
      (tracking && !data?.length ? "Tracking is on but nothing will be measured until questions are added." : ""),
  );
});

const bodySchema = z
  .object({
    workspace_id: z.uuid(),
    add: z.array(z.string()).max(GEO_PROMPT_LIMIT).optional(),
    remove: z.array(z.string()).max(GEO_PROMPT_LIMIT).optional(),
  })
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, { message: "add or remove at least one question" });

export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      "Send { workspace_id, add?: [question, ...], remove?: [id or exact question, ...] }.",
    );
  }
  const { workspace_id, add = [], remove = [] } = body.data;
  if (!(await workspaceInAccount(ctx, workspace_id))) {
    return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  }

  // Removals first, so a swap at the limit has room.
  const removed = remove.length ? await removePrompts(ctx.supabase, ctx.accountId, workspace_id, remove) : { ok: true as const, removed: [] };
  if (!removed.ok) return fail("not_found", removed.error, "Call GET /workspaces and use an id from that list.");
  const added = add.length ? await addPrompts(ctx.supabase, ctx.accountId, workspace_id, add) : { ok: true as const, added: [] };

  const data = { workspace_id, added: added.added, removed: removed.removed };
  if (!added.ok) {
    return fail(
      "invalid_request",
      added.error,
      `Added ${added.added.length} before stopping; fix or drop that question and send the rest. Removals already applied: ${removed.removed.length}.`,
    );
  }
  return ok(
    data,
    `Added ${added.added.length}, removed ${removed.removed.length}. The question set is the measurement: tell the human the trend restarts from the next sweep.`,
  );
}, { scope: "write", mutation: true });
