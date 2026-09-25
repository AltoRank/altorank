// ---------------------------------------------------------------------------
// The errors a public tool can answer with
// ---------------------------------------------------------------------------
//
// Every failure reaches the caller as `{ ok: false, error, code }`. `error` is
// a sentence a visitor can read on the page; `code` is what a script
// branches on. A tool throws a ToolError with the right code; anything else
// it throws is a bug and is answered as `unknown` (500) with a generic
// sentence, so an internal message never leaks to an anonymous caller.

export type ToolErrorCode =
  | "invalid_input" // 400: the input is wrong, or names something we will not fetch
  | "not_found" // 404: no tool by that slug
  | "rate_limited" // 429: this connection has used its allowance for this tool
  | "daily_cap" // 429: the paid tools have spent today's budget
  | "upstream" // 502: the site, or a provider we call, failed or timed out
  | "unknown"; // 500: our bug

export const STATUS_BY_CODE: Record<ToolErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  rate_limited: 429,
  daily_cap: 429,
  upstream: 502,
  unknown: 500,
};

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export const DAILY_CAP_MESSAGE =
  "This tool is resting until tomorrow. It has done all the work it can for today; the free fetch-based tools still run.";
