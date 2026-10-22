"use server";

import { getOperator } from "@/lib/auth/admin";
import { selfInvocation, selfInvoke } from "@/lib/content/fan-out";

export type RegenerateState = { ok: string } | { error: string } | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Drafts tab's Regenerate button. Operators only (`getOperator`, null while
 * viewing as a customer). Hands the work to /api/internal/regenerate, which has
 * a whole function's budget for the ~100s a draft takes, and answers as soon
 * as that route has accepted it. The rules - which drafts may be rewritten,
 * and that the rewrite is neither billed nor counted - are in
 * lib/content/regenerate-draft.ts.
 */
export async function regenerateDraftAction(_prev: RegenerateState, formData: FormData): Promise<RegenerateState> {
  const operator = await getOperator();
  if (!operator?.email) return { error: "Operators only." };
  const articleId = String(formData.get("articleId") ?? "");
  if (!UUID.test(articleId)) return { error: "That is not an article id." };

  const how = selfInvocation();
  if ("skipped" in how) return { error: `Cannot reach the regenerate route here (${how.skipped}).` };
  try {
    const res = await selfInvoke("/api/internal/regenerate", { articleId, operatorEmail: operator.email }, how);
    if (res.status !== 202) return { error: `The regenerate route answered ${res.status}.` };
  } catch (err) {
    return { error: `The regenerate route could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: "Started. The draft is rewritten in about two minutes; Events (source admin.regenerate) says how it went." };
}
