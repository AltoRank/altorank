"use server";

// Thin wrapper: the composition lives in lib/audit/readiness-report so the CLI
// and the MCP server can use it without touching app/. A "use server" module
// may only export async functions, so the types live there too.
//
// Public on purpose - it runs on any domain, with no workspace and no account,
// and it is the top of the funnel. That also makes it an unauthenticated
// endpoint that performs several outbound fetches against a caller-named host,
// so it is rate-limited per address the way the other free tools are. It had
// no limit of any kind: one caller could point our servers at anything, as
// fast as they liked.

import { headers } from "next/headers";
import { buildReadinessReport, type ReadinessReport } from "@/lib/audit/readiness-report";
import { checkToolRateLimit } from "@/lib/tools/rate-limit";
import { clientIp } from "@/lib/tools/client-ip";

const SLUG = "agent-readiness";
const LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;

export async function checkReadiness(domain: string): Promise<ReadinessReport> {
  const ip = clientIp(await headers());
  if (!checkToolRateLimit(SLUG, ip, LIMIT, WINDOW_MS)) {
    throw new Error(`Rate limit reached — ${LIMIT} checks per hour. Try again later.`);
  }
  return buildReadinessReport(domain);
}
