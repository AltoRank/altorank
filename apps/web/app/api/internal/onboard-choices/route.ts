import { after, NextResponse } from "next/server";
import { authorised } from "@/lib/content/fan-out";
import { createServiceClient } from "@/lib/supabase/server";
import { prepareOnboardingChoices } from "@/lib/onboarding/choice-preparation";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!authorised(request)) return NextResponse.json({error:"Unauthorized"},{status:401});
  let body;
  try { body=await request.json(); } catch { return NextResponse.json({error:"Invalid JSON"},{status:400}); }
  if (typeof body?.runId!=="string" || !/^[\da-f-]{36}$/i.test(body.runId)) return NextResponse.json({error:"runId required"},{status:400});
  const db=createServiceClient();
  const claim=await db.rpc("claim_onboarding_choices",{p_run:body.runId});
  if (claim.error) return NextResponse.json({error:"Could not claim source preparation"},{status:500});
  if (claim.data) after(()=>prepareOnboardingChoices(db,body.runId,claim.data));
  return NextResponse.json({status:claim.data?"accepted":"already-running-or-finished"},{status:202});
}
