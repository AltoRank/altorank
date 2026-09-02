"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Icons, Button } from "@/components/ui";
import { scrapeAndTrainVoice } from "@/app/actions/onboard-workspace";
import { runKeywordResearch } from "@/app/actions/seo";
import { updateWorkspace, activateWorkspace } from "@/app/actions/workspaces";
import type { Workspace, Keyword, VoiceProfile } from "@/lib/types";

type SetupWizardProps = {
  workspace: Workspace;
  voice: VoiceProfile | null;
  keywords: Keyword[];
  /** Drafts already in this workspace; the last step reads differently when one exists. */
  articleCount?: number;
};

type StepId = "domain" | "voice" | "keywords" | "activate";
type StepResult = { ok: boolean; message: string };

export function SetupWizard({ workspace, voice, keywords, articleCount = 0 }: SetupWizardProps) {
  const router = useRouter();
  const [running, setRunning] = useState<StepId | null>(null);
  const [results, setResults] = useState<Partial<Record<StepId, StepResult>>>({});
  const [editingDomain, setEditingDomain] = useState(false);
  const [domainInput, setDomainInput] = useState(workspace.domain || "");
  const [isPending, startTransition] = useTransition();

  // Derived completion
  const domainDone = !!workspace.domain;
  const voiceDone = !!voice?.trained;
  const keywordsDone = keywords.length > 0;
  const allDone = domainDone && voiceDone && keywordsDone;

  const setResult = (id: StepId, result: StepResult) =>
    setResults((prev) => ({ ...prev, [id]: result }));

  // --- Actions ---

  async function handleSaveDomain() {
    const cleaned = domainInput.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!cleaned) return;

    setRunning("domain");
    try {
      const fd = new FormData();
      fd.set("domain", cleaned);
      await updateWorkspace(workspace.id, fd);
      setResult("domain", { ok: true, message: `Domain set to ${cleaned}` });
      setEditingDomain(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setResult("domain", { ok: false, message: err instanceof Error ? err.message : "Failed to save domain" });
    } finally {
      setRunning(null);
    }
  }

  async function handleTrainVoice() {
    setRunning("voice");
    try {
      const result = await scrapeAndTrainVoice(workspace.id);
      if (result === "trained") {
        setResult("voice", { ok: true, message: "Voice profile trained from your website" });
      } else if (result === "skipped") {
        setResult("voice", { ok: false, message: "Not enough text found on your site to train voice" });
      } else {
        setResult("voice", { ok: false, message: "Scraping failed — check that the domain is reachable" });
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setResult("voice", { ok: false, message: err instanceof Error ? err.message : "Voice training failed" });
    } finally {
      setRunning(null);
    }
  }

  async function handleDiscoverKeywords() {
    setRunning("keywords");
    try {
      const { discovered } = await runKeywordResearch(workspace.id);
      setResult("keywords", { ok: true, message: `Discovered ${discovered} keyword${discovered !== 1 ? "s" : ""}` });
      startTransition(() => router.refresh());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Keyword research failed";
      setResult("keywords", { ok: false, message: msg });
    } finally {
      setRunning(null);
    }
  }

  async function handleActivate() {
    setRunning("activate");
    try {
      await activateWorkspace(workspace.id);
      startTransition(() => router.refresh());
    } catch (err) {
      setResult("activate", { ok: false, message: err instanceof Error ? err.message : "Activation failed" });
      setRunning(null);
    }
  }

  // --- Steps ---

  type Step = {
    id: StepId;
    label: string;
    description: string;
    done: boolean;
    disabled: boolean;
  };

  const steps: Step[] = [
    { id: "domain", label: "Confirm domain", description: workspace.domain ? `Current: ${workspace.domain}` : "Set your website domain", done: domainDone, disabled: false },
    { id: "voice", label: "Scan website & train voice", description: "Scrapes your site content and builds a writing style profile", done: voiceDone, disabled: !domainDone },
    { id: "keywords", label: "Discover keywords", description: "Runs keyword research to find ranking opportunities", done: keywordsDone, disabled: !domainDone },
    {
      id: "activate",
      label: "Review & activate",
      description:
        articleCount > 0
          ? "Your first draft is already in the review queue. Activate to keep drafts coming on a schedule; nothing publishes without your approval."
          : "Go live: drafts are written on a schedule and wait for your approval",
      done: false,
      disabled: !allDone,
    },
  ];

  const completedCount = [domainDone, voiceDone, keywordsDone].filter(Boolean).length;

  return (
    <div className="max-w-xl space-y-4">
      <div className="mb-2">
        <h2 className="text-[15px] font-semibold">Set up the draft pipeline</h2>
        <p className="text-[13px] text-ink-3 mt-1">{completedCount}/3 steps complete — finish setup and the first draft lands in your review queue</p>
      </div>

      {steps.map((step, i) => {
        const isRunning = running === step.id;
        const result = results[step.id];

        return (
          <Card key={step.id} className="p-4" flush>
            <div className="flex items-start gap-3.5">
              {/* Step indicator */}
              <div className={`
                w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-semibold shrink-0 mt-0.5
                ${step.done
                  ? "bg-ok-soft text-ok-ink"
                  : step.disabled
                    ? "bg-panel-2 text-ink-3"
                    : "border border-line text-ink-2"
                }
              `}>
                {step.done ? <Icons.check size={14} /> : i + 1}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium">{step.label}</div>
                <div className="text-[12px] text-ink-3 mt-0.5">{step.description}</div>

                {/* Result message */}
                {result && (
                  <div className={`text-[12px] mt-2 ${result.ok ? "text-ok-ink" : "text-err-ink"}`}>
                    {result.message}
                  </div>
                )}

                {/* Domain editing inline */}
                {step.id === "domain" && !step.done && !editingDomain && (
                  <button
                    onClick={() => setEditingDomain(true)}
                    className="mt-2.5 text-[12px] text-accent font-medium hover:underline cursor-pointer"
                  >
                    Set domain
                  </button>
                )}
                {step.id === "domain" && editingDomain && (
                  <div className="flex items-center gap-2 mt-2.5">
                    <input
                      type="text"
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      placeholder="example.com"
                      className="flex-1 px-2.5 py-1.5 text-[13px] font-mono bg-panel border border-line rounded-md focus:outline-none focus:border-accent"
                      onKeyDown={(e) => e.key === "Enter" && handleSaveDomain()}
                      autoFocus
                    />
                    <Button size="sm" variant="primary" onClick={handleSaveDomain} disabled={isRunning || !domainInput.trim()}>
                      {isRunning ? "Saving…" : "Save"}
                    </Button>
                  </div>
                )}
                {step.id === "domain" && step.done && !editingDomain && (
                  <button
                    onClick={() => setEditingDomain(true)}
                    className="mt-1.5 text-[11px] text-ink-3 hover:text-ink-2 cursor-pointer"
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* Action button */}
              <div className="shrink-0">
                {step.id === "voice" && !step.done && (
                  <Button
                    size="sm"
                    onClick={handleTrainVoice}
                    disabled={step.disabled || isRunning || running !== null}
                  >
                    {isRunning ? <Spinner /> : <Icons.globe size={13} />}
                    {isRunning ? "Scanning…" : "Scan website"}
                  </Button>
                )}
                {step.id === "keywords" && !step.done && (
                  <Button
                    size="sm"
                    onClick={handleDiscoverKeywords}
                    disabled={step.disabled || isRunning || running !== null}
                  >
                    {isRunning ? <Spinner /> : <Icons.keywords size={13} />}
                    {isRunning ? "Searching…" : "Discover"}
                  </Button>
                )}
                {step.id === "activate" && (
                  <Button
                    size="sm"
                    variant="accent"
                    onClick={handleActivate}
                    disabled={step.disabled || isRunning || running !== null}
                  >
                    {isRunning ? <Spinner /> : <Icons.sparkle size={13} />}
                    {isRunning ? "Activating…" : "Activate"}
                  </Button>
                )}
                {step.done && step.id !== "activate" && (
                  <span className="text-[11px] text-ok-ink font-medium px-2 py-1 bg-ok-soft rounded-full">Done</span>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
