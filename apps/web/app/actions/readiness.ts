"use server";

// Thin wrapper: the composition lives in lib/audit/readiness-report so the CLI
// and the MCP server can use it without touching app/. A "use server" module
// may only export async functions, so the types live there too.

import { buildReadinessReport, type ReadinessReport } from "@/lib/audit/readiness-report";

export async function checkReadiness(domain: string): Promise<ReadinessReport> {
  return buildReadinessReport(domain);
}
