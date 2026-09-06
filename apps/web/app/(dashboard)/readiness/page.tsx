import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { ReadinessCheck } from "@/components/dashboard/readiness-check";
import { HowItWorks } from "@/components/dashboard/how-it-works";
import { readinessExplainer } from "@/lib/explainers";

export const metadata: Metadata = { title: "Agent readiness" };

export default function ReadinessPage() {
  return (
    <>
      <PageHead
        title="Agent readiness"
        subtitle="Whether an AI assistant can read a site, and the fixes if it cannot. Any domain, no workspace needed."
        actions={<HowItWorks explainer={readinessExplainer} />}
      />
      {/* This page put its cards flush against the sidebar and the topbar
          while every other surface insets them by px-8 py-6, so the one page
          a prospect is most likely to be shown was the one that looked
          unfinished. */}
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <ReadinessCheck />
      </div>
    </>
  );
}
