"use client";

import { useEffect } from "react";
import { trackStep } from "@/lib/onboarding/track-step";
import type { OnboardingStepName } from "@/lib/onboarding/step-names";
import type { StepProps } from "@/lib/onboarding/step-props";

/** Records one onboarding step when it is rendered (lib/onboarding/track-step.ts). Renders nothing. */
export function TrackStep({ step, workspaceId, props }: { step: OnboardingStepName; workspaceId?: string; props?: StepProps }) {
  // The props as one value, so a new object with the same words is not a new step.
  const said = props ? JSON.stringify(props) : "";
  useEffect(() => {
    trackStep(step, { ...(workspaceId ? { workspaceId } : {}), ...(said ? { props: JSON.parse(said) as StepProps } : {}) });
  }, [step, workspaceId, said]);
  return null;
}
