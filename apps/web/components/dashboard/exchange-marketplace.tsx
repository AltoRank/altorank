"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Icons } from "@/components/ui";
import { hostExchangeRequest, type HostRequestState } from "@/app/actions/exchange";
import type { OpenRequest } from "@/lib/queries/exchange";

/**
 * One request, and the button that takes it.
 *
 * Deliberately says what the publisher spends as well as what they get. Since
 * migration 039 that is a credit rather than one of their own monthly articles:
 * the writing is billed to whoever asked for it. The number in the Credits
 * column is what publishing will cost, not what it will earn.
 */
function RequestRow({ request, workspaceId }: { request: OpenRequest; workspaceId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<HostRequestState, FormData>(hostExchangeRequest, null);

  useEffect(() => {
    if (!state?.ok) return;
    toast.success(`Writing about "${state.keyword}" for your blog`, {
      description: "It lands in your review queue in a few minutes. Nothing publishes without your approval.",
    });
    router.refresh();
  }, [state, router]);

  let host: string;
  try {
    host = new URL(request.targetUrl).host;
  } catch {
    host = request.targetUrl;
  }

  return (
    <tr>
      <td className="px-3.5 py-3 border-b border-line-soft align-top">
        <div className="font-medium text-ink">{request.targetTopic || "—"}</div>
        <a
          href={request.targetUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11.5px] text-ink-3 hover:text-ink hover:underline"
        >
          {host}
          <Icons.externalLink size={10} />
        </a>
        {state && !state.ok && (
          <div role="alert" className="mt-1.5 max-w-[52ch] text-[11.5px] leading-snug text-err-ink">
            {state.error}
          </div>
        )}
      </td>
      <td className="px-3.5 py-3 border-b border-line-soft align-top font-mono text-xs text-ink-2">
        {request.targetKeyword || "—"}
      </td>
      <td className="px-3.5 py-3 border-b border-line-soft align-top text-right font-mono text-xs text-ink-2">
        {request.creditsOffered === 1 ? "1 credit" : `${request.creditsOffered} credits`}
      </td>
      <td className="px-3.5 py-3 border-b border-line-soft align-top text-right">
        <form action={action}>
          <input type="hidden" name="exchange_id" value={request.id} />
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Checking fit…" : "Take this article"}
          </Button>
        </form>
      </td>
    </tr>
  );
}

export function ExchangeMarketplace({
  requests,
  workspaceId,
}: {
  requests: OpenRequest[];
  workspaceId: string | null;
}) {
  if (!workspaceId) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {["Topic", "Keyword", "Costs", ""].map((h, i) => (
              <th
                key={h || i}
                scope="col"
                className={`px-3.5 py-2.5 font-medium text-[11px] uppercase tracking-[0.06em] text-ink-3 border-b border-line bg-panel ${
                  h === "Costs" ? "text-right" : "text-left"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {requests.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3.5 py-8 text-center text-ink-3">
                Nobody is asking for a link right now.
              </td>
            </tr>
          )}
          {requests.map((r) => (
            <RequestRow key={r.id} request={r} workspaceId={workspaceId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
