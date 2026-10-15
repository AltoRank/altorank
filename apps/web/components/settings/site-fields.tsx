"use client";

import type { SiteDetails } from "@/lib/onboarding/output-settings";
import { Icons } from "@/components/ui";
import { Field, inputClass } from "./fields";

/**
 * Sitemap, blog root, three example articles. Shared by the wizard's "Where
 * your content lives" and the Blog tab.
 *
 * In the wizard (`advanced`), only the blog address is in view: the sitemap,
 * the example articles and whatever the caller adds (Search Console) sit
 * behind "Advanced (optional)". A small business with no blog was handed
 * three technical fields and a Google sign-in mid-onboarding and read it as
 * "this is not for me" (UX audit 2026-10-12, #12). Settings shows them all.
 */
export function SiteFields({
  site,
  setSite,
  domain,
  advanced = false,
  children,
}: {
  site: SiteDetails;
  setSite: (s: SiteDetails) => void;
  domain: string;
  /** Put everything but the blog address behind an "Advanced (optional)" fold. */
  advanced?: boolean;
  /** Extra rows for the advanced fold (the wizard's Search Console row). */
  children?: React.ReactNode;
}) {
  const examples = [0, 1, 2].map((i) => site.exampleArticleUrls[i] ?? "");
  const blog = (
    <Field label="Blog address" hint="Where published articles will appear, if you have a blog.">
      <input
        className={inputClass}
        value={site.blogRootUrl}
        placeholder={`https://${domain}/blog/`}
        onChange={(e) => setSite({ ...site, blogRootUrl: e.target.value })}
      />
    </Field>
  );
  const sitemap = (
    <Field label="Sitemap" hint="So articles can link to the pages you already have.">
      <input
        className={inputClass}
        value={site.sitemapUrl}
        placeholder={`https://${domain}/sitemap.xml`}
        onChange={(e) => setSite({ ...site, sitemapUrl: e.target.value })}
      />
    </Field>
  );
  const best = (
    <Field
      label="Your best writing"
      hint="Up to three articles you are proud of. Drafts learn their voice from these before anything else."
    >
      <div className="flex flex-col gap-2">
        {examples.map((v, i) => (
          <input
            key={i}
            aria-label={`Article you are proud of, ${i + 1} of 3`}
            className={inputClass}
            value={v}
            placeholder={i === 0 ? `https://${domain}/blog/an-article-you-like` : "https://…"}
            onChange={(e) => {
              const next = [...examples];
              next[i] = e.target.value;
              setSite({ ...site, exampleArticleUrls: next.filter(Boolean) });
            }}
          />
        ))}
      </div>
    </Field>
  );
  if (!advanced) {
    return (
      <div className="flex flex-col gap-4">
        {sitemap}
        {blog}
        {best}
        {children}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {blog}
      <details className="group/adv">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-[12.5px] font-medium text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
          Advanced (optional)
          <span aria-hidden className="text-ink-3 transition-transform group-open/adv:rotate-180">
            <Icons.caretDown size={11} />
          </span>
        </summary>
        <div className="mt-4 flex flex-col gap-4">
          {sitemap}
          {best}
          {children}
        </div>
      </details>
    </div>
  );
}
