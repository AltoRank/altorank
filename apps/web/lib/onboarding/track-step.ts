// ---------------------------------------------------------------------------
// Say which onboarding step the browser reached, without waiting for it
// ---------------------------------------------------------------------------
//
// Fire and forget: a `keepalive` POST to /api/onboard/step, never awaited by
// the caller and never retried, so a slow or failing write cannot hold up the
// screen or a navigation (a checkout redirect still lets it leave). Once per
// step per page load; the server keeps it once per step per workspace.

import type { OnboardingStepName } from "./step-names";

const sent = new Set<string>();

export function trackStep(step: OnboardingStepName, data: { workspaceId?: string; ms?: number; count?: number } = {}): void {
  const key = `${data.workspaceId ?? ""}:${step}`;
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
