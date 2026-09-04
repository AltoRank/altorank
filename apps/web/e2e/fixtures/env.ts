// ---------------------------------------------------------------------------
// Where the suite is allowed to point
// ---------------------------------------------------------------------------
//
// Loaded by playwright.config.ts before anything else, so the guard runs before
// a server is started or a row is written. The suite creates and deletes users
// with the service role; the only database it may ever do that to is the local
// one from `supabase start`.

import path from "node:path";
import { loadEnvConfig } from "@next/env";

const WEB_DIR = path.resolve(__dirname, "..", "..");
// Same loader `next dev` uses, same precedence (.env.development.local first),
// so the tests and the server agree on which Supabase they are talking to.
loadEnvConfig(WEB_DIR, true, { info: () => {}, error: console.error });

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function local(label: string, url: string | undefined): string {
  if (!url) {
    throw new Error(`${label} is not set. The e2e suite needs the local Supabase from \`supabase start\` (see e2e/README.md).`);
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`${label} points at ${host}. The e2e suite only runs against localhost; refusing to continue.`);
  }
  return url;
}

export const BASE_URL = local("E2E_BASE_URL", process.env.E2E_BASE_URL ?? "http://localhost:3110");
export const SUPABASE_URL = local("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set; `supabase status -o env` prints the local one.");
export const SERVICE_ROLE_KEY: string = serviceKey;
