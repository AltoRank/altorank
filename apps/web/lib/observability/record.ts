// ---------------------------------------------------------------------------
// Write a failure down somewhere a person will find it
// ---------------------------------------------------------------------------
//
// One function, one table (`system_events`, migration 082). Everything that
// currently fails into a `console.error` and a Vercel log nobody tails calls
// this instead — or as well.
//
// Three rules, all of them load-bearing:
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
//   never leaks        Context comes from error branches, which is exactly
//                      where an Authorization header or an API key ends up by
//                      accident. Anything key-shaped, by name or by value, is
//                      replaced before it is written.
//
// It also strips control bytes. Postgres `text` cannot store U+0000 at all —
// an insert carrying one fails with "unsupported Unicode escape sequence" —
// and this product has string constants made of raw NUL, \x01 and \x02
// (lib/ai/fact-check.ts, lib/keywords/yields.ts). A sentinel reaching a
// message here must not be the reason the record of a failure is lost.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";

export type EventLevel = "info" | "warn" | "error";

export interface SystemEvent {
  level: EventLevel;
  /** Dotted and stable: `cron.publish`, `email.deliver`, `stripe.webhook`. */
  source: string;
  /** One line a person can read. */
  message: string;
  agencyId?: string | null;
  workspaceId?: string | null;
  context?: Record<string, unknown> | null;
}

/** Longest value we will store for each field. Beyond this the tail is dropped. */
export const MAX_MESSAGE = 500;
export const MAX_SOURCE = 120;
/** Serialised `context` cap. Past this the object is replaced with a note. */
export const MAX_CONTEXT_BYTES = 4000;

const REDACTED = "[redacted]";

/**
 * Context keys whose *value* is never worth keeping, whatever it looks like.
 * Matched on the key name, case-insensitively, anywhere in it: `apiKey`,
 * `authorization`, `stripe_secret`, `refresh_token`, `password_hash`.
 */
const SECRET_KEY_NAME = /(key|secret|token|password|passwd|credential|authorization|auth|signature|cookie|session)/i;

/**
 * Values that are credentials wherever they appear, including in the middle of
 * a sentence — which is where they appear, because these strings come from
 * error messages that quoted a request.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // This product's own API keys, and the OAuth-minted ones, which are the same shape.
  /altorank_(?:live|test)_[A-Za-z0-9_\-]+/g,
  // Stripe: secret, restricted and webhook-signing keys. `pk_` is public, and stays.
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9+/=_\-]{8,}/g,
  // Resend, OpenAI/Anthropic-style, GitHub.
  /\bre_[A-Za-z0-9_\-]{16,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_\-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  // A JWT, which is what a Supabase service key and a session token both are.
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
  // Whatever followed a scheme in an Authorization header.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._\-]{12,}/gi,
];

/**
 * Strip the bytes Postgres will not take and normalise the rest.
 *
 * U+0000 is rejected outright by `text` and by `jsonb`; the other C0 controls
 * are storable but turn a log line into something a terminal reinterprets, so
 * they go too. Tab, newline and carriage return survive as a single space:
 * a stack trace should be one readable line here, not eight rows of a table.
 */
export function stripControlBytes(value: string): string {
  return (
    value
      .replace(/[\t\n\r]+/g, " ")
      // Written as \u escapes on purpose. A source file with the byte itself
      // in it is the bug two files in this repo already have: git, grep and
      // most editors then treat the whole file as binary.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

/** Replace anything key-shaped inside a free-text string. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

function clean(value: string, max: number): string {
  const text = redactSecrets(stripControlBytes(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Walk `context` and make it safe to store: secret-named keys lose their
 * value, free text is redacted and de-controlled, and the shape is bounded so
 * one call site cannot write a megabyte of parsed HTML into the log.
 */
export function sanitizeContext(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
  if (typeof input === "boolean") return input;
  if (typeof input === "bigint") return String(input);
  if (typeof input === "string") return clean(input, MAX_MESSAGE);
  if (input instanceof Error) return { name: input.name, message: clean(input.message, MAX_MESSAGE) };
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.toISOString();

  // Four levels is more nesting than any call site here has, and the guard is
  // what stops a cyclic object from being walked forever.
  if (depth >= 4) return REDACTED;

  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => sanitizeContext(item, depth + 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (n >= 50) break;
      n += 1;
      const name = clean(key, 64);
      if (!name) continue;
      out[name] = SECRET_KEY_NAME.test(key) ? REDACTED : sanitizeContext(value, depth + 1);
    }
    return out;
  }
  // A function, a symbol: nothing a log wants.
  return REDACTED;
}

/** The row we would insert, with every rule above already applied. */
export function buildEventRow(event: SystemEvent): Record<string, unknown> {
  const level: EventLevel = event.level === "error" || event.level === "warn" ? event.level : "info";
  const source = clean(event.source ?? "", MAX_SOURCE) || "unknown";
  // An empty message is a call site that had nothing but still wants the row
  // counted; say so rather than write "" and make the page look broken.
  const message = clean(event.message ?? "", MAX_MESSAGE) || "(no message)";

  let context: unknown = sanitizeContext(event.context ?? {});
  let serialised = "{}";
  try {
    serialised = JSON.stringify(context) ?? "{}";
  } catch {
    // Cyclic, or a value with a throwing toJSON. The event still gets written.
    context = { note: "context could not be serialised" };
    serialised = JSON.stringify(context)!;
  }
  if (serialised.length > MAX_CONTEXT_BYTES) {
    context = { note: `context omitted: ${serialised.length} characters, over the ${MAX_CONTEXT_BYTES} cap` };
  }

  return {
    level,
    source,
    message,
    agency_id: isUuid(event.agencyId) ? event.agencyId : null,
    workspace_id: isUuid(event.workspaceId) ? event.workspaceId : null,
    context,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both id columns are real foreign keys, so a caller passing "unknown" or an
 * empty string would make the insert fail — which, for instrumentation, means
 * losing the event to protect a column nobody reads. Anything that is not a
 * UUID becomes null and the value, if there was one, is kept in `context`.
 */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

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

/** An error's message, whatever it turned out to be. */
export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
