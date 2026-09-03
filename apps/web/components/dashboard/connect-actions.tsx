"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons } from "@/components/ui";
import { ConnectCmsDialog, isCmsType } from "@/components/dashboard/connect-cms-dialog";
import type { Workspace, Integration } from "@/lib/types";

interface ConnectActionsProps {
  workspaces: Workspace[];
  integrations: Integration[];
  /** From `/connect?connect=<cms>`: open the dialog on this platform's tab. */
  initialCmsType?: string | null;
}

/**
 * The Integrations page's trigger for the CMS connection dialog.
 *
 * The form itself lives in ConnectCmsDialog, because the article editor mounts
 * the same dialog rather than sending a half-edited draft to this page just to
 * have it auto-open.
 */
export function ConnectActions({ workspaces, integrations, initialCmsType }: ConnectActionsProps) {
  // A deep link lands on the right tab, so "Connect Webflow" in the editor
  // means Webflow and not a twelve-tab picker. Anything that is not a known
  // platform is ignored rather than trusted.
  const initial = isCmsType(initialCmsType) ? initialCmsType : null;
  const [open, setOpen] = useState(Boolean(initial));
  const router = useRouter();

  return (
    <>
      <Button
        variant="accent"
        data-onboarding="connect-cms"
        onClick={() => setOpen(true)}
      >
        <Icons.plus size={14} />
        New connection
      </Button>

      <ConnectCmsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Closing a deep-linked dialog drops the parameter, or a refresh
          // would reopen it.
          if (!next && initial) router.replace("/connect");
        }}
        workspaces={workspaces}
        integrations={integrations}
        initialCmsType={initialCmsType}
        onConnected={() => router.refresh()}
      />
    </>
  );
}
