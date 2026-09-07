// ---------------------------------------------------------------------------
// One email a day, only when there is something to say
// ---------------------------------------------------------------------------
//
// A log nobody opens is the same as no log. `/admin/events` is a page an
// operator has to think to visit, and the whole failure this work exists to
// fix is that nobody thought to look.
//
// So: the errors and warnings of the last day, grouped by source, to whoever
// `ADMIN_EMAILS` says the operators are. Deliberately small — it is a nudge to
// open the page, not a replacement for it.
//
// It sends nothing at all when there is nothing to send. Three no-ops, all
// quiet, all returning a reason rather than throwing:
//
//   no operators   ADMIN_EMAILS unset, or set to empty. Both mean nobody has
//                  said where operational mail should go, and this sends none.
//                  It deliberately does not use the `ADMIN_EMAILS` constant,
//                  which falls back to the AltoRank address: that fallback is
//                  a gate for /admin/*, and reusing it here would make every
//                  deployment of this public repo mail one personal Gmail
//                  account. `operatorRecipients()` has no default.
//   no mail        RESEND_API_KEY unset — a self-hosted install with no mail
//                  provider must not have a cron that fails every morning.
//   nothing wrong  a clean day sends no email. An operator who gets one of
//                  these knows, without reading it, that something happened.

import type { SupabaseClient } from "@supabase/supabase-js";
import { operatorRecipients } from "@/lib/auth/operators";
import { sendOnce, type SendOnceOutcome } from "@/lib/email/send-once";
import { emailButton, emailParagraph, EMAIL_INK, EMAIL_INK_2, EMAIL_INK_3 } from "@/lib/email/layout";
import { appLink } from "@/lib/app-url";

/** The window the digest covers, and the only period it claims to describe. */
export const DIGEST_HOURS = 24;
/** Sources listed in full before the rest are summed into one line. */
const MAX_GROUPS = 12;
/** Example messages shown under each source. */
const MAX_EXAMPLES = 2;

export type DigestOutcome =
  | { sent: false; reason: string }
  | { sent: true; errors: number; warnings: number; outcome: SendOnceOutcome };

type EventRow = { level: string; source: string; message: string; created_at: string };

/** Every string below is a provider's error text, so it is escaped like any other. */
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

interface Group {
  source: string;
  errors: number;
  warnings: number;
  examples: string[];
}

/** Group the window's rows by source, worst first. */
export function groupEvents(rows: readonly EventRow[]): Group[] {
  const by = new Map<string, Group>();
  for (const row of rows) {
    const g = by.get(row.source) ?? { source: row.source, errors: 0, warnings: 0, examples: [] };
    if (row.level === "error") g.errors += 1;
    else g.warnings += 1;
    if (g.examples.length < MAX_EXAMPLES && !g.examples.includes(row.message)) g.examples.push(row.message);
    by.set(row.source, g);
  }
  return [...by.values()].sort(
    (a, b) => b.errors - a.errors || b.warnings - a.warnings || a.source.localeCompare(b.source),
  );
}

function renderGroup(g: Group): string {
  const counts = [g.errors ? `${g.errors} error${g.errors === 1 ? "" : "s"}` : "", g.warnings ? `${g.warnings} warning${g.warnings === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
  const examples = g.examples
    .map((m) => `<div style="margin:2px 0 0;font-size:12.5px;line-height:1.5;color:${EMAIL_INK_3};">${esc(m)}</div>`)
    .join("");
  return (
    `<div style="padding:10px 0;border-bottom:1px solid #E6E5E2;">` +
    `<div style="font-size:13.5px;color:${EMAIL_INK};"><strong>${esc(g.source)}</strong> — ${esc(counts)}</div>` +
    examples +
    `</div>`
  );
}

/**
 * Build and send the digest. Never throws: it is called from a cron whose
 * other work must not fail because a mail provider is down.
 */
export async function sendOperatorDigest(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<DigestOutcome> {
  const recipients = operatorRecipients();
  if (recipients.length === 0) {
    return { sent: false, reason: "ADMIN_EMAILS is not set, so this install has no operator to tell" };
  }
  if (!process.env.RESEND_API_KEY) {
    return { sent: false, reason: "RESEND_API_KEY is not set, so this install cannot send mail" };
  }

  const since = new Date(now.getTime() - DIGEST_HOURS * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from("system_events")
    .select("level, source, message, created_at")
    .in("level", ["error", "warn"])
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    // Most likely the migration is not applied. Not an email's problem.
    return { sent: false, reason: `the event log could not be read: ${error.message}` };
  }

  const rows = (data ?? []) as EventRow[];
  if (rows.length === 0) {
    return { sent: false, reason: `nothing was recorded in the last ${DIGEST_HOURS} hours` };
  }

  const errors = rows.filter((r) => r.level === "error").length;
  const warnings = rows.length - errors;
  const groups = groupEvents(rows);
  const shown = groups.slice(0, MAX_GROUPS);
  const rest = groups.slice(MAX_GROUPS);
  const restLine = rest.length
    ? emailParagraph(
        `And ${rest.length} other source${rest.length === 1 ? "" : "s"}: ${rest.map((g) => g.source).join(", ")}.`,
      )
    : "";

  // The date, so a second run on the same day sends nothing (sent_emails,
  // migration 073). The generate and publish crons both run more than once in
  // some deployments, and an operator getting the same digest twice would
  // learn to ignore it.
  const day = now.toISOString().slice(0, 10);
  const headline = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;

  const outcome = await sendOnce(
    supabase,
    recipients,
    {
      type: "ops_digest",
      subjectId: day,
      // Not a category of its own: EMAIL_CATEGORIES drives the customer-facing
      // preferences screen, and adding "ops" there would show every customer a
      // switch for an email only an operator ever receives. `account` is
      // required, so it carries no unsubscribe link — which is right for the
      // one address that is supposed to be told when the product breaks.
      category: "account",
    },
    () => ({
      subject: `AltoRank operations — ${headline}`,
      preheader: `In the last ${DIGEST_HOURS} hours, across every account.`,
      footerNote: `Sent because this address is in ADMIN_EMAILS. Change that variable to change who gets it, or unset it to stop it.`,
      html:
        `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${EMAIL_INK};">${esc(headline)}</h1>` +
        emailParagraph(
          `In the last ${DIGEST_HOURS} hours, across every account. Counts are of recorded events, not of affected customers — one broken connection can produce a row an hour.`,
        ) +
        `<div style="margin:8px 0 4px;color:${EMAIL_INK_2};">${shown.map(renderGroup).join("")}</div>` +
        restLine +
        emailButton(appLink("/admin/events"), "Open the event log"),
    }),
  );

  return { sent: true, errors, warnings, outcome };
}
