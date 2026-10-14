"use client";

import { useEffect } from "react";
import { trackStep } from "@/lib/onboarding/track-step";
import type { OnboardingStepName } from "@/lib/onboarding/step-names";

/** Records one onboarding step when it is rendered (lib/onboarding/track-step.ts). Renders nothing. */
export function TrackStep({ step, workspaceId }: { step: OnboardingStepName; workspaceId?: string }) {
  useEffect(() => {
    trackStep(step, workspaceId ? { workspaceId } : {});
  }, [step, workspaceId]);
  return null;
}
