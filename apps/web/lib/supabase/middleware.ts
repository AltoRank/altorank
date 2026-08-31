import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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
  const PUBLIC_PREFIXES = [
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
  ];

  const isPublic =
    path === "/" || PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from auth pages
  if (user && (path === "/signin" || path === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
