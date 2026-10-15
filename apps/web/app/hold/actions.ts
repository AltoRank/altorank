"use server";

import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { readHoldParams } from "@/lib/publishing/hold-link";
import { applyEmailHold, resolveEmailHold } from "@/lib/publishing/hold-from-email";

/**
 * The write behind /hold's "Hold it" button. The hidden fields come from the
 * browser, so the form is exactly as forgeable as the URL was: the signature
 * is checked again here, and so is everything the page checked, because the
 * draft may have moved between the page and the press.
 */
export async function holdFromEmail(formData: FormData): Promise<void> {
  const a = String(formData.get("a") ?? "");
  const e = String(formData.get("e") ?? "");
  const s = String(formData.get("s") ?? "");
  const parsed = readHoldParams(new URLSearchParams({ a, e, s }));
  const back = `/hold?a=${encodeURIComponent(a)}&e=${encodeURIComponent(e)}&s=${encodeURIComponent(s)}`;
  if (!parsed.ok) redirect(back);

  const supabase = createServiceClient();
  const hold = await resolveEmailHold(supabase, parsed.articleId, parsed.email);
  if (hold.kind === "ready") {
    const { error } = await applyEmailHold(supabase, hold);
    if (error) redirect(`${back}&failed=1`);
  }
  redirect(back);
}
