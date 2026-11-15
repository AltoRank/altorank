// ---------------------------------------------------------------------------
// What is left on the search-data account, and telling someone before it is gone
// ---------------------------------------------------------------------------
//
// 2026-11-10 to 11-15: the DataForSEO balance ran to zero and nobody was
// told. Every first look in those five days ended "our search data did not
// answer"; one signup's two free runs were both spent on it, and the outage
// was found by reading the export. The balance is one free call away
// (/appendix/user_data), so it is asked every night before the overnight
// retry, and when a first look ends on a provider outage, and the operators
// are emailed once a day while it is low.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordEvent } from "@/lib/observability/record";
import { notifyOperatorsProviderBalance } from "@/lib/email/lifecycle";
import { get, hasDataForSEOCredentials } from "./client";

/** Below this the operators are told: several days of first looks at about $0.50 each. */
export const LOW_BALANCE_USD = 10;

export interface ProviderBalance {
  /** US dollars left; negative once the last call overdrew it. */
  balance: number;
  low: boolean;
  /** Nothing left: every paid call is refused until a top-up. */
  empty: boolean;
}

type UserData = { money?: { balance?: number | null } | null };

/** The DataForSEO balance, or null when it cannot be known (no credentials, no answer). */
export async function dataforseoBalance(): Promise<ProviderBalance | null> {
  if (!hasDataForSEOCredentials()) return null;
  try {
    const res = await get<UserData>("/appendix/user_data");
    const balance = res.tasks?.[0]?.result?.[0]?.money?.balance;
    if (typeof balance !== "number" || !Number.isFinite(balance)) return null;
    return { balance, low: balance < LOW_BALANCE_USD, empty: balance <= 0 };
  } catch {
    return null;
  }
}

/**
 * Read the balance and, when it is low, say so: a warning in the event log
 * (the daily digest reads it) and an email to the operators, once a day.
 * Never throws; the balance comes back for a caller that acts on it.
 */
export async function checkProviderBalance(
  supabase: SupabaseClient,
  deps: { balance?: typeof dataforseoBalance; now?: Date } = {},
): Promise<ProviderBalance | null> {
  const found = await (deps.balance ?? dataforseoBalance)().catch(() => null);
  if (!found?.low) return found;
  try {
    await recordEvent(
      {
        level: found.empty ? "error" : "warn",
        source: "provider.balance",
        message: found.empty
          ? `The DataForSEO balance is empty ($${found.balance.toFixed(2)}): keyword research and first looks cannot plan until it is topped up.`
          : `The DataForSEO balance is low: $${found.balance.toFixed(2)} left, under the $${LOW_BALANCE_USD} warning line.`,
        context: { provider: "dataforseo", balance: found.balance, empty: found.empty },
      },
      supabase,
    );
    await notifyOperatorsProviderBalance(supabase, { balance: found.balance, empty: found.empty, threshold: LOW_BALANCE_USD }, deps.now);
  } catch (err) {
    console.error(`[provider.balance] could not tell the operators: ${err instanceof Error ? err.message : err}`);
  }
  return found;
}
