import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { parsePublicDomain } from "@/lib/public-check/domain";
import { loadCachedCheck } from "@/lib/public-check/run";
import { badgeText, shareUrlFor } from "@/lib/public-check/shape";

/**
 * GET /check/badge.js?domain=<domain>
 *
 * A script tag a site owner pastes to show their result:
 *
 *   <script src="https://app.altorank.co/check/badge.js?domain=example.com" async></script>
 *
 * It inserts one link where the tag sits, reading "AI-readiness: 7/9 ·
 * checked 4 Sep 2026", pointing at the result page. The text is rendered
 * here, from the cache, so the visitor's browser makes one request and no
 * cross-origin call. No cached result means no number: the badge then says
 * only who runs the check. Never crawls.
 */
export const dynamic = "force-dynamic";

const STYLE =
  "display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid #d9d6cf;border-radius:999px;" +
  "font:500 12px/1.4 system-ui,sans-serif;color:#2a2926;background:#fff;text-decoration:none";

export async function GET(request: NextRequest) {
  const parsed = parsePublicDomain(request.nextUrl.searchParams.get("domain"));
  if (!parsed.ok) {
    return new NextResponse(`/* AltoRank badge: ${parsed.error} */`, {
      status: 400,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }
  const data = await loadCachedCheck(createServiceClient(), parsed.domain);
  const text = data ? badgeText(data) : "AI-readiness check by AltoRank";
  const href = shareUrlFor(parsed.domain);

  const js =
    `(function(){var s=document.currentScript;if(!s||!s.parentNode)return;` +
    `var a=document.createElement("a");a.href=${JSON.stringify(href)};a.textContent=${JSON.stringify(text)};` +
    `a.rel="noopener";a.target="_blank";a.setAttribute("style",${JSON.stringify(STYLE)});` +
    `s.parentNode.insertBefore(a,s);})();`;

  return new NextResponse(js, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
