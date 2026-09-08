"use client";

import { useState } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

/**
 * One confirmation, for the handful of clicks that cannot be taken back.
 *
 * Deliberately narrow. A product that confirms everything trains people to
 * dismiss confirmations, so this is reserved for a consequence that is
 * irreversible or spends money: publishing to a live customer site, stopping
 * all writing for a workspace, pausing an account. Everything else - status
 * changes, holds, saving a setting - is undoable and gets no dialog.
 *
 * The rule the label follows: say what the click *does*, not "confirm". An OK
 * button confirms a word; "Publish to acme.com now" states the consequence at
 * the moment of the decision, which is the only moment it can be reconsidered.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Never mind",
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /** What happens, in a sentence. Not a restatement of the title. */
  body: React.ReactNode;
  /** The consequence, as a verb phrase: "Publish to acme.com now". */
  confirmLabel: string;
  pendingLabel?: string;
  cancelLabel?: string;
  /** Paints the confirm button as the dangerous one. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  async function go() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (pending) return;
        onOpenChange(v);
      }}
      title={title}
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[13px] leading-relaxed text-ink-2">{body}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "primary" : "accent"}
            onClick={() => void go()}
            disabled={pending}
            className={destructive ? "!bg-[var(--err)] !text-white hover:!opacity-90" : undefined}
          >
            {pending ? (pendingLabel ?? "Working…") : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
