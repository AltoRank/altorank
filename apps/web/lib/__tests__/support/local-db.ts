// ---------------------------------------------------------------------------
// The one database a test may touch: the one on this machine
// ---------------------------------------------------------------------------
//
// Every suite that talks to Supabase (the vitest `db` project and the
// Playwright e2e suite) goes through this module, so there is exactly one
// answer to "which database is this about to write to?" and exactly one place
// that refuses the wrong one.
//
// The wrong one is not hypothetical. The main checkout's `.env.local` points at
// the live production project, and two suites used to read it with a
// hand-rolled parser and no host check: running `npm test` there would have
// created and deleted users in production. So:
//
// - Env is loaded the way `next dev` loads it (`@next/env`, development mode,
//   `.env.development.local` first), so a test and the dev server always agree
//   on which Supabase they mean.
// - Any database URL that is set and is not loopback makes the suite THROW. It
//   does not skip: a skip on a misconfigured machine looks exactly like a pass.
// - A URL that is not set, or a local stack that is not answering, is the only
//   reason a db suite may skip, so `npm test` still works on a machine without
//   Docker. In CI that is not allowed either: a job that was given a stack and
//   quietly skipped proved nothing.

import path from "node:path";
import { loadEnvConfig } from "@next/env";

const WEB_DIR = path.resolve(__dirname, "..", "..", "..");

export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Every variable through which a test could reach a database. The app itself
 * only reads the Supabase URL; DATABASE_URL is here because `.env.local` carries
 * the production one for hand-run scripts, and a future db test that opens a
 * Postgres connection must not be able to pick it up by accident.
 */
export const DATABASE_URL_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL"] as const;

export type Env = Record<string, string | undefined>;

/** Returns `url` when it is on this machine; throws, naming the host, when it is not. */
export function assertLoopback(label: string, url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${label} is not a URL (${JSON.stringify(url)}); refusing to run a test against it.`);
  }
  if (!LOCAL_HOSTS.has(host)) {
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

/**
 * Loads `.env*` into process.env exactly as `next dev` would. Vitest runs with
 * NODE_ENV=test, and under "test" @next/env reads `.env.test*` and skips
 * `.env.development.local`, which is the file that points at the local stack;
 * the tests would then disagree with the dev server about which database they
 * mean. So NODE_ENV is lifted for the load and put back after it.
 */
export function loadLocalEnv(dir: string = WEB_DIR): void {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "test") Reflect.deleteProperty(process.env, "NODE_ENV");
  try {
    loadEnvConfig(dir, true, { info: () => {}, error: console.error });
  } finally {
    if (nodeEnv !== undefined) Object.assign(process.env, { NODE_ENV: nodeEnv });
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

async function answers(stack: LocalStack): Promise<boolean> {
  try {
    const res = await fetch(`${stack.url}/auth/v1/health`, {
      headers: { apikey: stack.anon },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * For a db suite: loads the env, refuses anything that is not local, and
 * returns the stack when it answers. Returns null (the suite skips) only when
 * no stack is configured or it is not up, and only outside CI.
 */
export async function connectLocalStack(dir: string = WEB_DIR): Promise<LocalStack | null> {
  loadLocalEnv(dir);
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
