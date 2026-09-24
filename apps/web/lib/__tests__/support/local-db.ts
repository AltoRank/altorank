// ---------------------------------------------------------------------------
// The one database a test may touch: the one on this machine
// ---------------------------------------------------------------------------
//
// The db tier (the vitest `db` project) and the Playwright e2e suite find the
// local Supabase through this module, so there is one answer to "which
// database is this about to write to?" and one readable place that refuses the
// wrong one.
//
// The wrong one is not hypothetical. The main checkout's `.env.local` points at
// the live production project, and two suites used to read it with a
// hand-rolled parser and no host check: running `npm test` there would have
// created and deleted users in production. So:
//
// - Only the three values a test needs to reach the local stack are taken
//   from the env files: its URL, its anon key and its service key. They come
//   from the files `next dev` reads, in the order it reads them
//   (`.env.development.local` first), so a test and the dev server agree on
//   which Supabase they mean. Nothing else in those files is imported: the
//   main checkout's `.env.local` also holds live Stripe, Resend, DataForSEO
//   and model keys, and a db test has no business holding any of them.
// - Any database URL that is set and is not loopback makes the suite THROW. It
//   does not skip: a skip on a misconfigured machine looks exactly like a pass.
// - A URL that is not set, or a local stack that is not answering, is the only
//   reason a db suite may skip, so `npm test` still works on a machine without
//   Docker. In CI that is not allowed either: a job that was given a stack and
//   quietly skipped proved nothing.
//
// This is the early, readable check. The boundary itself is the network guard
// (./network-guard.ts), which both vitest projects install before any test
// file loads and which refuses the connection whatever URL a test found, from
// this module or anywhere else.
//
// It must stay free of vitest imports: e2e/fixtures/env.ts loads it into the
// Playwright process.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const WEB_DIR = path.resolve(__dirname, "..", "..", "..");

export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** True for a hostname that can only mean this machine. Exact match, so `127.0.0.1.nip.io` is not one. */
export function isLoopbackHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/**
 * Every variable through which a test could reach a database. The app itself
 * only reads the Supabase URL; DATABASE_URL is here because `.env.local` carries
 * the production one for hand-run scripts, and a shell that exported it must
 * not be able to hand it to a test.
 */
export const DATABASE_URL_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL"] as const;

/**
 * The only variables the loader takes from an env file: what a db test needs
 * to reach the local stack and nothing more. A future test that opens Postgres
 * directly adds DATABASE_URL here on purpose, and assertLocalEnv checks it.
 */
export const LOCAL_STACK_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/** The files `next dev` reads, highest precedence first (@next/env in development mode). */
export const DEV_ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"] as const;

export type Env = Record<string, string | undefined>;

/** Returns `url` when it is on this machine; throws, naming the host, when it is not. */
export function assertLoopback(label: string, url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${label} is not a URL (${JSON.stringify(url)}); refusing to run a test against it.`);
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      `${label} points at ${host}. Tests only ever run against this machine (the local stack from ` +
        `\`supabase start\`, a dev server on localhost); refusing to continue. If this came from .env.local, ` +
        `put the local values in .env.development.local, which takes precedence.`,
    );
  }
  return url;
}

/**
 * Checks every database URL in `env` and throws on the first one that is set
 * and not loopback. Pure, so the guard itself is unit-tested without touching
 * a file or a network.
 */
export function assertLocalEnv(env: Env): void {
  for (const name of DATABASE_URL_VARS) {
    const value = env[name];
    if (value) assertLoopback(name, value);
  }
}

function readEnvFile(file: string): Env {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return parseEnv(contents);
}

/**
 * The local-stack values as `next dev` in `dir` would see them: a value
 * already in `env` (the shell) wins, then the first file in DEV_ENV_FILES that
 * sets it. Only LOCAL_STACK_VARS are returned, whatever else the files hold.
 *
 * Pure apart from reading the files, so the precedence and the allowlist are
 * tested against a temporary directory. Values are taken literally: a
 * `${VAR}` reference is not expanded, and a URL written that way is refused as
 * "not a URL" rather than guessed at.
 */
export function localEnvFrom(dir: string, env: Env): Env {
  const files = DEV_ENV_FILES.map((name) => readEnvFile(path.join(dir, name)));
  const out: Env = {};
  for (const name of LOCAL_STACK_VARS) {
    out[name] = env[name] ?? files.find((file) => file[name] !== undefined)?.[name];
  }
  return out;
}

/**
 * Puts the local-stack values from apps/web's env files into process.env,
 * where the app's own clients (createServiceClient and friends) read them.
 * Anything the shell already set is left alone, as `next dev` leaves it.
 */
export function loadLocalEnv(): void {
  for (const [name, value] of Object.entries(localEnvFrom(WEB_DIR, process.env))) {
    if (value !== undefined) process.env[name] = value;
  }
}

export type LocalStack = { url: string; anon: string; service: string };

/**
 * The local Supabase described by `env`, or null when none is configured.
 * Throws when any database URL in `env` is not loopback, before looking at
 * whether the rest is complete: a production URL with a missing key is still
 * a production URL.
 */
export function localStackFrom(env: Env): LocalStack | null {
  assertLocalEnv(env);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return null;
  return { url, anon, service };
}

/** The network guard's refusal, as fetch or undici reports it. */
function refusedByGuard(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return (
    code(err) === "ERR_TEST_NETWORK_GUARD" ||
    code((err as { cause?: unknown } | null)?.cause) === "ERR_TEST_NETWORK_GUARD"
  );
}

async function answers(stack: LocalStack): Promise<boolean> {
  try {
    const res = await fetch(`${stack.url}/auth/v1/health`, {
      headers: { apikey: stack.anon },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch (err) {
    // A stack that is down is a reason to skip; a health check the network
    // guard refused is not. That only happens when this runs outside the db
    // tier (a db test with the wrong file name, in the unit tier), and there
    // a skip would hide it: every test in the file would skip, vitest would
    // not run the file's afterAll, and the refusal would never be reported.
    if (refusedByGuard(err)) throw err;
    return false;
  }
}

/**
 * For a db suite: loads the env, refuses anything that is not local, and
 * returns the stack when it answers. Returns null (the suite skips) only when
 * no stack is configured or it is not up, and only outside CI.
 */
export async function connectLocalStack(): Promise<LocalStack | null> {
  loadLocalEnv();
  const stack = localStackFrom(process.env);
  const live = stack ? await answers(stack) : false;
  if (stack && live) return stack;
  if (process.env.CI) {
    throw new Error(
      stack
        ? `The local Supabase at ${stack.url} is not answering. CI starts it before the db suite; a skip here would pass without testing anything.`
        : "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be exported before the db suite runs in CI.",
    );
  }
  return null;
}
