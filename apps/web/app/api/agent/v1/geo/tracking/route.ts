import { z } from "zod";
import { withAgent, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { setTracking } from "@/lib/geo/setup";

const bodySchema = z.object({ workspace_id: z.uuid(), enabled: z.boolean() });

/**
 * POST /api/agent/v1/geo/tracking   { workspace_id, enabled }
 *
 * Switch AI visibility tracking on or off for one site: the same switch as
 * the /geo setup card (lib/geo/setup.ts). On costs DataForSEO money every
 * week, so it is refused without a paid plan. Off stops new sweeps; answers
 * already collected stay.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail("invalid_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "Send { workspace_id, enabled: true|false }.");
  }
  const res = await setTracking(ctx.supabase, ctx.accountId, body.data.workspace_id, body.data.enabled, null);
  if (!res.ok) {
    return res.error.includes("paid plan")
      ? fail("forbidden", res.error, "Tell the human tracking needs a paid plan; do not retry.")
      : fail("not_found", res.error, "Call GET /workspaces and use an id from that list.");
  }
  return ok(
    { workspace_id: body.data.workspace_id, tracking: body.data.enabled },
    body.data.enabled
      ? "Tracking is on. A sweep starts at the next daily 08:00 run if the site has questions (GET /geo/prompts); answers fill in over about five days."
      : "Tracking is off: no new sweeps start. Answers already collected stay readable.",
  );
}, { scope: "write", mutation: true });
