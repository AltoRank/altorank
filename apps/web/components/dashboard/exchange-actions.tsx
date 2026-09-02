"use client";

import { useTransition, useState } from "react";
import { toast } from "sonner";
import { createExchangeRequest } from "@/app/actions/exchange";
import { Button, Dialog, Icons } from "@/components/ui";

type Ws = { id: string; name: string };

type Props = {
  /** All of them: which site the link should point at is the request. */
  workspaces: Ws[];
  scopedId?: string | null;
};

const inputClass =
  "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";

/**
 * Request a link from the exchange.
 *
 * Was an inline form in the page header, three fields wide, in a row 56px
 * tall: the labels were already clipped, and the one paragraph this form now
 * has to carry - what an exchanged link is and is not - had nowhere to go. A
 * dialog has room for the fields and for the sentence that makes the feature
 * honest, and it is the same Dialog the CMS connections use.
 */
export function ExchangeRequestForm({ workspaces, scopedId }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [workspaceId, setWorkspaceId] = useState(scopedId ?? workspaces[0]?.id ?? "");

  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Icons.plus size={14} />
        Request link
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Request a link"
        description="Another site in the network hosts a link to your page, priced in credits by its domain rating."
      >
        <form
          className="flex flex-col gap-3.5"
          action={(fd) =>
            startTransition(async () => {
              try {
                // agencyId is derived server-side from the session (IDOR fix).
                await createExchangeRequest(
                  workspaceId,
                  fd.get("url") as string,
                  fd.get("keyword") as string,
                  fd.get("topic") as string,
                );
                toast.success("Request posted to the exchange");
                setOpen(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not post the request");
              }
            })
          }
        >
          {/* The sidebar chooses the site; this only asks in the all-workspaces
              view, where there is no scope to inherit (2026-09-02). */}
          {!scopedId && workspaces.length > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Workspace</span>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className={inputClass}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Target URL</span>
            <input name="url" type="url" required placeholder="https://example.com/page" className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Keyword</span>
              <input name="keyword" required placeholder="seo tool" className={inputClass} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Topic</span>
              <input name="topic" required placeholder="SEO automation" className={inputClass} />
            </label>
          </div>

          {/* Stated at the point of asking, because the honest version of this
              feature is the one where nobody expects a ranking lift from it.
              Exchanged links are placed and verified as rel="nofollow sponsored"
              (lib/seo/exchange.ts), which is what keeps the network on the right
              side of Google's and Bing's link-spam policies, and also what makes
              it pass no authority. */}
          <p className="rounded-[7px] border border-line bg-panel px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
            Exchanged links are always marked{" "}
            <code className="rounded bg-panel-2 px-1 font-mono text-[0.9em]">rel=&quot;nofollow sponsored&quot;</code>.
            Google and Bing treat compensated links without that mark as link spam, and sites on both
            ends can be penalised; marked, the link passes no ranking authority. What a placement gives
            you is a relevant mention on a real page, the referral traffic it earns, and a citation an AI
            assistant may read. It will not move your position in Google, and anyone offering followed
            links for credits is running a link scheme this network refuses to place.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Submitting…" : "Submit request"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
