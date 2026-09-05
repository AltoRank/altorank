"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Chip } from "@/components/ui";
import { chatResearch, type ResearchContext } from "@/app/actions/keyword-research";
import { CHAT_PROMPT_CHIPS, compactTrace, type ChatProposal, type ChatTurn } from "@/lib/keyword-research/chat";
import type { PlanCapacity, ResearchCandidate } from "@/lib/keyword-research/types";
import { ProposalTable } from "./proposal-table";

interface ChatTabProps {
  workspaceId: string;
  ctx: ResearchContext;
  onCapacity: (c: PlanCapacity) => void;
  onChanged: () => void;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  proposals?: ChatProposal[];
  trace?: string;
}

/**
 * A chat that can research and can only propose.
 *
 * Every card is a `ProposalTable`, so the Schedule button here is the same
 * button as everywhere else in the drawer and goes through the same action.
 */
export function ChatTab({ workspaceId, ctx, onCapacity, onChanged }: ChatTabProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [known, setKnown] = useState<ResearchCandidate[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || pending) return;
    const history: ChatTurn[] = [...messages.map((m) => ({ role: m.role, text: m.text })), { role: "user", text: clean }];
    setMessages((prev) => [...prev, { role: "user", text: clean }]);
    setInput("");
    setPending(true);
    try {
      const reply = await chatResearch(workspaceId, history, known);
      const fresh = reply.proposals.flatMap((p) => p.candidates);
      setKnown((prev) => {
        const seen = new Set(prev.map((c) => c.term.toLowerCase()));
        return [...prev, ...fresh.filter((c) => !seen.has(c.term.toLowerCase()))];
      });
      setMessages((prev) => [...prev, { role: "assistant", text: reply.text, proposals: reply.proposals, trace: reply.trace.length ? compactTrace(reply.trace) : undefined }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", text: err instanceof Error ? err.message : "Something went wrong." }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 min-h-full">
      {!ctx.modelReady && (
        <div className="text-[12.5px] text-warn-ink bg-warn-soft rounded-md px-3 py-2">Chat needs ANTHROPIC_API_KEY on the server. The other tabs work without it.</div>
      )}

      {messages.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink-2">Ask for keywords in plain language. I research with real search data and propose; you decide what goes on the calendar.</p>
          <div className="flex flex-wrap gap-1.5">
            {CHAT_PROMPT_CHIPS.map((c) => (
              <Chip key={c} label={c} soft disabled={pending || !ctx.modelReady} onClick={() => send(c)} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 flex-1">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end max-w-[85%]" : "self-start w-full"}>
            {m.role === "user" ? (
              <div className="rounded-xl bg-ink text-bg px-3.5 py-2 text-[13px] whitespace-pre-wrap">{m.text}</div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {m.trace && <div className="font-mono text-[11px] text-ink-3">{m.trace}</div>}
                <div className="text-[13px] text-ink whitespace-pre-wrap">{m.text}</div>
                {m.proposals?.map((p, j) => (
                  <div key={j} className="rounded-lg border border-line p-3 flex flex-col gap-2">
                    <div className="text-[12px] font-medium text-ink-2">
                      {p.kind === "schedule" ? "Proposed for the calendar" : p.kind === "store" ? "Proposed to store" : "Researched"}
                      <span className="text-ink-3 font-normal"> · {p.label}</span>
                    </div>
                    <ProposalTable
                      workspaceId={workspaceId}
                      candidates={p.candidates}
                      funnel={p.funnel}
                      onCapacity={onCapacity}
                      onChanged={onChanged}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {pending && <div className="text-[12.5px] text-ink-3 font-mono">Researching…</div>}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="sticky bottom-0 bg-bg pt-2 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={pending || !ctx.modelReady}
          placeholder="e.g. find 5 easy wins about onboarding"
          className="flex-1 px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
        />
        <Button type="submit" variant="accent" disabled={pending || !input.trim() || !ctx.modelReady}>Send</Button>
      </form>
    </div>
  );
}
