import { NextResponse } from "next/server";
import { sendPlainEmail } from "@/lib/email/resend";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { takeToolRateLimit } from "@/lib/tools/rate-limit";

/**
 * "Request integration", emailed rather than stored.
 *
 * The tiles on /connect for platforms we have no adapter for used to end in a
 * disabled button. This is what replaced it: one click, and we get an email
 * saying who wants what. It is the cheapest demand signal available - we find
 * out which connector to build next from the people who would use it, rather
 * than from a roadmap guess.
 *
 * Nothing is written to the database, for the same reason /api/feedback writes
 * nothing: the email carries everything a reply needs, and a table of
 * "integrations people wanted" is a table someone has to maintain, migrate and
 * eventually explain. If the volume ever justifies counting rather than
 * reading, that is the moment to add one - not before.
 *
 * The trade to know about: we cannot show the person a history of what they
 * requested, and we cannot count demand in SQL. Both are deliberate.
 */

const REQUEST_TO = process.env.FEEDBACK_EMAIL ?? "helloaltorank@gmail.com";

/** Per user, not per IP: the identity we rate-limit on is the session. */
const MAX_REQUESTS = 10;
const WINDOW_MS = 60 * 60 * 1000;

const MAX_NOTE_CHARS = 500;

export async function POST(request: Request) {
  let user;
  let agencyId: string;
  try {
    ({ user, agencyId } = await requireAuth());
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // An authenticated person can still hold the button down. Ten an hour is
  // more than anyone needs and far less than an inbox-flood.
  const limit = takeToolRateLimit("integration-request", user.id, MAX_REQUESTS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "That is a lot of requests. Try again later, or email us directly." },
      { status: 429 },
    );
  }

  if (!process.env.RESEND_API_KEY) {
    // Name the key, so whoever reads this is not sent to the wrong code path.
    return NextResponse.json(
      { error: "Requests are not configured on this deployment (RESEND_API_KEY)." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    integrationId?: string;
    integrationName?: string;
    note?: string;
  } | null;

  const integrationId = (body?.integrationId ?? "").trim();
  if (!integrationId || integrationId.length > 64) {
    return NextResponse.json({ error: "Which integration?" }, { status: 400 });
  }
  // The name is display copy from the tile; the id is what we act on.
  const integrationName = (body?.integrationName ?? integrationId).trim().slice(0, 120);
  const note = (body?.note ?? "").trim().slice(0, MAX_NOTE_CHARS);

  // Their site, so the reply can be specific rather than "which of your
  // workspaces did you mean". Never fatal: the request is worth sending
  // without it.
  let domain: string | null = null;
  try {
    const supabase = await createClient();
    const scopeId = await getScopedWorkspaceId();
    if (scopeId) {
      const { data } = await supabase
        .from("workspaces")
        .select("domain")
        .eq("id", scopeId)
        .maybeSingle();
      domain = (data?.domain as string | null) ?? null;
    }
  } catch {
    // Leave it null.
  }

  // Plain text: this email goes to us, not to a customer. Nothing here is
  // rendered as markup, so there is nothing to escape and no template to keep
  // in step with a layout.
  const text = [
    `${integrationName}  (${integrationId})`,
    ``,
    `Requested by: ${user.email}`,
    `Agency:       ${agencyId}`,
    domain ? `Site:         ${domain}` : null,
    note ? `\nNote: ${note}` : null,
    ``,
    `Sent from the Integrations page. Reply to this email to reach them.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  try {
    await sendPlainEmail({
      to: REQUEST_TO,
      subject: `Integration request: ${integrationName} (${user.email})`,
      text,
      ...(user.email ? { replyTo: user.email } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not send that." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
