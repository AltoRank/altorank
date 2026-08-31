export type StepId =
  | "add-workspace"
  | "add-keywords"
  | "generate-article"
  | "connect-cms"
  | "train-voice";

export type TooltipPosition = "right" | "bottom" | "left" | "top";

export interface OnboardingStep {
  id: StepId;
  title: string;
  description: string;
  actionLabel: string;
  completionMessage: string;
  route: string;
  targetSelector: string;
  tooltipPosition: TooltipPosition;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "add-workspace",
    title: "Add your first workspace",
    description:
      "One workspace per site, or per client if you run several. Each one carries its own keywords, drafts, CMS connection and brand voice, and nothing is shared between them.",
    actionLabel: 'Click "Add workspace" to create your first one.',
    completionMessage: "Workspace created. Keywords and content can go in it now.",
    route: "/workspaces",
    targetSelector: '[data-onboarding="add-workspace"]',
    tooltipPosition: "bottom",
  },
  {
    id: "add-keywords",
    title: "Add target keywords",
    description:
      "Track search volume, ranking difficulty, and SERP position for every keyword. Filter by intent type and difficulty to find easy wins.",
    actionLabel: 'Click "Find new keywords" to add a keyword to track.',
    completionMessage: "Keywords added. Rank tracking starts on the next run.",
    route: "/keywords",
    targetSelector: '[data-onboarding="add-keywords"]',
    tooltipPosition: "bottom",
  },
  {
    id: "generate-article",
    title: "Generate your first article",
    description:
      "Each draft is written to the target keyword in your brand voice, then scored twice: on-page SEO, and citation readiness, which is whether an AI answer can lift a passage from it. Claims without a source get flagged. Nothing publishes until you approve it.",
    actionLabel: 'Click "New article" to generate your first piece of content.',
    completionMessage: "Generation started. The draft lands in review when it is done.",
    route: "/articles",
    targetSelector: '[data-onboarding="ask-ai"]',
    tooltipPosition: "left",
  },
  {
    id: "connect-cms",
    title: "Connect your CMS",
    description:
      "Eleven CMS integrations publish over their own API, and a site that builds from a repository publishes as a git commit instead. We read the platform off your domain first, so most connections come down to one field.",
    actionLabel: 'Click "New connection" to set up your first CMS integration.',
    completionMessage: "CMS connected. Approved drafts can publish straight to it.",
    route: "/connect",
    targetSelector: '[data-onboarding="connect-cms"]',
    tooltipPosition: "bottom",
  },
  {
    id: "train-voice",
    title: "Train brand voice",
    description:
      "Paste a writing sample and we'll analyze tone, sentence structure, and style. All generated content will match this voice automatically.",
    actionLabel: 'Click "Train new voice" to create a brand voice profile.',
    completionMessage: "Brand voice trained. New drafts will match this tone.",
    route: "/voice",
    targetSelector: '[data-onboarding="train-voice"]',
    tooltipPosition: "bottom",
  },
];
