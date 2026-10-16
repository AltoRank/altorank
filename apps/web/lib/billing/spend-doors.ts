// ---------------------------------------------------------------------------
// Paid doors a person can press as often as they like: how often they may
// ---------------------------------------------------------------------------
//
// The spend gate (lib/billing/spend-gate.ts) answers whether an account may
// spend at all. It does not answer how often. A few doors are pressed by a
// person, cost a model call or a crawl each time, and have nothing between
// one press and the next:
//
//   editor-rewrite        the editor's whole-article rewrite, a long Sonnet call
//   editor-micro          the editor's field and selection rewrites
//   wizard-site-read      the setup wizard's read of the site
//   wizard-rivals         the setup wizard's rival lookup (results pages, a
//                         vetting call, a bulk-rank read)
//   wizard-rival-resolve  one typed rival, resolved and sized
//
// Each press is counted here, per account and, for the wizard, per site, in
// one or more windows. The wizard's reads also keep what they bought for a
// while (`readDoorCache`/`keepDoorResult`), so a reload of the wizard hands
// back the read it already paid for instead of buying it again.
//
// The count lives in `spend_door_uses` (migration 116), taken under a lock by
// `take_spend_door`, so two presses at once cannot both slip under a limit.
// Without 116 (or when the database cannot be asked) the same limits are
// kept in this process's memory: per instance and lost on a cold start, which
// still stops a loop on one instance and never refuses more than the table
// would.
//
// Self-host and operator accounts are not counted: the gate's reason says so
// and the callers skip this file for them.

import type { SupabaseClient } from "@supabase/supabase-js";
import { spendClient } from "@/lib/billing/default-spend";

export type SpendDoor = "editor-rewrite" | "editor-micro" | "wizard-site-read" | "wizard-rivals" | "wizard-rival-resolve";

export interface DoorLimit {
  /** Counted across the account, or across one site. */
  scope: "account" | "workspace";
  limit: number;
  /** The window, in seconds. Null: every use there has ever been. */
  windowSeconds: number | null;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The limits, by door. Generous for a person using the product and small for
 * a loop: a whole-article rewrite takes the better part of a minute to read
 * and review, and a site is read once per setup.
 */
export const DOOR_LIMITS: Record<SpendDoor, DoorLimit[]> = {
  "editor-rewrite": [
    { scope: "account", limit: 20, windowSeconds: HOUR },
    { scope: "account", limit: 60, windowSeconds: DAY },
  ],
  "editor-micro": [
    { scope: "account", limit: 120, windowSeconds: HOUR },
    { scope: "account", limit: 600, windowSeconds: DAY },
  ],
  "wizard-site-read": [
    { scope: "workspace", limit: 3, windowSeconds: DAY },
    { scope: "account", limit: 10, windowSeconds: DAY },
  ],
  "wizard-rivals": [
    { scope: "workspace", limit: 3, windowSeconds: DAY },
    { scope: "account", limit: 10, windowSeconds: DAY },
  ],
  "wizard-rival-resolve": [
    { scope: "workspace", limit: 30, windowSeconds: DAY },
    { scope: "account", limit: 60, windowSeconds: DAY },
  ],
};

/**
 * Before the trial an account sets up one site, once (PRE_TRIAL_SETUP_RUNS),
 * so its wizard reads are counted for the account's whole life as well: a
 * daily window alone let a signup that never finishes buy the read again
 * every day. Generous enough for "Try again" after a site that would not load.
 */
export const PRE_TRIAL_DOOR_LIMITS: Partial<Record<SpendDoor, DoorLimit[]>> = {
  "wizard-site-read": [{ scope: "account", limit: 5, windowSeconds: null }],
  "wizard-rivals": [{ scope: "account", limit: 5, windowSeconds: null }],
  "wizard-rival-resolve": [{ scope: "account", limit: 40, windowSeconds: null }],
};

/** How long a wizard read is handed back instead of bought again. */
export const WIZARD_READ_KEEP_SECONDS = 7 * DAY;

/** The limits a door is counted against, for an account before or after its trial. */
export function doorLimits(door: SpendDoor, opts: { preTrial?: boolean } = {}): DoorLimit[] {
  return [...DOOR_LIMITS[door], ...(opts.preTrial ? (PRE_TRIAL_DOOR_LIMITS[door] ?? []) : [])];
}

export type DoorTake =
  | { allowed: true; /** The counted use, for keepDoorResult. Null when counted in memory. */ useId: string | null }
  | { allowed: false; limit: DoorLimit; message: string };

/** What each door says when it is shut. One sentence, printed as it is. */
const REFUSAL: Record<SpendDoor, string> = {
  "editor-rewrite": "This account has used its whole-article rewrites for now",
  "editor-micro": "This account has used its quick rewrites for now",
  "wizard-site-read": "This site has been read as many times as setup allows",
  "wizard-rivals": "Competitors have been looked up as many times as setup allows",
  "wizard-rival-resolve": "Competitors have been looked up as many times as setup allows",
};

export function doorRefusal(door: SpendDoor, limit: DoorLimit): string {
  const when =
    limit.windowSeconds === null
      ? " before the trial. Start the trial to look again, or fill this in by hand."
      : limit.windowSeconds <= HOUR
        ? `: ${limit.limit} an hour. Try again within the hour.`
        : `: ${limit.limit} a day. Try again tomorrow${door.startsWith("wizard") ? ", or fill this in by hand" : ""}.`;
  return `${REFUSAL[door]}${when}`;
}

// --- In memory: without migration 116 ---------------------------------------

type MemoryUse = { at: number; accountId: string; workspaceId: string | null };
const memoryUses = new Map<SpendDoor, MemoryUse[]>();
const memoryResults = new Map<string, { at: number; value: unknown }>();
const MEMORY_KEEP_MS = 2 * DAY * 1000;

function takeInMemory(door: SpendDoor, accountId: string, workspaceId: string | null, limits: DoorLimit[], now: number): DoorTake {
  const all = (memoryUses.get(door) ?? []).filter((u) => now - u.at < MEMORY_KEEP_MS);
  for (const limit of limits) {
    // A site limit with no site is skipped, as the database skips it.
    if (limit.scope === "workspace" && workspaceId === null) continue;
    const since = limit.windowSeconds === null ? -Infinity : now - limit.windowSeconds * 1000;
    const used = all.filter(
      (u) => u.at > since && (limit.scope === "account" ? u.accountId === accountId : u.workspaceId === workspaceId),
    ).length;
    if (used >= limit.limit) {
      memoryUses.set(door, all);
      return { allowed: false, limit, message: doorRefusal(door, limit) };
    }
  }
  all.push({ at: now, accountId, workspaceId });
  memoryUses.set(door, all);
  return { allowed: true, useId: null };
}

/** For the test suite: forget every use and result counted in memory. */
export function resetDoorMemory(): void {
  memoryUses.clear();
  memoryResults.clear();
}

// --- The database ------------------------------------------------------------

export interface DoorDeps {
  /** The service-role client. Null: count in memory. */
  db?: SupabaseClient | null;
  now?: () => number;
}

function dbOf(deps: DoorDeps): SupabaseClient | null {
  return deps.db === undefined ? spendClient() : deps.db;
}

/**
 * Count one press of `door`, or refuse it. A refusal names the limit it hit
 * and carries the sentence to show; nothing is counted then.
 */
export async function takeDoor(
  door: SpendDoor,
  who: { accountId: string; workspaceId?: string | null },
  opts: { preTrial?: boolean } = {},
  deps: DoorDeps = {},
): Promise<DoorTake> {
  const limits = doorLimits(door, opts);
  const workspaceId = who.workspaceId ?? null;
  const now = (deps.now ?? Date.now)();
  const db = dbOf(deps);
  if (db) {
    try {
      const { data, error } = await db.rpc("take_spend_door", {
        p_account: who.accountId,
        p_workspace: workspaceId,
        p_door: door,
        p_limits: limits.map((l) => ({ scope: l.scope, limit: l.limit, seconds: l.windowSeconds })),
      });
      if (!error) {
        const row = (Array.isArray(data) ? data[0] : data) as { use_id?: string | null; refused_index?: number | null } | null;
        if (row && row.use_id) return { allowed: true, useId: row.use_id };
        const hit = limits[row?.refused_index ?? 0] ?? limits[0];
        return { allowed: false, limit: hit, message: doorRefusal(door, hit) };
      }
      console.warn(`[spend-doors] ${door}: counting in memory (${error.message})`);
    } catch (err) {
      console.warn(`[spend-doors] ${door}: counting in memory (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return takeInMemory(door, who.accountId, workspaceId, limits, now);
}

const memoryKey = (door: SpendDoor, workspaceId: string, key: string) => `${door}\u0000${workspaceId}\u0000${key}`;

/**
 * What an earlier press of `door` on this site bought for the same input,
 * when it is younger than `keepSeconds`; null otherwise. Never throws: a
 * cache that cannot be read is a cache miss, and the press is counted.
 */
export async function readDoorCache<T>(
  door: SpendDoor,
  workspaceId: string,
  key: string,
  keepSeconds: number = WIZARD_READ_KEEP_SECONDS,
  deps: DoorDeps = {},
): Promise<T | null> {
  const now = (deps.now ?? Date.now)();
  const db = dbOf(deps);
  if (db) {
    try {
      const { data, error } = await db
        .from("spend_door_uses")
        .select("result")
        .eq("workspace_id", workspaceId)
        .eq("door", door)
        .eq("cache_key", key)
        .not("result", "is", null)
        .gte("used_at", new Date(now - keepSeconds * 1000).toISOString())
        .order("used_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!error) return ((data as { result?: T } | null)?.result ?? null) as T | null;
    } catch {
      // Fall through to memory.
    }
  }
  const hit = memoryResults.get(memoryKey(door, workspaceId, key));
  return hit && now - hit.at < keepSeconds * 1000 ? (hit.value as T) : null;
}

/** Keep what a counted press bought, for `readDoorCache`. Never throws. */
export async function keepDoorResult(
  door: SpendDoor,
  workspaceId: string,
  key: string,
  useId: string | null,
  value: unknown,
  deps: DoorDeps = {},
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  memoryResults.set(memoryKey(door, workspaceId, key), { at: now, value });
  const db = dbOf(deps);
  if (!db || !useId) return;
  try {
    await db.from("spend_door_uses").update({ cache_key: key, result: value }).eq("id", useId);
  } catch {
    // The memory copy above still serves this instance.
  }
}

/**
 * A short, stable key for an input: the same input always gives the same key.
 * FNV-1a over the JSON, with object keys sorted so property order does not
 * matter. Not a security boundary: it only decides whether two presses asked
 * the same question.
 */
export function inputKey(value: unknown): string {
  const json = stableJson(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}:${json.length}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
