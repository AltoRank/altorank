"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { createWorkspacesFromProperties, type DetectedProperty } from "@/app/actions/google-properties";

/**
 * Ticking a property creates a workspace for it. Properties this account
 * cannot read are shown, greyed, with the reason: hiding them would leave
 * someone hunting for a site that is right there under the wrong permission.
 */
export function PropertyPicker({ properties }: { properties: DetectedProperty[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [chosen, setChosen] = useState<string[]>([]);
  const [limit, setLimit] = useState<{ message: string; needed: number } | null>(null);

  const selectable = useMemo(
    () => properties.filter((p) => p.canRead && !p.existingWorkspaceId),
    [properties],
  );

  function toggle(siteUrl: string) {
    setLimit(null);
    setChosen((c) => (c.includes(siteUrl) ? c.filter((s) => s !== siteUrl) : [...c, siteUrl]));
  }

  function submit() {
    start(async () => {
      const result = await createWorkspacesFromProperties(chosen);
      if (!result.ok) {
        setLimit({ message: result.message, needed: result.needed });
        return;
      }
      toast.success(
        `${result.created} workspace${result.created === 1 ? "" : "s"} created. The first look is running now.`,
      );
      router.push("/workspaces");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <div className="text-[13px] leading-relaxed text-ink-2">
          A property you <span className="font-medium text-ink">own or have full access to</span> can
          be read; Google reports your own permission, not the owner&rsquo;s address, so that is the
          check we can make honestly. Restricted and unverified properties are listed but cannot be
          selected: ask the owner to raise your access in Search Console, then reload this page.
        </div>
      </Card>

      <Card>
        <div className="flex flex-col">
          {properties.map((p, i) => {
            const disabled = !p.canRead || Boolean(p.existingWorkspaceId);
            return (
              <label
                key={p.siteUrl}
                className={`flex items-center gap-3 px-5 py-3.5 ${i > 0 ? "border-t border-line-soft" : ""} ${
                  disabled ? "opacity-55" : "cursor-pointer hover:bg-panel"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={disabled || pending}
                  checked={chosen.includes(p.siteUrl)}
                  onChange={() => toggle(p.siteUrl)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink">{p.domain}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-3">{p.siteUrl}</span>
                </span>
                <span className="shrink-0 text-right">
                  {p.existingWorkspaceId ? (
                    <Link
                      href={`/workspaces/${p.existingWorkspaceId}`}
                      className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-ink hover:underline"
                    >
                      already a workspace
                    </Link>
                  ) : p.isOwner ? (
                    <span className="rounded-full bg-ok-soft px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ok-ink">
                      owner
                    </span>
                  ) : p.canRead ? (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-ink">
                      full access
                    </span>
                  ) : (
                    <span className="rounded-full bg-panel px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                      {p.permissionLevel === "siteUnverifiedUser" ? "not verified" : "restricted"}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </Card>

      {limit && (
        <Card className="border-accent/30 bg-accent-soft p-5">
          <div className="text-[13.5px] font-medium text-accent-ink">
            {chosen.length} sites selected, and this account has room for fewer.
          </div>
          <div className="mt-1 text-[13px] leading-relaxed text-accent-ink/90">{limit.message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Checkout returns here, with the same boxes ticked. */}
            <Link
              href={`/settings/billing?return=${encodeURIComponent("/connect/google")}`}
              className="inline-flex h-9 items-center rounded-[7px] bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent-2"
            >
              Choose a plan
            </Link>
            <Button variant="ghost" onClick={() => setChosen(chosen.slice(0, 1))}>
              Just the first one for now
            </Button>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Button disabled={!chosen.length || pending} onClick={submit}>
          {pending
            ? "Creating…"
            : chosen.length
              ? `Create ${chosen.length} workspace${chosen.length === 1 ? "" : "s"}`
              : "Select a site"}
        </Button>
        {selectable.length > 1 && !pending && (
          <button
            type="button"
            onClick={() => setChosen(chosen.length === selectable.length ? [] : selectable.map((p) => p.siteUrl))}
            className="text-[12.5px] text-ink-3 hover:text-ink"
          >
            {chosen.length === selectable.length ? "Clear" : `Select all ${selectable.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
