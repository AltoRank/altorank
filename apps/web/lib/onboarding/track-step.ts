// ---------------------------------------------------------------------------
// Say which onboarding step the browser reached, without waiting for it
// ---------------------------------------------------------------------------
//
// Fire and forget: a `keepalive` POST to /api/onboard/step, never awaited by
// the caller and never retried, so a slow or failing write cannot hold up the
// screen or a navigation (a checkout redirect still lets it leave). Once per
// step per page load - per ending, article or copy button for the steps that
// have one (./step-props.ts `stepKey`); the server keeps it once ever.

import type { OnboardingStepName } from "./step-names";
import { stepKey, type StepProps } from "./step-props";

const sent = new Set<string>();

export interface TrackStepData {
  workspaceId?: string;
  ms?: number;
  count?: number;
  /** For the article steps: the server finds the workspace from the article. */
  articleId?: string;
  /** For the checkout steps: the Stripe Checkout Session the form was opened on, once there is one. */
  checkoutId?: string;
  props?: StepProps;
}

export function trackStep(step: OnboardingStepName, data: TrackStepData = {}): void {
  const key = `${data.workspaceId ?? ""}:${step}:${stepKey(step, data)}`;
  if (sent.has(key) || typeof fetch !== "function") return;
  sent.add(key);
  try {
    void fetch("/api/onboard/step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step, ...data }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Instrumentation: nothing to do about it here.
  }
}
