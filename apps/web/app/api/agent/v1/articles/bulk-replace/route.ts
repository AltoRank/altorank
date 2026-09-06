import { z } from "zod";
import { withAgent, readJson, appBaseUrl } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { articleInAgency, listArticles, workspaceInAgency } from "@/lib/agent/data";
import { articleMutations } from "@/lib/agent/mutations";
import { applyReplace, replaceBodySchema, type ReplaceBody } from "@/lib/agent/replace";
import type { Article } from "@/lib/types";

export const BULK_REPLACE_MAX = 10;

const bodySchema = replaceBodySchema.extend({
  workspace_id: z.uuid(),
  /** Explicit targets; without them, every editable draft in the workspace (up to the cap). */
  article_ids: z.array(z.uuid()).min(1).max(BULK_REPLACE_MAX).optional(),
});

/**
 * POST /api/agent/v1/articles/bulk-replace
 *
 * The same find-and-replace as /articles/{id}/replace across up to ten
 * articles. Preview by default; `preview_only: false` writes. Articles a
 * human has approved, scheduled or published are skipped with the reason,
 * never edited - the cap and the skip list are what make "rebrand every
 * draft" safe to say yes to.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      `Send { workspace_id, find, replace, article_ids? (max ${BULK_REPLACE_MAX}), match_case?, whole_word?, preview_only? (default true) }.`,
    );
  }
  const workspace = await workspaceInAgency(ctx, body.data.workspace_id);
  if (!workspace) return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");

  let targets: Article[];
  if (body.data.article_ids) {
    const found = await Promise.all([...new Set(body.data.article_ids)].map((id) => articleInAgency(ctx, id)));
    const missing = body.data.article_ids.filter((_, i) => !found[i] || found[i]?.workspace_id !== workspace.id);
    if (missing.length) {
      return fail("not_found", `Not in this workspace: ${missing.join(", ")}.`, "Use ids from GET /articles?workspace_id= for the same workspace.");
    }
    targets = found as Article[];
  } else {
    // Editable states only, newest first, capped. Approved and live articles
    // are not candidates, so they do not eat the cap either.
    const all = await listArticles(ctx.supabase, workspace.id, { limit: 200 });
    targets = all.filter((a) => articleMutations(a).replace.allowed).slice(0, BULK_REPLACE_MAX);
  }

  const base = appBaseUrl(request);
  const previewOnly = body.data.preview_only;
  const results: unknown[] = [];
  const skipped: { article_id: string; title: string; reason: string }[] = [];
  let occurrences = 0;
  let changed = 0;
  for (const article of targets) {
    const { replace } = articleMutations(article);
    if (!replace.allowed) {
      skipped.push({ article_id: article.id, title: article.title, reason: replace.reason ?? "Not editable." });
      continue;
    }
    const r = await applyReplace(ctx.supabase, article, body.data as ReplaceBody, base);
    occurrences += r.data.occurrences;
    if (r.data.written) changed++;
    results.push(r.data);
  }

  return ok(
    {
      workspace_id: workspace.id,
      preview_only: previewOnly,
      find: body.data.find,
      replace: body.data.replace,
      articles_considered: targets.length,
      articles_with_matches: results.filter((r) => (r as { occurrences: number }).occurrences > 0).length,
      occurrences,
      written: changed,
      results,
      skipped,
      cap: BULK_REPLACE_MAX,
    },
    previewOnly
      ? `Preview: ${occurrences} occurrence${occurrences === 1 ? "" : "s"} across ${results.length} article${results.length === 1 ? "" : "s"}${skipped.length ? `, ${skipped.length} skipped (approved, scheduled or live)` : ""}. Nothing changed. Show the human the hits; only if they agree, send the same body with preview_only: false.`
      : `Written: ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${changed} article${changed === 1 ? "" : "s"}${skipped.length ? `, ${skipped.length} skipped` : ""}. Status unchanged on every article; nothing was approved or published.`,
  );
}, { scope: "write", mutation: true });
