"use client";

import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { rewriteFieldAction } from "@/app/actions/editor-ai";
import type { MicroAction } from "@/lib/ai/micro";
import { AiActionMenu, ProposalCard } from "./ai-menu";
import { Counter } from "./counter";

// ---------------------------------------------------------------------------
// Title and meta description, with their counters and AI actions
// ---------------------------------------------------------------------------
//
// Both are proposed, never written: an action fills the card below the field,
// Accept moves it into the field (staged), Save is what persists. The counter
// (./counter) is a count against what a result page displays, red past it.

type Field = "title" | "meta_description";

export function MetaFields({
  articleId,
  title,
  meta,
  editable,
  outline,
  onTitle,
  onMeta,
}: {
  articleId: string;
  title: string;
  meta: string;
  /** Editor mode types into the fields; Review mode only proposes. */
  editable: boolean;
  outline: string[];
  onTitle: (next: string) => void;
  onMeta: (next: string) => void;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4">
      <AiField
        articleId={articleId}
        field="title"
        label="Title"
        value={title}
        editable={editable}
        outline={outline}
        onChange={onTitle}
        multiline={false}
      />
      <AiField
        articleId={articleId}
        field="meta_description"
        label="Meta description"
        value={meta}
        editable={editable}
        outline={outline}
        onChange={onMeta}
        multiline
      />
    </div>
  );
}

function AiField({
  articleId,
  field,
  label,
  value,
  editable,
  outline,
  onChange,
  multiline,
}: {
  articleId: string;
  field: Field;
  label: string;
  value: string;
  editable: boolean;
  outline: string[];
  onChange: (next: string) => void;
  multiline: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);

  const run = async (action: MicroAction, prompt?: string) => {
    if (!value.trim()) {
      toast.info(`Write a ${label.toLowerCase()} first, or ask the AI for one.`);
      if (action !== "ask") return;
    }
    setBusy(true);
    try {
      const res = await rewriteFieldAction({
        articleId,
        field,
        action,
        text: value.trim() || `(empty ${label.toLowerCase()})`,
        prompt,
        outline,
      });
      if (!res.ok) throw new Error(res.error);
      setProposal(res.text);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rewrite failed");
    } finally {
      setBusy(false);
    }
  };

  const inputClass = cn(
    "w-full rounded-[7px] border bg-bg px-3 py-2 text-ink focus:outline-0 focus:border-accent",
    editable ? "border-line" : "border-transparent bg-transparent px-0 cursor-default",
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{label}</span>
        <Counter text={value} field={field} />
        <div className="flex-1" />
        <AiActionMenu onAction={run} busy={busy} align="right" />
      </div>
      {multiline ? (
        <textarea
          value={value}
          readOnly={!editable}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          aria-label={label}
          className={cn(inputClass, "resize-y text-[13.5px] leading-[1.5]")}
          placeholder="No meta description yet"
        />
      ) : (
        <input
          value={value}
          readOnly={!editable}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className={cn(inputClass, "text-[22px] font-semibold tracking-[-0.01em]")}
          placeholder="Untitled"
        />
      )}
      {proposal !== null && (
        <ProposalCard
          className="mt-2"
          before={value}
          after={proposal}
          onAccept={() => {
            onChange(proposal);
            setProposal(null);
          }}
          onDiscard={() => setProposal(null)}
        >
          <div className="mt-1.5 flex justify-end">
            <Counter text={proposal} field={field} />
          </div>
        </ProposalCard>
      )}
    </div>
  );
}
