"use client";

import { useTransition, useRef, useState } from "react";
import { toast } from "sonner";
import { createExchangeRequest } from "@/app/actions/exchange";
import { Button, Icons, Dialog } from "@/components/ui";

type Ws = { id: string; name: string };

type Props = {
  /** All of them: which site the link should point at is the request. */
  workspaces: Ws[];
  scopedId?: string | null;
};

/**
 * Ask another agency to link to one of your pages.
 *
 * The form is in a dialog rather than in place. It used to replace this button
 * inside the page header's action row, so four fields and two buttons had to
 * fit in the strip beside the title: the inputs were squeezed to fixed widths,
 * they wrapped over the header on a narrow window, and the labels sat closer to
 * the wrong field than the right one. A form with four required fields is not
 * a toolbar control.
 */
export function ExchangeRequestForm({ workspaces, scopedId }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [workspaceId, setWorkspaceId] = useState(scopedId ?? workspaces[0]?.id ?? "");
  const formRef = useRef<HTMLFormElement>(null);

  const inputClass =
    "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors";
  const labelClass = "text-[12.5px] font-medium text-ink-2";

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
        description="Offer credits for another site in the exchange to link to one of your pages."
      >
        <form
          ref={formRef}
          className="flex flex-col gap-3.5"
          action={(fd) =>
            startTransition(async () => {
              // agencyId is derived server-side from the session (IDOR fix).
              try {
                await createExchangeRequest(
                  workspaceId,
                  fd.get("url") as string,
                  fd.get("keyword") as string,
                  fd.get("topic") as string,
                );
                formRef.current?.reset();
                setOpen(false);
                toast.success("Request submitted");
              } catch (err) {
                // The dialog stays open with the fields still filled: a
                // rejected request is worth correcting, not retyping. Before
                // this a failure closed nothing, said nothing, and left the
                // form looking like it had worked.
                toast.error(
                  err instanceof Error ? err.message : "Could not submit the request",
                );
              }
            })
          }
        >
          {/* The sidebar chooses the site; this only asks in the
              all-workspaces view, where there is no scope to inherit. */}
          {!scopedId && workspaces.length > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className={labelClass}>Workspace</span>
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
            <span className={labelClass}>Target URL</span>
            <input
              name="url"
              type="url"
              required
              placeholder="https://example.com/page"
              className={inputClass}
            />
            <span className="text-[11.5px] text-ink-3">
              The page on your site the link should point at.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>Keyword</span>
            <input
              name="keyword"
              required
              placeholder="seo tool"
              className={inputClass}
            />
            <span className="text-[11.5px] text-ink-3">
              The anchor text you would like the link to use.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={labelClass}>Topic</span>
            <input
              name="topic"
              required
              placeholder="SEO automation"
              className={inputClass}
            />
            <span className="text-[11.5px] text-ink-3">
              What the linking article should be about, so the exchange can
              match you with a relevant site.
            </span>
          </label>

          <div className="mt-1 flex justify-end gap-2">
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
