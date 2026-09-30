// ---------------------------------------------------------------------------
// Each account's daily runs of the paid public tools
// ---------------------------------------------------------------------------
//
// The paid tools (kinds `ai` and `data`) need a signed-in account with a
// confirmed email, and each account gets PUBLIC_TOOLS_USER_DAILY_RUNS
// successful runs per UTC day across all of them together (default 3).
// Counted in the database, atomically (migration 103):
//
//   reserve_public_tool_user_run(user, limit)  before the tool runs
//   release_public_tool_user_run(user, day)    if it then fails on our side
//
// Fails CLOSED like the shared budget in spend.ts: if the reservation cannot
// be made - migration not applied, database unreachable, no service key - the
// answer is "no run", never "unlimited runs".

import { spendClient } from "@/lib/billing/default-spend";

export const DEFAULT_USER_DAILY_RUNS = 3;

export function userDailyRuns(): number {
  const raw = process.env.PUBLIC_TOOLS_USER_DAILY_RUNS?.trim();
  if (!raw) return DEFAULT_USER_DAILY_RUNS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_USER_DAILY_RUNS;
}

/** The next UTC midnight after `now`: when an account's runs come back. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Today's date in UTC, as the database keys the count (YYYY-MM-DD). */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type UserRunReservation =
  | { ok: true; day: string; remaining: number }
  | { ok: false; reason: "cap" | "error" };

type Client = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

type ReadClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, v: unknown) => {
        eq: (col: string, v: unknown) => {
          maybeSingle: () => PromiseLike<{ data: { runs?: unknown } | null; error: { message: string } | null }>;
        };
      };
    };
  };
};

const service = () => spendClient() as unknown as (Client & ReadClient) | null;

/**
 * Take one of today's runs for this account. `{ ok: false, reason: "cap" }`
 * when none are left; `reason: "error"` when the count could not be reached,
 * which the handler also refuses (fail closed).
 */
export async function reserveUserRun(userId: string, client: Client | null = service()): Promise<UserRunReservation> {
  if (!client) {
    console.error("[public-tools/user-runs] no service client; refusing paid run");
    return { ok: false, reason: "error" };
  }
  try {
    const { data, error } = await client.rpc("reserve_public_tool_user_run", {
      p_user_id: userId,
      p_limit: userDailyRuns(),
    });
    if (error) {
      console.error("[public-tools/user-runs] reserve failed; refusing paid run", error.message);
      return { ok: false, reason: "error" };
    }
    const row = data as { ok?: unknown; day?: unknown; remaining?: unknown } | null;
    if (!row || typeof row !== "object" || typeof row.ok !== "boolean") {
      console.error("[public-tools/user-runs] reserve answered an unexpected shape; refusing paid run");
      return { ok: false, reason: "error" };
    }
    if (!row.ok) return { ok: false, reason: "cap" };
    if (typeof row.day !== "string" || typeof row.remaining !== "number") {
      console.error("[public-tools/user-runs] reserve answered without day/remaining; refusing paid run");
      return { ok: false, reason: "error" };
    }
    return { ok: true, day: row.day, remaining: Math.max(0, row.remaining) };
  } catch (err) {
    console.error("[public-tools/user-runs] reserve threw; refusing paid run", err instanceof Error ? err.message : err);
    return { ok: false, reason: "error" };
  }
}

/**
 * Give back a run reserved on `day`, because the tool failed after taking it.
 * Never throws: a release that does not land costs the person one run, which
 * is the safe direction to be wrong in.
 */
export async function releaseUserRun(userId: string, day: string, client: Client | null = service()): Promise<void> {
  if (!client) return;
  try {
    const { error } = await client.rpc("release_public_tool_user_run", { p_user_id: userId, p_day: day });
    if (error) console.error("[public-tools/user-runs] release failed", error.message);
  } catch (err) {
    console.error("[public-tools/user-runs] release threw", err instanceof Error ? err.message : err);
  }
}

/**
 * Runs left today for this account, for the widget's "N runs left today".
 * Null when the count cannot be read: the widget then says nothing rather
 * than a number nobody measured.
 */
export async function runsLeftToday(userId: string, client: ReadClient | null = service()): Promise<number | null> {
  if (!client) return null;
  try {
    const { data, error } = await client
      .from("public_tool_user_runs")
      .select("runs")
      .eq("user_id", userId)
      .eq("day", utcDay())
      .maybeSingle();
    if (error) return null;
    const used = typeof data?.runs === "number" ? data.runs : 0;
    return Math.max(0, userDailyRuns() - used);
  } catch {
    return null;
  }
}
