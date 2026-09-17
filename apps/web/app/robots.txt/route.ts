import { MARKETING_URL } from "@/lib/constants";

/**
 * app.altorank.co/robots.txt
 *
 * Until this existed the path fell through to deny-by-default in
 * `PUBLIC_PREFIXES` and answered a crawler with `307 -> /signin?next=%2Frobots.txt`.
 * A robots.txt that redirects to a login page is not a permissive robots.txt:
 * it is an *absent* one, so every crawler applied its own default, which is
 * "crawl whatever you can reach". That is the opposite of what this host wants.
 *
 * Why this file is a directory with a route handler rather than the more
 * idiomatic `app/robots.ts`: `lib/supabase/__tests__/public-routes.test.ts`
 * reads the filesystem and requires every sessionless URL to be a directory
 * under `app/` that is also named in PUBLIC_PREFIXES. A bare `robots.ts` at
 * the app root is invisible to that walk, so the route would be public by
 * accident rather than on the list on purpose. Keeping the convention keeps
 * the test meaningful.
 *
 * ── Why /check is disallowed, when it is the top of the funnel ──────────────
 *
 * `check/[domain]/page.tsx` serves a cached result when one exists and
 * otherwise *runs the check*, which fetches the homepage, /robots.txt,
 * /sitemap.xml and /llms.txt of whatever domain is in the URL. The cache holds
 * for six hours (CACHE_TTL_MS).
 *
 * The URL space is therefore unbounded and every uncached URL in it is an
 * outbound request to a third party. Letting a crawler walk it would turn
 * Googlebot into a trigger for scans of sites nobody asked about, from our
 * infrastructure and under our name, at whatever rate it chose. The per-IP
 * limit in the page caps a visitor, not a distributed crawler fleet.
 *
 * The pages already carry `robots: { index: false }`, but a meta tag only
 * works on a page that was fetched, and it says nothing about the fetching
 * itself. This rule is about the crawl, not the index.
 *
 * Nothing is lost on the search side: one thin page per arbitrary domain is
 * not a surface a search engine should rank, which is the same reasoning the
 * page itself records. The indexable version of this tool is the marketing
 * site's /check, which explains the nine signals, ranks on its own merits and
 * runs nothing until a human types a domain.
 *
 * /share is disallowed on plainer grounds: the token in the URL is the
 * authorisation (lib/share/token.ts), and an unguessable URL belongs in no
 * index. Those pages already send `index: false, follow: false`.
 */
export const dynamic = "force-static";

const BODY = `# app.altorank.co — the application host.
#
# Nothing here is meant for a search index. The public, indexable pages live on
# ${MARKETING_URL}, which has its own robots.txt and sitemap.

User-agent: *
Disallow: /

# Said explicitly rather than left to the blanket rule above, because both are
# reachable without a session and a future edit should have to argue with a
# comment before opening them.
#
# /check runs a live check on the domain in the URL when no cached result
# exists, so crawling it means this host fetching third-party sites on a
# crawler's schedule.
Disallow: /check/
# /share pages are authorised by an unguessable token in the path.
Disallow: /share/
`;

export function GET(): Response {
  return new Response(BODY, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
