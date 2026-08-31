import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireAuth } from "@/lib/auth/require-auth";

/**
 * In-app feedback, emailed rather than stored.
 *
 * The screenshot is forwarded as an attachment and never written anywhere: not
 * to the database, not to object storage, not to a log line. A screenshot of a
 * dashboard contains whatever the person had on screen - client domains,
 * keywords, draft copy - and keeping a copy of that to read a bug report would
 * be collecting data we have no reason to hold.
 *
 * It follows that this endpoint has no history and nothing to show in the UI.
 * That is the trade, and it is the right way round.
 */

const FEEDBACK_TO = process.env.FEEDBACK_EMAIL ?? "helloaltorank@gmail.com";

/** Screenshots are dataURL-encoded PNGs; anything past this is not a screenshot. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4000;

export async function POST(request: Request) {
  let user;
  try {
    ({ user } = await requireAuth());
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (!process.env.RESEND_API_KEY) {
    // Say which key, because "could not send" sends someone reading the wrong
    // code path.
    return NextResponse.json(
      { error: "Feedback email is not configured on this deployment (RESEND_API_KEY)." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    message?: string;
    screenshot?: string;
    path?: string;
  } | null;

  const message = (body?.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "Write something first." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ error: "That is too long to send." }, { status: 400 });
  }

  const attachments: { filename: string; content: string }[] = [];
  const shot = body?.screenshot;
  if (shot?.startsWith("data:image/")) {
    const base64 = shot.slice(shot.indexOf(",") + 1);
    // Rough decoded size; base64 is 4 chars per 3 bytes.
    if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: "The screenshot is too large to email." },
        { status: 413 },
      );
    }
    attachments.push({ filename: "screenshot.png", content: base64 });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL ?? "AltoRank <onboarding@resend.dev>",
      to: FEEDBACK_TO,
      // Reply goes straight back to the person who wrote it.
      replyTo: user.email ?? undefined,
      subject: `Feedback from ${user.email ?? user.id}`,
      text: [
        message,
        "",
        "—",
        `From: ${user.email ?? user.id}`,
        `Page: ${body?.path ?? "unknown"}`,
        attachments.length ? "Screenshot attached." : "No screenshot attached.",
      ].join("\n"),
      attachments,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not send it" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
