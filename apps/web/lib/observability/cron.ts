// ---------------------------------------------------------------------------
// Every cron run, written down
// ---------------------------------------------------------------------------
//
// Eleven scheduled routes (vercel.json) each answer with a JSON body that
// describes exactly what they did — how many workspaces were considered, what
// was published, which ones errored and why. All eleven of those bodies go to
// Vercel's scheduler, which reads none of them, and then nowhere.
//
// Worse, a cron that *stops firing* is completely invisible. There is no row
// anywhere that says "publish ran at 09:00 and had nothing to do", so a
// disabled schedule, an expired CRON_SECRET or a deployment that never
// registered the job all look identical to a quiet week.
//
// `observedCron` wraps a route handler and writes one `system_events` row per
// invocation:
//
//   error  the handler threw, or answered 5xx — nothing ran
//   warn   it ran and reported per-item failures (`errors: 3`, or results
//          carrying `status: "error"`)
//   info   it ran clean; the counts are in `context`, so "when did publish
//          last run, and what did it do" is a query
//
// The wrapper cannot change what the route returns, and cannot fail it: the
// body is read from a clone, everything is inside a try, and `recordEvent`
// never throws. A 401 is not recorded — these URLs are public and get probed,
// and a log full of bot traffic is a log nobody reads.

import { recordEvent, describe } from "./record";

/** Fields a cron body might use for its own error/skip counts. */
interface CronBody {
  error?: unknown;
  errors?: unknown;
  results?: unknown;
  [key: string]: unknown;
}

/** Keys worth keeping from a cron body: counts and flags, never the payload. */
const SUMMARY_LIMIT = 20;

function summarize(body: CronBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, value] of Object.entries(body)) {
    if (n >= SUMMARY_LIMIT) break;
    // `results` is the per-item detail and can be hundreds of rows. Only its
    // length is kept here; the failures inside it are extracted separately.
    if (key === "results") {
      out.results_count = Array.isArray(value) ? value.length : 0;
      n += 1;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      out[key] = value;
      n += 1;
    } else if (Array.isArray(value)) {
      out[`${key}_count`] = value.length;
      n += 1;
    }
  }
  return out;
}

/** The per-item failures a run reported, capped so one bad night is one row. */
function failures(body: CronBody): { count: number; first: string[] } {
  const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  const bad = rows.filter((r) => r && typeof r === "object" && (r.status === "error" || r.error));
  const first = bad.slice(0, 5).map((r) => {
    const where = r.workspaceId ?? r.articleId ?? r.domain ?? "";
    const why = r.error ?? r.detail ?? "unknown";
    return where ? `${String(where)}: ${String(why)}` : String(why);
  });
  return { count: bad.length, first };
}

/**
 * Read a response body without disturbing the response itself.
 *
 * `clone()` on a JSON response Next has already built is cheap, and the whole
 * thing is inside a try because a non-JSON body (a redirect, a stream) must
 * end the observation and nothing else.
 */
async function readBody(response: Response): Promise<CronBody | null> {
  try {
    return (await response.clone().json()) as CronBody;
  } catch {
    return null;
  }
}

export type CronHandler = (request: Request) => Promise<Response>;

/**
 * Wrap a cron route so its outcome reaches `system_events`.
 *
 * `source` is the dotted name the operator page filters on: `cron.publish`,
 * `cron.generate`. Use the route's own name, unchanged, forever — a renamed
 * source silently splits a year of history in two.
 */
export function observedCron(source: string, handler: CronHandler): CronHandler {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await handler(request);
    } catch (err) {
      await recordEvent({
        level: "error",
        source,
        message: `The run threw: ${describe(err)}`,
        context: { ms: Date.now() - startedAt },
      });
      // The route's own contract is unchanged: Vercel still sees the throw,
      // and still records the invocation as failed.
      throw err;
    }

    try {
      // A public URL that gets probed. Nothing to learn, much to drown in.
      if (response.status === 401) return response;

      const body = (await readBody(response)) ?? {};
      const ms = Date.now() - startedAt;
      const context = { ms, status: response.status, ...summarize(body) };

      if (response.status >= 500 || body.error) {
        await recordEvent({
          level: "error",
          source,
          message: `The run failed: ${String(body.error ?? `HTTP ${response.status}`)}`,
          context,
        });
        return response;
      }

      const { count, first } = failures(body);
      const reported = typeof body.errors === "number" ? body.errors : 0;
      if (count > 0 || reported > 0) {
        await recordEvent({
          level: "warn",
          source,
          message: `The run finished with ${Math.max(count, reported)} failed item(s).`,
          context: { ...context, failures: first },
        });
        return response;
      }

      // The clean run. This row is the only evidence anywhere that the
      // schedule is still firing, which is worth one insert a day.
      await recordEvent({ level: "info", source, message: "Ran.", context });
    } catch (err) {
      // Observation must never be the thing that breaks a cron.
      console.error(`[observability] ${source}: could not observe the run: ${describe(err)}`);
    }

    return response;
  };
}
