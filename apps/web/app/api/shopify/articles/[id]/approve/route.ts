import { NextResponse } from "next/server";
import { approveForWorkspace } from "@/lib/articles/approve";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import { accountOwner } from "@/lib/shopify/owner";

/**
 * POST /api/shopify/articles/:id/approve - the sign-off, from inside Shopify.
 *
 * The same checks as the dashboard's Approve (lib/articles/approve.ts), on
 * the store's own site only. The approval is recorded under the account's
 * owner: approved_by must name an AltoRank user, and the Shopify staff member
 * who pressed it has none.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const { supabase, installation } = auth.ctx;
  const { id } = await params;

  const owner = await accountOwner(supabase, installation.accountId);
  if (!owner) return NextResponse.json({ error: "This account has no owner to approve under." }, { status: 409 });

  try {
    await approveForWorkspace(
      supabase,
      { accountId: installation.accountId, workspaceId: installation.workspaceId, userId: owner.userId, actor: owner.user },
      id,
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }
  return NextResponse.json({ ok: true });
}
