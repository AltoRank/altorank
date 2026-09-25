// ---------------------------------------------------------------------------
// The daily budget for paid public tools
// ---------------------------------------------------------------------------
//
// An anonymous endpoint that calls a paid API is an open tab. Per-IP limits
// stop one client looping; they do not stop a thousand clients. So every paid
// run first reserves its estimated cost against one shared daily cap, in the
// database, atomically (migration 091, `reserve_public_tool_spend`). The cap
// covers all paid tools together, per UTC day.
//
// Fails CLOSED. If the reservation cannot be made - the migration is not
// applied, the database is down, the service key is missing - the paid tool
// does not run. Fetch tools never come here.
//
// The reservation is the estimate, not the bill. Actual provider cost is
// still recorded to provider_spend by the helpers in ai.ts / data.ts.

import { spendClient } from "@/lib/billing/default-spend";

export const DEFAULT_DAILY_CAP_CENTS = 500;

export function dailyCapCents(): number {
  const raw = process.env.PUBLIC_TOOLS_DAILY_CAP_CENTS?.trim();
  if (!raw) return DEFAULT_DAILY_CAP_CENTS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP_CENTS;
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Reserve `estimateCents` of today's budget for one run of `tool`. True when
 * the run may go ahead. False when the cap would be exceeded, and false on
 * any error (fail closed).
 */
export async function reserveSpend(
  tool: string,
  estimateCents: number,
  client: RpcClient | null = spendClient() as RpcClient | null,
): Promise<boolean> {
  if (!client) {
    console.error("[public-tools/spend] no service client; refusing paid run", tool);
    return false;
  }
  try {
    const { data, error } = await client.rpc("reserve_public_tool_spend", {
      p_tool: tool,
      p_estimate_cents: estimateCents,
      p_cap_cents: dailyCapCents(),
    });
    if (error) {
      console.error("[public-tools/spend] reserve failed; refusing paid run", tool, error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("[public-tools/spend] reserve threw; refusing paid run", tool, err instanceof Error ? err.message : err);
    return false;
  }
}
