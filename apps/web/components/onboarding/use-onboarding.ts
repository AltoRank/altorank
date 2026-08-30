"use client";

import { useContext } from "react";
import { OnboardingContext } from "./onboarding-provider";

export function useOnboarding() {
  return useContext(OnboardingContext);
}
