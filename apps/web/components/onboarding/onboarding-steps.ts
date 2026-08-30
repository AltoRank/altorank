export type StepId =
  | "add-client"
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
    id: "add-client",
    title: "Add your first client",
    description:
      "Each client gets a workspace with keyword tracking, content pipeline, CMS publishing, and a trained brand voice. The table below shows all your clients with their traffic, domain rating, and content status.",
    actionLabel: 'Click "Add client" to create your first workspace.',
    completionMessage: "Client workspace created! You can now add keywords and content for this client.",
    route: "/clients",
    targetSelector: '[data-onboarding="add-client"]',
    tooltipPosition: "bottom",
  },
  {
    id: "add-keywords",
    title: "Add target keywords",
    description:
      "Track search volume, ranking difficulty, and SERP position for every keyword. Filter by intent type and difficulty to find easy wins.",
    actionLabel: 'Click "Find new keywords" to add a keyword to track.',
    completionMessage: "Keywords added! We'll start tracking their performance.",
    route: "/keywords",
    targetSelector: '[data-onboarding="add-keywords"]',
    tooltipPosition: "bottom",
  },
  {
    id: "generate-article",
    title: "Generate your first article",
    description:
      "Our AI generates SEO-optimized articles using your brand voice and target keyword. Each article gets an SEO score and can be published directly to your CMS.",
    actionLabel: 'Click "New article" to generate your first piece of content.',
    completionMessage: "Article generation started! It'll be ready in a few moments.",
    route: "/articles",
    targetSelector: '[data-onboarding="ask-ai"]',
    tooltipPosition: "left",
  },
  {
    id: "connect-cms",
    title: "Connect your CMS",
    description:
      "Connect WordPress, Shopify, or Magento to publish articles directly from AltoRank. Each workspace can have its own CMS connection.",
    actionLabel: 'Click "New connection" to set up your first CMS integration.',
    completionMessage: "CMS connected! You can now publish articles directly.",
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
    completionMessage: "Brand voice trained! All new content will match this tone.",
    route: "/voice",
    targetSelector: '[data-onboarding="train-voice"]',
    tooltipPosition: "bottom",
  },
];
