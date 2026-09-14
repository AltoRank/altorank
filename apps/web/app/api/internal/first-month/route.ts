import { after, NextResponse } from "next/server";
import { authorised } from "@/lib/content/fan-out";
import { createServiceClient } from "@/lib/supabase/server";
import { prepareFirstMonthStep } from "@/lib/onboarding/first-month";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body?.workspaceId !== "string" || !/^[\da-f-]{36}$/i.test(body.workspaceId)) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  const db = createServiceClient();
  const claim = await db.rpc("claim_first_month", { p_workspace: body.workspaceId });
  if (claim.error) return NextResponse.json({ error: "Could not claim preparation" }, { status: 500 });
  if (claim.data) after(() => prepareFirstMonthStep(db, body.workspaceId, claim.data));
  return NextResponse.json({ status: claim.data ? "accepted" : "already-running-or-finished" }, { status: 202 });
}
