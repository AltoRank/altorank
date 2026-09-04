"use client";

import type { SiteDetails } from "@/lib/onboarding/output-settings";
import { Field, inputClass } from "./fields";

/** Sitemap, blog root, three example articles. Shared by the wizard's Blog step and the Blog tab. */
export function SiteFields({
  site,
  setSite,
  domain,
}: {
  site: SiteDetails;
  setSite: (s: SiteDetails) => void;
  domain: string;
}) {
  const examples = [0, 1, 2].map((i) => site.exampleArticleUrls[i] ?? "");
  return (
    <div className="flex flex-col gap-4">
      <Field label="Sitemap" hint="Used to find your existing pages for internal links.">
        <input
          className={inputClass}
          value={site.sitemapUrl}
          placeholder={`https://${domain}/sitemap.xml`}
          onChange={(e) => setSite({ ...site, sitemapUrl: e.target.value })}
        />
      </Field>
      <Field label="Blog address" hint="Where published articles will appear.">
        <input
          className={inputClass}
          value={site.blogRootUrl}
          placeholder={`https://${domain}/blog/`}
          onChange={(e) => setSite({ ...site, blogRootUrl: e.target.value })}
        />
      </Field>
      <Field label="Your best writing" hint="Up to three articles you are proud of. Drafts learn their voice from these before anything else.">
        <div className="flex flex-col gap-2">
          {examples.map((v, i) => (
            <input
              key={i}
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
    </div>
  );
}
