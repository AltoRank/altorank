"use client";

import { useState } from "react";
import type { MetaDescriptionResult } from "@/lib/tools/types";
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
      className="shrink-0 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10.5px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CharBadge({ count }: { count: number }) {
  const isGood = count >= 150 && count <= 160;
  return (
    <span
      className={`rounded-full px-1.5 py-[1px] font-mono text-[10px] ${
        isGood
          ? "bg-[oklch(0.95_0.03_155)] text-[oklch(0.4_0.1_155)]"
          : "bg-[oklch(0.95_0.03_85)] text-[oklch(0.45_0.1_85)]"
      }`}
    >
      {count} chars
    </span>
  );
}

export function MetaResult({ result }: { result: MetaDescriptionResult }) {
  // Show first 2 free, gate the rest behind email
  const freeVariants = result.variants.slice(0, 2);
  const gatedVariants = result.variants.slice(2);
  const [unlocked, setUnlocked] = useState(false);

  const visibleGated = unlocked ? gatedVariants : [];

  return (
    <div className="mt-8 space-y-4">
      {/* Free variants */}
      {freeVariants.map((variant, i) => (
        <div
          key={i}
          className="rounded-xl border border-line bg-bg p-4"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-accent-soft px-2 py-[1px] font-mono text-[10.5px] text-accent-ink">
              {variant.style}
            </span>
            <CharBadge count={variant.charCount} />
            <div className="ml-auto">
              <CopyButton text={variant.text} />
            </div>
          </div>
          <p className="text-sm leading-relaxed text-ink">{variant.text}</p>
        </div>
      ))}

      {/* Gated variants */}
      {!unlocked && gatedVariants.length > 0 && (
        <div className="relative">
          {/* Preview (blurred) */}
          <div className="pointer-events-none space-y-4 opacity-40 blur-[2px]">
            {gatedVariants.slice(0, 1).map((variant, i) => (
              <div
                key={i}
                className="rounded-xl border border-line bg-bg p-4"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-accent-soft px-2 py-[1px] font-mono text-[10.5px] text-accent-ink">
                    {variant.style}
                  </span>
                  <CharBadge count={variant.charCount} />
                </div>
                <p className="text-sm leading-relaxed text-ink">
                  {variant.text}
                </p>
              </div>
            ))}
          </div>

          {/* Email gate overlay */}
          <div className="mt-4">
            <EmailGate
              toolSlug="meta-description-generator"
              label={`Unlock all ${result.variants.length} variants`}
              description="Enter your email to see every style variant and save them."
              context={{ keyword: result.keyword }}
              emailSubject={`Meta Descriptions: ${result.keyword}`}
              emailBody={result.variants
                .map(
                  (v) =>
                    `<p style="margin-bottom:16px;"><strong style="color:#1a1a1a;">${v.style}</strong> <span style="color:#999;">(${v.charCount} chars)</span><br/><span style="color:#666;">${v.text}</span></p>`,
                )
                .join("")}
              onSuccess={() => setUnlocked(true)}
            />
          </div>
        </div>
      )}

      {/* Unlocked variants */}
      {visibleGated.map((variant, i) => (
        <div
          key={`gated-${i}`}
          className="rounded-xl border border-line bg-bg p-4"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-accent-soft px-2 py-[1px] font-mono text-[10.5px] text-accent-ink">
              {variant.style}
            </span>
            <CharBadge count={variant.charCount} />
            <div className="ml-auto">
              <CopyButton text={variant.text} />
            </div>
          </div>
          <p className="text-sm leading-relaxed text-ink">{variant.text}</p>
        </div>
      ))}
    </div>
  );
}
