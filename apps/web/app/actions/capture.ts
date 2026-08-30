"use server";

import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { sendToolResultEmail } from "@/lib/email/resend";

const captureSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  toolSlug: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  sendEmail: z.boolean().optional(),
  emailSubject: z.string().optional(),
  emailBody: z.string().optional(),
});

export type CaptureState = {
  success: boolean;
  error?: string;
};

export async function captureToolLead(
  _prevState: CaptureState,
  formData: FormData,
): Promise<CaptureState> {
  const parsed = captureSchema.safeParse({
    email: formData.get("email"),
    toolSlug: formData.get("toolSlug"),
    context: formData.get("context")
      ? JSON.parse(formData.get("context") as string)
      : undefined,
    sendEmail: formData.get("sendEmail") === "true",
    emailSubject: formData.get("emailSubject"),
    emailBody: formData.get("emailBody"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { email, toolSlug, context, sendEmail, emailSubject, emailBody } =
    parsed.data;

  try {
    const supabase = createServiceClient();

    await supabase.from("tool_leads").insert({
      email,
      tool_slug: toolSlug,
      context: context ?? {},
    });

    if (sendEmail && emailSubject && emailBody) {
      await sendToolResultEmail(email, emailSubject, emailBody);
    }

    return { success: true };
  } catch (err) {
    console.error("[capture]", err);
    return {
      success: false,
      error: "Something went wrong. Please try again.",
    };
  }
}
