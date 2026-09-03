"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Dialog } from "@/components/ui";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { connectBing, type BingConnectState } from "@/app/actions/bing";

/**
 * Bing has no OAuth dance to send people through here; the credential is an
 * API key they copy from Bing Webmaster Tools. So the tile opens a small form
 * instead of redirecting, and the form says where the key lives, because
 * "paste your API key" with no map is how a connect button gets ignored.
 */
export function BingConnectButton({ connected }: { connected?: boolean }) {
  const { workspaces, active } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Success is handled where the result arrives, not in an effect watching the
  // state: closing the dialog and refreshing are consequences of this submit,
  // and an effect would re-fire them on any later render of the same result.
  const [state, action, pending] = useActionState<BingConnectState, FormData>(
    async (prev, formData) => {
      const result = await connectBing(prev, formData);
      if (result?.ok) {
        toast.success(
          result.rows
            ? `Bing connected: ${result.rows} days of clicks and impressions imported`
            : "Bing connected",
          result.warning ? { description: result.warning } : { description: result.siteUrl },
        );
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    null,
  );
  const target = active ?? workspaces[0];

  if (!target) {
    return (
      <Button size="sm" disabled className="w-full justify-center">
        Add a workspace first
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant={connected ? "ghost" : "accent"}
        className="w-full justify-center"
        onClick={() => setOpen(true)}
      >
        {connected ? `Reconnect for ${target.name}` : `Connect for ${target.name}`}
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Connect Bing Webmaster Tools"
        description="Read-only: clicks and impressions per day for the site, from Bing and the engines it powers."
      >
        <form action={action} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Workspace</span>
            <select
              name="workspace_id"
              defaultValue={target.id}
              required
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">API key</span>
            <input
              name="apiKey"
              type="password"
              required
              autoComplete="off"
              placeholder="Paste the key"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
            />
          </label>

          <p className="text-[12px] leading-relaxed text-ink-3">
            In Bing Webmaster Tools open Settings, then API access, and generate a key. The site must be
            verified there under this account; if it is already in Google Search Console, Bing can import
            it in one click. The key is stored encrypted and only ever used to read statistics.
          </p>

          {state && !state.ok && (
            <div role="alert" className="rounded-[7px] border border-err/40 bg-err-soft px-3 py-2 text-[12.5px] leading-relaxed text-err-ink">
              {state.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Checking with Bing…" : "Connect"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
