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
  | "auth_required" // 401: paid tools only: nobody is signed in
  | "email_unverified" // 403: paid tools only: signed in, email not confirmed yet
  | "rate_limited" // 429: this connection has used its allowance for this tool
  | "user_cap" // 429: paid tools only: this account has used today's runs
  | "daily_cap" // 429: the paid tools have spent today's budget
  | "upstream" // 502: the site, or a provider we call, failed or timed out
  | "unknown"; // 500: our bug

export const STATUS_BY_CODE: Record<ToolErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  auth_required: 401,
  email_unverified: 403,
  rate_limited: 429,
  user_cap: 429,
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

export const AUTH_REQUIRED_MESSAGE =
  "This tool needs a free AltoRank account. Sign up or sign in, then run it again.";

export const EMAIL_UNVERIFIED_MESSAGE =
  "Confirm your email first: open the link we sent when you signed up, then run the tool again.";
