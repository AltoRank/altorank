// ---------------------------------------------------------------------------
// Write a failure down somewhere a person will find it
// ---------------------------------------------------------------------------
//
// One function, one table (`system_events`, migration 082). Everything that
// currently fails into a `console.error` and a Vercel log nobody tails calls
// this instead — or as well.
//
// **This half is server-only.** It holds the service client, so importing it
// puts `lib/supabase/server.ts` — and with it `next/headers` — into whatever
// graph did the importing. A client component that reached this file through
// three hops of shared helpers is exactly how #172 first failed CI, with an
// error naming Supabase and not the import that caused it.
//
// So: the shape, the caps and the redaction live in `./event`, which is safe
// to import from anywhere. Anything that only wants a `SystemEvent` type, a
// limit or a sanitiser takes it from there. This file is for the write, and
// nothing in a client graph may reach it — `lib/observability/__tests__/
// client-graph.test.ts` walks the imports and fails the build if one does.
// A client component that needs an event recorded goes through a server
// action or a route, which is a boundary Next understands.
//
// Two of the three rules are enforced in `./event`. The third is here:
//
//   never throws       This is instrumentation. A recorder that can fail the
//                      thing it is watching turns one broken publish into a
//                      broken cron run, which is strictly worse than no
//                      instrumentation at all. Every path here — a bad
//                      argument, a missing table, an unreachable database, a
//                      value that will not serialise — resolves.
//   never blocks       The insert is one round trip and callers `await` it at
//                      a point where they are already finishing (the end of a
//                      cron, an error branch that is about to return). It is
//                      never on the path of work a customer is waiting for,
//                      and `recordEventSoon` exists for the call sites that
//                      must not wait even that long.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { buildEventRow, describe, type SystemEvent } from "./event";

// The types travel with the writer, and a type import is erased before it can
// reach a bundle. Everything else — the caps, the redactors, `describe` — is
// imported from ./event directly, on purpose: a re-export here would be a
// second, quieter way for a client component to land on this file.
export type { EventLevel, SystemEvent } from "./event";

/**
 * Write one event. Resolves whatever happens.
 *
 * `true` means the row landed, `false` means it did not and the reason went to
 * the console instead — the caller is welcome to ignore both. It is a return
 * value rather than a throw because every call site here is already in an
 * error branch and has nothing useful to do with a second failure.
 */
export async function recordEvent(event: SystemEvent, client?: SupabaseClient): Promise<boolean> {
  let row: Record<string, unknown>;
  try {
    row = buildEventRow(event);
  } catch (err) {
    console.error("[observability] could not build the event:", describe(err));
    return false;
  }

  try {
    const supabase = client ?? createServiceClient();
    const { error } = await supabase.from("system_events").insert(row);
    if (error) {
      // Most likely: the migration has not been applied yet. Say so once, in
      // the log, and carry on — this must never become the reason a cron 500s.
      console.error(`[observability] ${row.source}: could not record the event: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[observability] ${row.source}: could not record the event: ${describe(err)}`);
    return false;
  }
}

/**
 * Fire and forget, for the one shape of call site that cannot wait: a request
 * that is about to redirect or return, where an extra round trip is latency a
 * person feels.
 *
 * On Vercel the invocation can be frozen before this lands, so it is a weaker
 * promise than `recordEvent` and is used only where the alternative is not
 * recording at all. Never rejects, so it cannot produce an unhandled rejection.
 */
export function recordEventSoon(event: SystemEvent, client?: SupabaseClient): void {
  void recordEvent(event, client);
}
