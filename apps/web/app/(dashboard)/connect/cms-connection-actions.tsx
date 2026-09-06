"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { disconnectIntegration, testConnection } from "@/app/actions/integrations";

/**
 * What a connected CMS tile can do.
 *
 * It used to offer one button, labelled "Connect", linking to the dialog with
 * every credential field blank and required - so a connected tile looked
 * exactly like an unconnected one, and there was no way to remove a
 * connection or to check whether the credentials still worked.
 * `disconnectIntegration` and `testConnection` both existed in
 * app/actions/integrations.ts with no caller anywhere in the UI; this is that
 * caller. Compare the Google and Bing tiles, which already said "Reconnect".
 *
 * Disconnect asks twice rather than once, because it drops stored credentials
 * and the person cannot get them back from here.
 */
export function CmsConnectionActions({
  integrationId,
  workspaceIntegrationId,
  name,
}: {
  integrationId: string;
  workspaceIntegrationId: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function runTest() {
    setTesting(true);
    try {
      const result = await testConnection(workspaceIntegrationId);
      if (result.ok) {
        toast.success(`${name} answered.`);
      } else {
        toast.error(`${name} refused: ${result.error ?? "no reason given"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not reach ${name}`);
    } finally {
      setTesting(false);
    }
  }

  function remove() {
    startTransition(async () => {
      try {
        await disconnectIntegration(workspaceIntegrationId);
        toast.success(`${name} disconnected. Its credentials are deleted.`);
        setConfirming(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not disconnect");
      }
    });
  }

  return (
    <div className="flex gap-1.5">
      <Link href={`/connect?connect=${integrationId}`} className="flex-1">
        <Button size="sm" className="w-full justify-center" title={`Enter new credentials for ${name}`}>
          Reconnect
        </Button>
      </Link>
      <Button
        size="sm"
        onClick={runTest}
        disabled={testing || pending}
        title={`Ask ${name} to answer with the stored credentials. Nothing is published.`}
      >
        {testing ? "Testing…" : "Test"}
      </Button>
      <Button
        size="sm"
        onClick={() => (confirming ? remove() : setConfirming(true))}
        disabled={pending}
        title={
          confirming
            ? `Press again to delete the stored ${name} credentials`
            : `Remove this ${name} connection`
        }
      >
        {pending ? "Removing…" : confirming ? "Sure?" : "Disconnect"}
      </Button>
    </div>
  );
}
