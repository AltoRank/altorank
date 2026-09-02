// ---------------------------------------------------------------------------
// DataForSEO HTTP client
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.dataforseo.com/v3";

/** Standard envelope returned by every DataForSEO endpoint. */
export type DataForSEOResponse<T = unknown> = {
  version: string;
  status_code: number;
  status_message: string;
  time: string;
  cost: number;
  tasks_count: number;
  tasks_error: number;
  tasks: Array<{
    id: string;
    status_code: number;
    status_message: string;
    time: string;
    cost: number;
    result_count: number;
    path: string[];
    data: unknown;
    result: T[] | null;
  }>;
};

export class DataForSEOError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public taskErrors?: string[],
  ) {
    super(message);
    this.name = "DataForSEOError";
  }
}

/**
 * Whether DataForSEO can authenticate at all.
 *
 * Callers used to each re-derive this from DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD,
 * so an .env holding only the pre-encoded DATAFORSEO_API_KEY reported "credentials
 * not configured" from four different places while the client itself could have
 * authenticated fine. One source of truth, next to the header it gates.
 */
export function hasDataForSEOCredentials(): boolean {
  return Boolean(
    process.env.DATAFORSEO_API_KEY ||
      (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
  );
}

function getAuthHeader(): string {
  // DataForSEO's dashboard hands out a single pre-encoded base64 blob as well
  // as the login/password pair it was built from. Accept either: an .env
  // holding only the blob used to fail closed with a 401 that read as an
  // account problem rather than a missing variable.
  const apiKey = process.env.DATAFORSEO_API_KEY;
  if (apiKey) return "Basic " + apiKey;

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    throw new DataForSEOError(
      "Set DATAFORSEO_API_KEY, or both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD",
      401,
    );
  }

  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

/**
 * A task that succeeded. 20000 is "Ok." on a live call; 20100 is "Task
 * Created." on a queued one, and is just as much a success - the answer is
 * simply not here yet. Treating 20100 as a failure made the client throw on
 * every successful task_post, which is how the first queued SERP submission
 * on 2026-09-02 reported "DataForSEO task failed: Task Created."
 */
function isTaskOk(code: number): boolean {
  return code === 20000 || code === 20100;
}

async function handleResponse<T>(res: Response): Promise<DataForSEOResponse<T>> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DataForSEOError(
      `DataForSEO API error: ${res.status} ${res.statusText} — ${body}`,
      res.status,
    );
  }

  const json = (await res.json()) as DataForSEOResponse<T>;

  if (json.status_code !== 20000) {
    const taskErrors = json.tasks
      ?.filter((t) => !isTaskOk(t.status_code))
      .map((t) => `[${t.status_code}] ${t.status_message}`);

    throw new DataForSEOError(
      `DataForSEO responded with status ${json.status_code}: ${json.status_message}`,
      json.status_code,
      taskErrors,
    );
  }

  // The envelope says 20000 "Ok." even when every task inside it failed: a
  // suspended account, a rate limit, an out-of-credits balance and a malformed
  // parameter all arrive this way, with `result: null`.
  //
  // Checking only the envelope turned all of those into a successful empty
  // response. A suspended account was reported by the research layer as
  // "0 ranking pages, 0 People Also Ask entries, no AI Overview" with status
  // `ok`, so the article prompt was built telling the model there were no
  // competitors, and an article got written blind with nothing anywhere
  // signalling a problem. Observed for real: task 40201, account paused.
  const failed = (json.tasks ?? []).filter((t) => !isTaskOk(t.status_code));
  if (failed.length && failed.length === (json.tasks ?? []).length) {
    throw new DataForSEOError(
      `DataForSEO task failed: ${failed[0].status_message}`,
      failed[0].status_code,
      failed.map((t) => `[${t.status_code}] ${t.status_message}`),
    );
  }

  return json;
}

/**
 * POST a JSON body to a DataForSEO endpoint.
 * @param endpoint  e.g. "/keywords_data/google_ads/keywords_for_site/live"
 * @param body      Array of task objects to send
 */
/**
 * Task statuses worth trying again.
 *
 * `40101 Internal SE Server Error` is DataForSEO's transient search-engine
 * fault and it is common: the same keyword, sent three times in a row, returned
 * Ok / 40101 / Ok. Anything at 50000 and above is a server error on their side.
 *
 * Deliberately narrow. A suspended account (40201), bad credentials, an empty
 * balance or a malformed parameter are all permanent for this call, and
 * retrying them wastes time and money without changing the answer.
 */
function isRetryableTaskStatus(code: number): boolean {
  return code === 40101 || code >= 50000;
}

const MAX_ATTEMPTS = 3;

/**
 * Where to report what a call cost.
 *
 * A callback rather than an import: this module is used from `scripts/` and the
 * MCP server, neither of which has a Supabase client, and making the HTTP layer
 * depend on the database would break both. The app sets this once at startup;
 * everything else keeps working with it unset.
 */
type SpendReporter = (entry: {
  operation: string;
  costUsd: number | null;
}) => void;

let reportSpend: SpendReporter | null = null;

export function setSpendReporter(fn: SpendReporter | null): void {
  reportSpend = fn;
}

/**
 * Every response reports what it cost. Recording it here means no caller can
 * forget, and a new endpoint is covered the day it is added.
 *
 * An armed reporter wins, because it knows the workspace, article and run. With
 * none armed - onboarding, re-discovery, probes, scripts - the default records
 * the call anyway, unattributed. Until 2026-09-02 that branch did nothing, and
 * the provider behind discovery and rank tracking showed as $0 on Operations.
 *
 * The default is loaded lazily so this module stays importable from the test
 * suite and the standalone scripts with no database in the environment.
 */
/**
 * The operation as it should appear in spend: the endpoint, not the task.
 *
 * task_get carries the task id in its path, so recording the path verbatim
 * made every collected SERP its own operation and turned "Spend by operation"
 * into one row per keyword per night. The id is not the operation.
 */
export function spendOperation(endpoint: string): string {
  return endpoint.replace(/\/task_get\/(regular|advanced|html)\/[0-9a-f-]{20,}$/, "/task_get/$1/{id}");
}

function report(operation: string, costUsd: number | null): void {
  operation = spendOperation(operation);
  try {
    if (reportSpend) {
      reportSpend({ operation, costUsd });
      return;
    }
    void import("@/lib/billing/default-spend")
      .then((m) => m.recordSpendByDefault({ provider: "dataforseo", operation, costUsd }))
      .catch(() => {});
  } catch {
    // Never let bookkeeping break the call it is measuring.
  }
}

export async function post<T = unknown>(
  endpoint: string,
  body: unknown[],
): Promise<DataForSEOResponse<T>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const parsed = await handleResponse<T>(res);
      report(endpoint, parsed.cost ?? null);
      return parsed;
    } catch (err) {
      lastError = err;

      // `statusCode` carries either an HTTP status (3 digits) or a DataForSEO
      // status (5 digits), and the two must not be compared with the same rule:
      // `40201 >= 500` is true, so a naive HTTP check retried suspended-account
      // errors three times. Split on magnitude.
      const retryable =
        err instanceof DataForSEOError &&
        (err.statusCode >= 10000
          ? isRetryableTaskStatus(err.statusCode)
          : err.statusCode === 429 || err.statusCode >= 500);

      if (!retryable || attempt === MAX_ATTEMPTS) throw err;

      // A transient SE fault clears in well under a second; this is about
      // riding out a blip, not backing off a rate limit we are hitting hard.
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }

  throw lastError;
}

/**
 * GET from a DataForSEO endpoint.
 * @param endpoint  e.g. "/appendix/user_data"
 */
export async function get<T = unknown>(
  endpoint: string,
): Promise<DataForSEOResponse<T>> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
  });

  const parsed = await handleResponse<T>(res);
  report(endpoint, parsed.cost ?? null);
  return parsed;
}
