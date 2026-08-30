import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { ReadinessCheck } from "@/components/dashboard/readiness-check";

export const metadata: Metadata = { title: "Agent readiness" };

export default function ReadinessPage() {
  return (
    <>
      <PageHead
        title="Agent readiness"
        subtitle="Check whether an AI assistant can actually read a site, then generate the fixes. Works on any domain, no workspace required."
      />
      <ReadinessCheck />
    </>
  );
}
