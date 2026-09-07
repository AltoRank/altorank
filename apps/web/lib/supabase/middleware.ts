import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { afterSignIn } from "@/lib/auth/next-path";

// Everything is private unless it is on this list.
//
// This used to be the other way round: a hand-written chain of ten
// `path.startsWith(...)` clauses naming the routes to protect. Three routes
// added later were never added to it, so /audits, /geo and /readiness served
// the whole app shell to anonymous visitors. RLS meant no rows came back, but
// a route is not protected because a second layer happened to hold.
//
// Deny-by-default fails the safe way: a new page is private until somebody
// decides otherwise here, in one place, on purpose.
//
// Exported because a list nobody can read is a list nobody can check. Every
// page directory sitting directly under `app/` - outside every route group - is
// there precisely because it has no session to belong to, and
// `__tests__/public-routes.test.ts` reads that directory and fails if one of
// them is missing here. /hold was missing for as long as it existed.
export const PUBLIC_PREFIXES = [
  "/signin",
  "/signup",
  "/reset-password",
  "/invite",
  "/callback",
  "/auth",
  "/api",
  // The readiness checker is deliberately public: it runs on any domain with
  // no workspace and no account, and is the top of the funnel.
  "/readiness",
  // Shared result pages and the badge script for the free public check.
  // Anyone holding the link is the audience; there is nothing to sign into.
  "/check",
  // The share card behind an unguessable token (lib/share/token.ts). Same
  // audience: whoever was handed the link, and the unfurler before them.
  "/share",
  // The unsubscribe link from an email footer. Somebody who wants the mail
  // to stop must not be asked to sign in first - and the address a shared
  // report inbox uses may have no account at all. The HMAC in the URL is
  // what authorises it (lib/email/unsubscribe.ts).
  "/unsubscribe",
  // The "Hold this one" link from a drafted email, on the same terms as
  // /unsubscribe: the HMAC in the URL is what authorises it
  // (lib/publishing/hold-link.ts), binding the article to the address the mail
  // went to. It is missing here that made the approval gate's escape hatch a
  // bounce to /signin on production, so the draft published on schedule while
  // the reader looked at a password field - and the signed token rode into the
  // sign-in URL, into history and into any referrer that page emits.
  "/hold",
] as const;

/** Whether the middleware serves this path to a request with no session. */
export function isPublicPath(path: string): boolean {
  return path === "/" || PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — do NOT remove this
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Handle stray auth codes on root — redirect to callback route
  if (path === "/" && request.nextUrl.searchParams.has("code")) {
    const url = request.nextUrl.clone();
    url.pathname = "/callback";
    return NextResponse.redirect(url);
  }

  if (!user && !isPublicPath(path)) {
    // Carry the destination, not the query that happened to be on it. This
    // used to clone the URL and overwrite only the pathname, so
    // `/articles?status=review` became `/signin?status=review`: the query
    // survived and the destination did not, and a reader who followed "Read
    // the draft" from an email signed in and landed on the dashboard with no
    // idea which article it was about. Eight of the twenty-four emails end in
    // a link like that.
    //
    // Clearing the search first also stops a signed link's parameters riding
    // into the sign-in URL, where they sit in history and in any referrer the
    // page emits.
    const url = request.nextUrl.clone();
    url.search = "";
    url.pathname = "/signin";
    url.searchParams.set("next", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from auth pages, honouring the same
  // `next` - somebody already signed in who opens a mailed link should land on
  // the article, not be told to go to the dashboard and find it.
  if (user && (path === "/signin" || path === "/signup")) {
    const target = afterSignIn(request.nextUrl.searchParams.get("next"));
    return NextResponse.redirect(new URL(target, request.nextUrl.origin));
  }

  return supabaseResponse;
}
