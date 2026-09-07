"use client";

import { useCallback, useState } from "react";
import { Button, Icons } from "@/components/ui";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { ResearchDrawer } from "./research-drawer";
import { PlaybooksDialog } from "./playbooks-dialog";
import type { ResearchResult } from "@/lib/keyword-research/types";

/**
 * "Research keywords" and "Playbooks", wherever a plan is looked at.
 *
 * Follows the sidebar switcher: the drawer researches for the active
 * workspace and never offers a picker of its own. A playbook run lands in the
 * drawer's proposal table, so both buttons end on the same screen.
 *
 * `emphasis` exists because the page decides what its primary action is, not
 * this component. On /keywords, researching is the point of the screen and the
 * accent belongs here. On /content the primary action is scheduling the month,
 * which is accent in the page header - a second accent in the toolbar below it
 * meant the calendar had two loudest buttons and therefore none.
 */
export function ResearchButtons({
  size = "md",
  emphasis = "primary",
}: {
  size?: "sm" | "md";
  emphasis?: "primary" | "secondary";
}) {
  const { active } = useWorkspace();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [playbooksOpen, setPlaybooksOpen] = useState(false);
  const [handoff, setHandoff] = useState<{ result: ResearchResult; title: string } | null>(null);

  const onPlaybookResult = useCallback((result: ResearchResult, title: string) => {
    setHandoff({ result, title });
    setPlaybooksOpen(false);
    setDrawerOpen(true);
  }, []);

  if (!active) return null;

  return (
    <>
      <Button size={size} onClick={() => setPlaybooksOpen(true)}>
        <Icons.list size={14} />
        Playbooks
      </Button>
      <Button
        size={size}
        variant={emphasis === "primary" ? "accent" : "default"}
        onClick={() => { setHandoff(null); setDrawerOpen(true); }}
      >
        <Icons.sparkle size={14} />
        Research keywords
      </Button>

      <ResearchDrawer
        workspaceId={active.id}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        handoff={handoff}
      />
      <PlaybooksDialog
        workspaceId={active.id}
        open={playbooksOpen}
        onOpenChange={setPlaybooksOpen}
        onResult={onPlaybookResult}
      />
    </>
  );
}
