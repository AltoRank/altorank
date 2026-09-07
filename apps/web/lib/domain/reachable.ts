// ---------------------------------------------------------------------------
// Is there a site at this domain at all?
// ---------------------------------------------------------------------------
//
// Until this, the only thing standing between a typo and a 30-day content plan
// was a regex (app/actions/workspaces.ts). It checks the *shape* of a hostname,
// so `stripdemo.altorank.test` passes it perfectly - and `.test` is reserved by
// RFC 2606 and can never resolve, anywhere, for anyone.
//
// What happened next is the part worth fixing: onboarding's phases gate on
// `!domain`, never on whether the previous phase learned anything, so a site
// that could not be read still produced keywords, a page check, a planned month
// and a first draft, every one of them rendered as a green tick. The product
// told somebody it had read 42 pages of a site that does not exist.
//
// Two verdicts, because the failures are not equally certain:
//
//   `no-dns`  - the name resolves to nothing. This is not a judgement call:
//               there is no host. Block it, and say so at the field.
//   `no-http` - it resolves, but nothing answered. Warn, do not block:
//               Cloudflare and most WAFs refuse unknown bots, and a customer
//               whose site is real but shy must still be able to sign up.
//               Blocking here would reject paying customers to catch typos.
//
// Cheap enough to run on blur: one DNS lookup, then at most one HEAD and one
// GET, all with a short timeout.

import { promises as dns } from "node:dns";

export type DomainReachability =
  | { ok: true; verdict: "live"; url: string }
  | { ok: true; verdict: "no-http"; reason: string }
  | { ok: false; verdict: "no-dns"; reason: string }
  | { ok: false; verdict: "invalid"; reason: string };

/** Long enough for a slow origin, short enough to sit in a form's blur handler. */
const DNS_TIMEOUT_MS = 3_000;
const HTTP_TIMEOUT_MS = 5_000;

/**
 * Hostname shape only. Deliberately the same rule as `createWorkspaceSchema`,
 * so a domain can never pass one check and fail the other.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** `https://www.Acme.com/pricing?x=1` -> `acme.com`. Same normalisation the schema applies. */
export function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

/**
 * TLDs that are reserved and can never resolve (RFC 2606, RFC 6761). Checked
 * before DNS because the answer is knowable without a lookup, and because a
 * resolver on a developer's machine may happily answer `.test` from
 * /etc/hosts while nobody else on the internet can.
 */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local"]);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

/**
 * Does a site exist here?
 *
 * Never throws: every failure is a verdict, because the caller is a form field
 * and an exception there reads as "our fault" when it is usually "your typo".
 */
export async function checkDomainReachable(input: string): Promise<DomainReachability> {
  const domain = normaliseDomain(input);

  // `E2E_STUBS` stands in for the outside world, DNS included: every e2e domain
  // is `*.altorank.test` precisely because it resolves to nothing. Read from
  // the environment directly rather than importing lib/e2e/stubs, which pulls
  // the fact-checker, the tiptap converter and the crawler in behind it - a
  // heavy graph to drag into a server action for one boolean, and enough on a
  // cold import to blow a unit test's timeout.
  if (process.env.E2E_STUBS === "1") {
    return { ok: true, verdict: "live", url: `https://${domain}` };
  }

  if (!HOSTNAME.test(domain)) {
    return { ok: false, verdict: "invalid", reason: "Enter a domain like acme.com" };
  }

  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.has(tld)) {
    return {
      ok: false,
      verdict: "no-dns",
      reason: `.${tld} is a reserved name that cannot exist on the public internet. Use the domain your site is actually served from.`,
    };
  }

  try {
    const records = await withTimeout(dns.lookup(domain, { all: true }), DNS_TIMEOUT_MS, "DNS");
    if (!records.length) throw new Error("no records");
  } catch {
    return {
      ok: false,
      verdict: "no-dns",
      reason: "That domain does not resolve. Check the spelling, or use the domain your site is served from.",
    };
  }

  // It exists. Whether it answers us is a softer question - see the note above.
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await withTimeout(
        fetch(`https://${domain}`, {
          method,
          redirect: "follow",
          headers: { "user-agent": "AltoRankBot/1.0 (+https://altorank.co)" },
        }),
        HTTP_TIMEOUT_MS,
        method,
      );
      if (res.ok) return { ok: true, verdict: "live", url: `https://${domain}` };
    } catch {
      // Try the next method, then fall through to the soft verdict.
    }
  }

  return {
    ok: true,
    verdict: "no-http",
    reason:
      "The domain exists but did not answer us. If it is behind Cloudflare or a firewall that is expected, and setup will continue - but we may not be able to read the site.",
  };
}
