// ---------------------------------------------------------------------------
// The trial gate's body lock, for a request that carries a key
// ---------------------------------------------------------------------------
//
// The agent API is what the CLI, the stdio MCP server and the hosted /api/mcp
// all call, so a refusal here covers the three of them. A key has no session,
// so "who is asking" is the person who created it: their address is what the
// operator check and the bypass list are asked about, exactly as they would be
// for that person signed in. A key with no creator on record (older rows)
// asks as nobody, which getQuota reads as a cron.

import { accountTrialGate } from "@/lib/billing/body-lock";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import type { AgentContext } from "./auth";
import { fail, type FailEnvelope } from "./envelope";

async function keyCreatorEmail(ctx: AgentContext): Promise<string | null> {
  const { data: key, error } = await ctx.supabase.from("api_keys").select("created_by").eq("id", ctx.key.id).maybeSingle();
  if (error) throw new Error(`could not read the key's creator (${error.message})`);
  const userId = key?.created_by as string | null | undefined;
  if (!userId) return null;
  const { data } = await ctx.supabase.auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

/** Whether article bodies are withheld from this key's account. */
export async function agentBodyLocked(ctx: AgentContext): Promise<boolean> {
  return (await accountTrialGate(ctx.supabase, ctx.accountId, await keyCreatorEmail(ctx))) === "gated";
}

/** The refusal an agent reads, and the one thing it should tell the human. */
export function bodyLockedEnvelope(appBaseUrl: string): FailEnvelope {
  return fail(
    "forbidden",
    BODY_LOCKED_MESSAGE,
    `This account has not started its trial, so article text is not available through the API yet. Tell the human to start the trial at ${appBaseUrl}/onboarding. Do not retry, and do not try another route to the text.`,
  );
}
