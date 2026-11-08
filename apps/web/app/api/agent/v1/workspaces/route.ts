import { z } from "zod";
import { withAgent, appBaseUrl, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { accountWorkspaces, workspaceInAccount } from "@/lib/agent/data";
import { toAgentWorkspace } from "@/lib/agent/records";
import { checkDomainReachable } from "@/lib/domain/reachable";
import { getWorkspaceAllowance, workspaceLimitMessage } from "@/lib/billing/workspaces";
import { insertWorkspaceAsServer } from "@/lib/workspaces/insert";
import { generateIndexNowKey } from "@/lib/seo/indexing";

/** GET /api/agent/v1/workspaces - every site in the account. */
export const GET = withAgent(async (request, ctx) => {
  const base = appBaseUrl(request);
  const workspaces = (await accountWorkspaces(ctx)).map((w) => toAgentWorkspace(w, base));
  return ok(
    { workspaces, count: workspaces.length },
    workspaces.length
      ? "Pick the workspace the human means and pass its id as workspace_id. GET /workspaces/{id} shows its integrations."
      : "No workspaces. Ask the human to add a workspace in the dashboard first.",
  );
});

const createSchema = z.object({
  domain: z
    .string()
    .transform((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, ""))
    .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/, "Enter a domain like acme.com")),
  name: z.string().trim().min(1).max(80).optional(),
});

/**
 * POST /api/agent/v1/workspaces   { domain, name? }
 *
 * Add a site, with the same checks as the dashboard's Add workspace
 * (app/actions/workspaces.ts createWorkspace): the domain resolves, the plan
 * has a site left, the site is not already in the account, and the person who
 * created this key is an owner or admin who sees every site. A key is nobody,
 * so the insert is made as its creator.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = createSchema.safeParse(parsed.body);
  if (!body.success) {
    return fail("invalid_request", body.error.issues[0]?.message ?? "Check the domain.", "Send { domain: \"acme.com\", name?: \"Acme\" }.");
  }
  const { domain } = body.data;
  const name = body.data.name ?? domain;

  const { data: key } = await ctx.supabase.from("api_keys").select("created_by").eq("id", ctx.key.id).maybeSingle();
  const userId = (key?.created_by as string | null | undefined) ?? null;
  if (!userId) return fail("forbidden", "This key has no creator on record, so it cannot add a site.", "Ask the human to add the site in the dashboard, or to create a new key.");

  const reach = await checkDomainReachable(domain);
  if (!reach.ok) return fail("invalid_request", reach.reason, "Check the domain with the human; do not retry with a guess.");

  const allowance = await getWorkspaceAllowance(ctx.supabase, ctx.accountId, null);
  if (allowance.remaining !== null && allowance.remaining <= 0) {
    return fail("quota_exceeded", workspaceLimitMessage(allowance), "Tell the human the plan has no site left; adding one needs a bigger plan.");
  }

  const { data: dup } = await ctx.supabase
    .from("workspaces")
    .select("id, name")
    .eq("account_id", ctx.accountId)
    .ilike("domain", domain)
    .maybeSingle();
  if (dup) return fail("invalid_request", `${domain} is already the workspace "${dup.name}".`, `Use workspace_id ${dup.id}; one workspace per site.`);

  const inserted = await insertWorkspaceAsServer(ctx.supabase, userId, ctx.accountId, {
    name,
    domain,
    initials: name.slice(0, 2).toUpperCase(),
    color: "av-c1",
    indexnow_key: generateIndexNowKey(),
  });
  if (!inserted.ok) return fail("forbidden", inserted.error, "Tell the human; an owner or admin adds sites.");

  const created = await workspaceInAccount(ctx, inserted.id);
  return ok(
    { workspace: created ? toAgentWorkspace(created, appBaseUrl(request)) : { id: inserted.id }, created_as_key: ctx.key.name },
    `Added ${domain}. Nothing is drafted until the human finishes setup in the dashboard; connect Search Console on its Integrations page for traffic data.`,
  );
}, { scope: "write", mutation: true });
