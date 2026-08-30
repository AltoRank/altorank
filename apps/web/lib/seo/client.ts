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

function getAuthHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    throw new DataForSEOError(
      "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD env vars are required",
      401,
    );
  }

  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
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
      ?.filter((t) => t.status_code !== 20000)
      .map((t) => `[${t.status_code}] ${t.status_message}`);

    throw new DataForSEOError(
      `DataForSEO responded with status ${json.status_code}: ${json.status_message}`,
      json.status_code,
      taskErrors,
    );
  }

  return json;
}

/**
 * POST a JSON body to a DataForSEO endpoint.
 * @param endpoint  e.g. "/keywords_data/google_ads/keywords_for_site/live"
 * @param body      Array of task objects to send
 */
export async function post<T = unknown>(
  endpoint: string,
  body: unknown[],
): Promise<DataForSEOResponse<T>> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return handleResponse<T>(res);
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

  return handleResponse<T>(res);
}
