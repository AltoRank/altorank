"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card } from "@/components/ui";
import { saveSiteDetails } from "@/app/actions/onboarding-wizard";
import type { SiteDetails } from "@/lib/onboarding/output-settings";
import { SiteFields } from "./site-fields";

/** The wizard's Blog screen as a settings card. */
export function SiteForm({ workspaceId, domain, initial }: { workspaceId: string; domain: string; initial: SiteDetails }) {
  const router = useRouter();
  const [site, setSite] = useState<SiteDetails>(initial);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(site) !== JSON.stringify(initial);

  function save() {
    start(async () => {
      try {
        await saveSiteDetails(workspaceId, site);
        toast.success("Saved.");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save.");
      }
    });
  }

  return (
    <Card title="Where your content lives" meta={<span className="font-mono">{domain}</span>}>
      <SiteFields site={site} setSite={setSite} domain={domain} />
      <div className="mt-4 flex items-center justify-end gap-3">
        <span className="text-[12px] text-ink-3">Only full URLs are kept; anything else is dropped on save.</span>
        <Button variant="accent" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
