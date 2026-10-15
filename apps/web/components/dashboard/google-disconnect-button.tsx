"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { disconnectGoogle } from "@/app/actions/google-disconnect";

/**
 * Disconnect Google from the whole account: every site's Search Console and
 * Analytics connection and the account's consent are deleted, and the access
 * is revoked at Google. Synced numbers stay.
 *
 * Asks twice, like the CMS Disconnect, because the person cannot get the
 * connection back from here without going through Google's screen again.
 */
export function GoogleDisconnectButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function remove() {
    startTransition(async () => {
      try {
        const { revoked } = await disconnectGoogle();
        toast.success(
          revoked
            ? "Google disconnected. The stored access is deleted and revoked at Google."
            : "Google disconnected and the stored access is deleted. Google did not confirm the revoke; you can remove AltoRank at myaccount.google.com/permissions.",
        );
        setConfirming(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not disconnect Google");
      }
    });
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className={className ?? "w-full justify-center"}
      onClick={() => (confirming ? remove() : setConfirming(true))}
      disabled={pending}
      title={
        confirming
          ? "Press again to remove Google from every site on this account"
          : "Remove Search Console and Analytics from every site on this account and revoke the access at Google"
      }
    >
      {pending ? "Disconnecting…" : confirming ? "Disconnect from every site?" : "Disconnect Google"}
    </Button>
  );
}
