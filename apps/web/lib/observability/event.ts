// ---------------------------------------------------------------------------
// What an event is, and what it is allowed to contain
// ---------------------------------------------------------------------------
//
// The shape and the sanitising, with no database in it. This half of the
// recorder is deliberately importable from anywhere — a route, a server
// action, a unit test, and, harmlessly, a client component that only wanted
// the `SystemEvent` type.
//
// That last one is the reason this file exists. `record.ts` reaches
// `lib/supabase/server.ts`, which imports `next/headers`, so anything that
// pulls the recorder into a client graph fails the build with
// "You're importing a module that depends on next/headers" — pointing at
// Supabase, several hops from the import that actually did it. Splitting the
// pure half off means a module that wants a type, a cap or a redactor never
// drags the service role into the browser bundle. `record.ts` carries an
// import-side guard so the write half cannot drift back either.
//
// Three rules live here, all of them load-bearing:
//
//   never throws       This is instrumentation. A recorder that can fail the
//                      thing it is watching turns one broken publish into a
//                      broken cron run, which is strictly worse than no
//                      instrumentation at all. Every path here — a bad
//                      argument, a value that will not serialise, a cyclic
//                      object — returns something.
//   never leaks        Context comes from error branches, which is exactly
//                      where an Authorization header or an API key ends up by
//                      accident. Anything key-shaped, by name or by value, is
//                      replaced before it is written.
//   never grows        One call site must not be able to write a megabyte of
//                      parsed HTML into the log.
//
// It also strips control bytes. Postgres `text` cannot store U+0000 at all —
// an insert carrying one fails with "unsupported Unicode escape sequence" —
// and this product has string constants made of raw NUL, \x01 and \x02
// (lib/ai/fact-check.ts, lib/keywords/yields.ts). A sentinel reaching a
// message here must not be the reason the record of a failure is lost.

export type EventLevel = "info" | "warn" | "error";

export interface SystemEvent {
  level: EventLevel;
  /** Dotted and stable: `cron.publish`, `email.deliver`, `stripe.webhook`. */
  source: string;
  /** One line a person can read. */
  message: string;
  accountId?: string | null;
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
    account_id: isUuid(event.accountId) ? event.accountId : null,
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
