// ---------------------------------------------------------------------------
// The response envelope every agent-facing surface speaks
// ---------------------------------------------------------------------------
//
// MCP tool results, the HTTP agent API and the CLI all return exactly this
// shape, so an agent learns one contract:
//
//   { ok: true,  data, agent_guidance, _human?, _meta? }
//   { ok: false, error: { code, message }, agent_guidance }
//
// `agent_guidance` is one or two sentences addressed to the agent: what to do
// next on success, how to recover on failure. It is the part a bare JSON API
// leaves the model to guess. `_human` is an optional presentation block for
// settings-like resources, so the agent can summarise a record to a person
// with labels instead of column names.
//
// No Next imports. Pure data.

export type AgentErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "quota_exceeded"
  | "not_available"
  | "upstream_error"
  | "internal_error";

export type HumanOption = { label: string; selected: boolean };

export type HumanItem = {
  /** Machine field name, for the agent's own cross-reference. */
  field: string;
  /** What to call it when talking to a person. */
  label: string;
  /** The value, already rendered for a person. Unknown renders as "—". */
  value_label: string;
  description?: string;
  available_options?: HumanOption[];
};

export type HumanSection = { label: string; items: HumanItem[] };

export type HumanPresentation = {
  title: string;
  summary_instructions: string;
  sections: HumanSection[];
};

export type EnvelopeMeta = {
  /** Fields an agent may change through this surface. Empty means read-only. */
  writeable_fields: string[];
  /** Bookkeeping the summary should leave out unless a person asks. */
  hidden_from_human_summary_fields: string[];
  human_presentation_rules: string[];
};

export type OkEnvelope<T> = {
  ok: true;
  data: T;
  agent_guidance: string;
  _human?: HumanPresentation;
  _meta?: EnvelopeMeta;
};

export type FailEnvelope = {
  ok: false;
  error: { code: AgentErrorCode; message: string };
  agent_guidance: string;
};

export type Envelope<T = unknown> = OkEnvelope<T> | FailEnvelope;

/** The rules every `_meta` block carries. Stated once, here. */
export const HUMAN_PRESENTATION_RULES: readonly string[] = [
  "Use labels, not snake_case field names.",
  "Use enum labels, not raw stored values.",
  "Do not surface bookkeeping ids unless asked.",
  "Render unknown values as — (em dash), never as 0.",
];

export function ok<T>(
  data: T,
  agent_guidance: string,
  extras: { _human?: HumanPresentation; _meta?: Partial<EnvelopeMeta> } = {},
): OkEnvelope<T> {
  const env: OkEnvelope<T> = { ok: true, data, agent_guidance };
  if (extras._human) env._human = extras._human;
  if (extras._meta) {
    env._meta = {
      writeable_fields: extras._meta.writeable_fields ?? [],
      hidden_from_human_summary_fields: extras._meta.hidden_from_human_summary_fields ?? [],
      human_presentation_rules: extras._meta.human_presentation_rules ?? [...HUMAN_PRESENTATION_RULES],
    };
  }
  return env;
}

export function fail(code: AgentErrorCode, message: string, agent_guidance: string): FailEnvelope {
  return { ok: false, error: { code, message }, agent_guidance };
}

/** HTTP status each error code maps to. The CLI and MCP ignore this. */
export const ERROR_STATUS: Record<AgentErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  quota_exceeded: 402,
  not_available: 409,
  upstream_error: 502,
  internal_error: 500,
};

// ---------------------------------------------------------------------------
// Guidance the surfaces share, so a revoked key says the same thing over HTTP,
// from the CLI and inside an MCP result.
// ---------------------------------------------------------------------------

export const GUIDANCE = {
  missingKey:
    "No API key was sent. Ask the human to create one at /settings/api-keys, " +
    "export it as ALTORANK_API_KEY and retry.",
  malformedKey:
    "The Authorization header is not a valid AltoRank key. Keys start with " +
    "altorank_live_. Check ALTORANK_API_KEY for truncation or quoting and retry.",
  unknownKey:
    "This API key is not recognised. Ask the human to check it was copied in full " +
    "from /settings/api-keys, or to create a new one, then retry.",
  revokedKey:
    "This API key was revoked. Ask the human to create a new one at " +
    "/settings/api-keys, export it as ALTORANK_API_KEY and retry.",
  expiredKey:
    "This API key has expired. Ask the human to create a new one at " +
    "/settings/api-keys, export it as ALTORANK_API_KEY and retry.",
  missingScope: (scope: string) =>
    `This key lacks the "${scope}" scope. Ask the human to create a key that includes it at /settings/api-keys.`,
  rateLimited: (retryAfterSeconds: number) =>
    `Rate limit reached for this key. Wait ${retryAfterSeconds}s (see Retry-After) before the next request, and batch reads where possible.`,
  humanOnly:
    "Publishing and approval are human actions. Hand the person the editor_url " +
    "and stop; do not look for another way to publish.",
} as const;

/** "—" for anything unmeasured. Rule 5: unknown is not zero. */
export function valueLabel(value: unknown, unit = ""): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return `${String(value)}${unit}`;
}
