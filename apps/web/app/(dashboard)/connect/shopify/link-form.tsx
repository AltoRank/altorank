"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { linkShopifyStore } from "@/app/actions/shopify-link";

export function ShopifyLinkForm(props: {
  token: string;
  storeDomain: string | null;
  sites: Array<{ id: string; label: string }>;
  suggestedSiteId?: string;
}) {
  const [choice, setChoice] = useState(props.suggestedSiteId ?? props.sites[0]?.id ?? "new");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (done) {
    return (
      <p className="text-[13px] text-ink-2">
        Connected to {done}. Go back to AltoRank in your Shopify admin and reload it: it now shows this site&apos;s drafts.
      </p>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await linkShopifyStore(props.token, choice);
          if (res.ok) setDone(res.domain || "your site");
          else setError(res.error);
        });
      }}
    >
      {props.sites.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-[13px] text-ink">
          <input type="radio" name="site" value={s.id} checked={choice === s.id} onChange={() => setChoice(s.id)} />
          {s.label}
        </label>
      ))}
      {props.storeDomain && (
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="radio" name="site" value="new" checked={choice === "new"} onChange={() => setChoice("new")} />
          Add {props.storeDomain} as a new site
        </label>
      )}
      {error && <p className="text-[13px] text-red-600">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Connect the store"}
      </Button>
    </form>
  );
}
