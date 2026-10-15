import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { PREVIEW_COOKIE, hasPreviewCookie } from "@/lib/auth/preview-cookie";
import { NONCE_HEADER, buildCsp, makeNonce } from "@/lib/security/csp";

/** Methods that cannot change anything. Everything else is a write. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Read-only enforcement for the operator's "preview as customer" mode.
 *
 * This is the only layer every request passes through, which is precisely why
 * the check lives here. The obvious home would be `requireAuth`, but 20 of the
 * 40 server-action modules never call it - they build a Supabase client and
 * write directly - so guarding there would produce a read-only mode that is
 * read-only on the paths someone remembered and silently writable on the rest.
 * A safety promise that holds most of the time is not one.
 *
 * Two shapes of write reach the app:
 *   - Server actions: POST to any route, carrying a `Next-Action` header.
 *   - Route handlers under /api: any non-read method.
 * Both are covered by refusing every non-read method while the cookie is set.
 *
 * No auth lookup guards this. Blocking is fail-safe - the worst a forged
 * cookie does is deny the sender their own writes - and making the block
 * depend on a session read would mean an expired or failing lookup fails open,
 * which is the one outcome that would matter.
 */
export async function middleware(request: NextRequest) {
  if (
    !READ_METHODS.has(request.method) &&
    hasPreviewCookie(request.cookies.get(PREVIEW_COOKIE)?.value)
  ) {
    // 403 rather than a redirect: a server action expects a response to the
    // action, not a document, and a redirect would surface as an opaque
    // failure. The body is JSON so `fetch` callers get something readable.
    return NextResponse.json(
      {
        error: "read_only_preview",
        message:
          "You are previewing AltoRank as a customer. Writes are blocked until you exit the preview.",
      },
      { status: 403 },
    );
  }

  // The Content-Security-Policy (lib/security/csp.ts), with a nonce fresh for
  // this request. Set on the request too, before the response is built: Next
  // reads the nonce from the request's CSP header and stamps it on every
  // script it renders, and the root layout reads it for its own inline one.
  // Set, not appended, so a client-sent value never survives.
  const nonce = makeNonce();
  const csp = buildCsp({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    dev: process.env.NODE_ENV === "development",
  });
  request.headers.set(NONCE_HEADER, nonce);
  request.headers.set("content-security-policy", csp);

  const response = await updateSession(request);
  response.headers.set(cspHeaderName(), csp);
  return response;
}

// Report-only until CSP_ENFORCE=1. The nonce is stamped either way, so
// flipping the variable after a check of sign-in, the editor, checkout and the
// OAuth consent screen changes nothing but enforcement.
export function cspHeaderName(): string {
  return process.env.CSP_ENFORCE === "1" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static, _next/image, favicon.ico, public assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
