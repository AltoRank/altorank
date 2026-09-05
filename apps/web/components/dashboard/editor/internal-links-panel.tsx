"use client";

import Link from "next/link";
import { useMemo } from "react";
import { extractLinks } from "@/lib/seo/links";
import type { LinkTarget } from "@/lib/seo/link-resolver";

// ---------------------------------------------------------------------------
// The internal links a draft actually contains, and whether that is enough
// ---------------------------------------------------------------------------
//
// The audit tab counts them. This names them: which words link where, and
// whether "where" is a page in the link pool or somewhere the writer made up.
// The configured count comes from the site's output settings, so the warning
// is against what the customer asked for rather than a number of ours.

type Props = {
  /** The editor's current HTML. */
  html: string;
  siteDomain: string | null;
  /** The pool this draft was offered, from `fetchLinkTargets`. */
  targets: LinkTarget[];
  /** `workspace_output_settings.internal_links`. Null when the site never set one. */
  wanted: number | null;
};

function normalise(href: string, siteDomain: string | null): string {
  try {
    const base = siteDomain ? `https://${siteDomain.replace(/^https?:\/\//, "")}` : "https://invalid.local";
    const u = new URL(href, base);
    u.hash = "";
    u.search = "";
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return href.trim().toLowerCase();
  }
}

export function InternalLinksPanel({ html, siteDomain, targets, wanted }: Props) {
  const links = useMemo(() => {
    const byUrl = new Map(targets.map((t) => [normalise(t.url, siteDomain), t]));
    return extractLinks(html, siteDomain)
      .filter((l) => l.kind === "internal")
      .map((l) => ({ ...l, target: byUrl.get(normalise(l.href, siteDomain)) ?? null }));
  }, [html, siteDomain, targets]);

  const short = wanted !== null && links.length < wanted;

  return (
    <div className="flex flex-col gap-2">
      <div className={`text-[12.5px] ${short ? "text-warn-ink" : "text-ink-2"}`}>
        {links.length === 0
          ? "No internal links yet."
          : `${links.length} internal ${links.length === 1 ? "link" : "links"}.`}
        {wanted !== null && (
          <span className="text-ink-3">
            {" "}
            {short
              ? `This site asks for ${wanted} per article.`
              : `Meets the ${wanted} this site asks for.`}
          </span>
        )}
      </div>

      {links.length > 0 && (
        <ul className="flex flex-col gap-1.5 m-0 p-0 list-none">
          {links.map((l, i) => (
            <li key={`${l.href}-${i}`} className="rounded-[6px] border border-line-soft px-2.5 py-1.5">
              <div className="text-[12.5px] font-medium truncate" title={l.anchor}>
                {l.anchor || <span className="text-ink-3 italic">no anchor text</span>}
              </div>
              <div className="text-[11.5px] text-ink-3 truncate" title={l.href}>
                {l.target ? l.target.title : l.href}
              </div>
              {!l.target && (
                <div className="text-[11px] text-warn-ink mt-0.5">
                  Not a page in the link pool. Check it exists.
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {targets.length === 0 ? (
        <div className="text-[11.5px] text-ink-3">
          Nothing to link to yet.{" "}
          <Link href="/linking" className="underline">
            Detect this site&rsquo;s pages
          </Link>{" "}
          to give the next draft a pool.
        </div>
      ) : (
        <div className="text-[11.5px] text-ink-3">
          {targets.length} {targets.length === 1 ? "page" : "pages"} offered to the writer.{" "}
          <Link href="/linking" className="underline">
            Configure
          </Link>
        </div>
      )}
    </div>
  );
}
