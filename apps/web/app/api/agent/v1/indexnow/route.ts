import { z } from "zod";
import { withAgent, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAccount } from "@/lib/agent/data";
import { indexNowKeyLocation, submitIndexNow } from "@/lib/seo/indexing";

const bodySchema = z.object({
  workspace_id: z.uuid(),
  urls: z.array(z.url()).min(1).max(100),
  key_location: z.url().optional(),
});

/**
 * POST /api/agent/v1/indexnow   { workspace_id, urls: [...], key_location? }
 *
 * Tell Bing, Yandex and the other IndexNow engines (ChatGPT search reads
 * Bing) that these pages changed. Uses the workspace's IndexNow key; the site
 * must serve that key as a text file (at the host root, or at key_location),
 * which AltoRank's hosted blog and the WordPress plugin do and a hand-built
 * site may not. Every URL must be on the workspace's own domain.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail("invalid_request", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "Send { workspace_id, urls: [https URLs on the site, max 100] }.");
  }
  const workspace = await workspaceInAccount(ctx, body.data.workspace_id);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  const key = (workspace as { indexnow_key?: string | null }).indexnow_key ?? null;
  if (!key) return fail("not_available", "This workspace has no IndexNow key.", "Tell the human; a key is created with the workspace and cannot be made from here.");

  const domain = (workspace.domain ?? "").replace(/^www\./, "").toLowerCase();
  const byHost = new Map<string, string[]>();
  for (const u of body.data.urls) {
    const host = new URL(u).host.toLowerCase();
    if (host.replace(/^www\./, "") !== domain) {
      return fail("invalid_request", `${u} is not on ${workspace.domain}.`, "Submit only URLs on the workspace's own domain.");
    }
    byHost.set(host, [...(byHost.get(host) ?? []), u]);
  }

  const results: Array<{ host: string; urls: number; accepted: boolean }> = [];
  for (const [host, urls] of byHost) {
    const accepted = await submitIndexNow(host, key, urls, indexNowKeyLocation(host, key, body.data.key_location));
    results.push({ host, urls: urls.length, accepted });
  }
  const refused = results.filter((r) => !r.accepted);
  return ok(
    { workspace_id: workspace.id, submitted: body.data.urls.length, results },
    refused.length
      ? `IndexNow refused ${refused.map((r) => r.host).join(", ")}: almost always the key file is not served on that host. Tell the human the site must serve the workspace's IndexNow key; do not retry until it does.`
      : `Accepted ${body.data.urls.length} URL(s). Accepted means queued for a recrawl, not indexed; check Bing Webmaster or Search Console later.`,
  );
}, { scope: "write", mutation: true });
