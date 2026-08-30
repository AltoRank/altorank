"use client";

import { useState } from "react";
import Link from "next/link";
import type { ContentBrief } from "@/lib/tools/types";
import { EmailGate } from "./email-gate";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="ml-auto shrink-0 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10.5px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-3 text-left text-sm font-medium text-ink transition-colors hover:text-accent-ink"
      >
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {q}
      </button>
      {open && (
        <p className="pb-3 pl-[22px] text-[13px] leading-relaxed text-ink-2">
          {a}
        </p>
      )}
    </div>
  );
}

export function BriefResult({ brief }: { brief: ContentBrief }) {
  return (
    <div className="mt-8 space-y-6">
      {/* Title + Meta */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex-1">
            <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Suggested title
            </div>
            <h3 className="text-lg font-semibold tracking-[-0.015em] text-ink">
              {brief.title}
            </h3>
          </div>
          <CopyButton text={brief.title} />
        </div>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Meta description
            </div>
            <p className="text-sm leading-relaxed text-ink-2">
              {brief.metaDescription}
            </p>
          </div>
          <CopyButton text={brief.metaDescription} />
        </div>
        <div className="mt-4 flex items-center gap-4 border-t border-line-soft pt-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              Target
            </span>
            <span className="rounded-full bg-accent-soft px-2 py-[2px] font-mono text-[11px] font-medium text-accent-ink">
              {brief.wordCountTarget.toLocaleString()} words
            </span>
          </div>
        </div>
      </div>

      {/* Outline */}
      <div className="rounded-xl border border-line bg-bg p-5">
        <h3 className="mb-4 text-sm font-semibold tracking-[-0.005em]">
          Content Outline
        </h3>
        <div className="space-y-4">
          {brief.outline.map((section, i) => (
            <div key={i} className="border-l-2 border-accent-soft pl-4">
              <h4 className="text-[13.5px] font-semibold text-ink">
                {section.h2}
              </h4>
              {section.h3s.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {section.h3s.map((h3, j) => (
                    <li
                      key={j}
                      className="flex items-center gap-2 text-[12.5px] text-ink-2"
                    >
                      <span className="h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                      {h3}
                    </li>
                  ))}
                </ul>
              )}
              {section.keyPoints.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {section.keyPoints.map((point, k) => (
                    <span
                      key={k}
                      className="rounded bg-panel-2 px-2 py-[2px] text-[11px] text-ink-2"
                    >
                      {point}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* LSI Keywords */}
      {brief.lsiKeywords.length > 0 && (
        <div className="rounded-xl border border-line bg-bg p-5">
          <h3 className="mb-3 text-sm font-semibold tracking-[-0.005em]">
            LSI Keywords to Include
          </h3>
          <div className="flex flex-wrap gap-2">
            {brief.lsiKeywords.map((kw, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-[3px] text-[12px] text-ink-2"
              >
                {kw.keyword}
                {kw.searchVolume != null && (
                  <span className="rounded-full bg-accent-soft px-1.5 py-[1px] font-mono text-[10px] text-accent-ink">
                    {kw.searchVolume >= 1000
                      ? `${(kw.searchVolume / 1000).toFixed(1)}K`
                      : kw.searchVolume}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* FAQs */}
      {brief.faqs.length > 0 && (
        <div className="rounded-xl border border-line bg-bg p-5">
          <h3 className="mb-2 text-sm font-semibold tracking-[-0.005em]">
            FAQs to Address
          </h3>
          <div>
            {brief.faqs.map((faq, i) => (
              <FAQItem key={i} q={faq.question} a={faq.answer} />
            ))}
          </div>
        </div>
      )}

      {/* Competitor Insights */}
      {brief.competitorInsights && (
        <div className="rounded-xl border border-line bg-bg p-5">
          <h3 className="mb-2 text-sm font-semibold tracking-[-0.005em]">
            Competitor Insights
          </h3>
          <p className="text-sm leading-relaxed text-ink-2">
            {brief.competitorInsights}
          </p>
        </div>
      )}

      {/* Email gate */}
      <EmailGate
        toolSlug="content-brief-generator"
        label="Email me this brief"
        description="Get the full content brief delivered to your inbox as a formatted report."
        context={{ keyword: brief.keyword }}
        emailSubject={`Content Brief: ${brief.keyword}`}
        emailBody={`<h2 style="color:#1a1a1a;">${brief.title}</h2><p style="color:#666;">${brief.metaDescription}</p><p style="color:#666;">Word count target: ${brief.wordCountTarget.toLocaleString()}</p><p style="color:#999;font-size:13px;">Generated with AltoRank's free Content Brief Generator.</p>`}
      />

      {/* CTA */}
      <div className="rounded-xl border border-accent-soft bg-[radial-gradient(400px_200px_at_50%_0%,var(--accent-soft),transparent_70%)] p-6 text-center">
        <h3 className="mb-2 text-lg font-semibold tracking-[-0.015em]">
          Want AI to write this article?
        </h3>
        <p className="mb-4 text-sm text-ink-2">
          AltoRank turns content briefs into publish-ready, SEO-optimized
          articles — with your brand voice.
        </p>
        <Link
          href="/signup"
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-accent-2"
        >
          Try AltoRank free
          <svg
            className="h-[15px] w-[15px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
