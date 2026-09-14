import { after, NextResponse } from "next/server";
import { authorised } from "@/lib/content/fan-out";
import { createWorkerClient } from "@/lib/onboarding/worker-client";
import { prepareOnboardingChoices } from "@/lib/onboarding/choice-preparation";

export const maxDuration = 300;

export async function POST(request: Request) {
  const startedAt = Date.now();
  if (!authorised(request)) return NextResponse.json({error:"Unauthorized"},{status:401});
  let body;
  try { body=await request.json(); } catch { return NextResponse.json({error:"Invalid JSON"},{status:400}); }
  if (typeof body?.runId!=="string" || !/^[\da-f-]{36}$/i.test(body.runId)) return NextResponse.json({error:"runId required"},{status:400});
  const db=createWorkerClient(startedAt + 285_000);
  const claim=await db.rpc("claim_onboarding_choices",{p_run:body.runId});
  if (claim.error) return NextResponse.json({error:"Could not claim source preparation"},{status:500});
  if (claim.data) after(()=>prepareOnboardingChoices(db,body.runId,claim.data,{deadline:startedAt + 180_000}));
  return NextResponse.json({status:claim.data?"accepted":"already-running-or-finished"},{status:202});
}
