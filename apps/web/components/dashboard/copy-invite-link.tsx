"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/**
 * The email is a convenience, not the transport. When RESEND_API_KEY is
 * unset (true of this deployment today) the invite email fails silently by
 * design - the action treats it as non-fatal because the link still works.
 * But the link lived nowhere a person could reach: the pending list showed
 * email, role and expiry, and the only copy of the URL had just failed to
 * send. An invite that cannot be delivered by any means is not pending, it
 * is stuck.
 */
export function CopyInviteLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(`${window.location.origin}/invite/${token}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
