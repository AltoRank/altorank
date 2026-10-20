// ---------------------------------------------------------------------------
// Where a user came from, for the operator's Users page
// ---------------------------------------------------------------------------
//
// Every door that makes an account writes one `signup` event (source
// "signup", stage "created", or "fallback" for the membership fallback) with
// the user id in its context, and that row is the only record of the source:
//
//   the signup form   src / lp / ref / utm from the marketing site's signup link
//                     (lib/auth/signup-source.ts)
//   the sign-in code  context.source "signin_code" (lib/auth/signin-code-signup.ts)
//   Shopify           context.source "shopify" (lib/shopify/provision.ts)
//   the fallback      stage "fallback" (lib/queries/account.ts)
//
// One answer per user, in the order an operator trusts them: the campaign
// on the link, then the site that sent them, then the page the visit landed
// on (else the page they clicked signup on), then the door when it was not
// the form. Pure: the page reads the
// rows, this reads them.

/** What the Users page shows for one user. `detail` is the rest of the story, for a second line and the tooltip. */
export interface UserOrigin {
  kind: "campaign" | "referrer" | "page" | "door" | "direct" | "invited" | "unknown";
  label: string;
  detail: string | null;
}

/** A `signup` event row as read from system_events. */
export interface SignupEventRow {
  context: unknown;
  created_at: string;
}

interface SignupContext {
  stage?: unknown;
  userId?: unknown;
  source?: unknown;
  src?: unknown;
  /** The first page of the visit (altorank#339, altorank-marketing#72). */
  lp?: unknown;
  ref?: unknown;
  utm?: unknown;
}

const DOORS: Record<string, string> = {
  signin_code: "Sign-in code",
  shopify: "Shopify App Store",
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The account-creating event of each user, by user id: the first one, when a
 * user somehow has two. Rows that are not about a created account (the
 * error rows of a failed signup) are skipped.
 */
export function signupEventsByUser(rows: SignupEventRow[]): Map<string, SignupContext> {
  const out = new Map<string, SignupContext>();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const row of sorted) {
    const ctx = row.context && typeof row.context === "object" ? (row.context as SignupContext) : null;
    if (!ctx || (ctx.stage !== "created" && ctx.stage !== "fallback")) continue;
    const userId = str(ctx.userId);
    if (userId && !out.has(userId)) out.set(userId, ctx);
  }
  return out;
}

/**
 * One user's origin. `event` is their signup event, if any; `invited` says
 * they joined someone else's account, which writes no signup event.
 */
export function userOrigin(event: SignupContext | undefined, { invited = false }: { invited?: boolean } = {}): UserOrigin {
  if (!event) {
    if (invited) return { kind: "invited", label: "Invited", detail: "joined a teammate's account" };
    // Accounts made before signups recorded their source, and any door that writes nothing.
    return { kind: "unknown", label: "—", detail: "not recorded" };
  }
  const door = event.stage === "fallback" ? "Membership fallback" : (DOORS[str(event.source) ?? ""] ?? null);
  const utm = event.utm && typeof event.utm === "object" ? (event.utm as Record<string, unknown>) : {};
  const utmSource = str(utm.source);
  const ref = str(event.ref);
  const clicked = str(event.src);
  const landed = str(event.lp);
  // Where the visit landed is the page that earned it; where signup was
  // clicked is said only when it differs.
  const pages = landed
    ? [`landed on ${landed}`, clicked && clicked !== landed ? `signed up from ${clicked}` : null]
    : [clicked ? `from ${clicked}` : null];
  const extras = (parts: Array<string | null>) => parts.filter(Boolean).join(" · ") || null;

  if (utmSource) {
    const campaign = [str(utm.medium), str(utm.campaign)].filter(Boolean).join(" / ") || null;
    return { kind: "campaign", label: utmSource, detail: extras([campaign, ...pages]) };
  }
  if (ref) return { kind: "referrer", label: ref, detail: extras(pages) };
  if (landed) return { kind: "page", label: landed, detail: extras([clicked && clicked !== landed ? `signed up from ${clicked}` : null, "no referrer or campaign"]) };
  if (clicked) return { kind: "page", label: clicked, detail: "no referrer or campaign" };
  if (door) return { kind: "door", label: door, detail: null };
  // The signup form with nothing on its link: typed in, a bookmark, or a link that dropped it.
  return { kind: "direct", label: "Direct", detail: "signup form, no source on the link" };
}

/** Text for the page's search, so `q=google` finds the users a campaign brought. */
export function originSearchText(origin: UserOrigin): string {
  return [origin.label === "—" ? "" : origin.label, origin.detail ?? ""].join(" ");
}
