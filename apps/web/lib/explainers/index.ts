export type { Explainer, ExplainerSection } from "./types";
export { CANNOT_YET_HEADING, MIN_BULLETS, MAX_BULLETS } from "./types";
export { contentPlanExplainer } from "./content-plan";
export { reviewExplainer } from "./review";
export { keywordsExplainer } from "./keywords";
export { readinessExplainer } from "./readiness";
export { geoExplainer } from "./geo";
export { integrationsExplainer } from "./integrations";
export { backlinksExplainer } from "./backlinks";

import type { Explainer } from "./types";
import { contentPlanExplainer } from "./content-plan";
import { reviewExplainer } from "./review";
import { keywordsExplainer } from "./keywords";
import { readinessExplainer } from "./readiness";
import { geoExplainer } from "./geo";
import { integrationsExplainer } from "./integrations";
import { backlinksExplainer } from "./backlinks";

/** Every explainer, so the shape test cannot miss one added later. */
export const EXPLAINERS: readonly Explainer[] = [
  contentPlanExplainer,
  reviewExplainer,
  keywordsExplainer,
  readinessExplainer,
  geoExplainer,
  integrationsExplainer,
  backlinksExplainer,
];
