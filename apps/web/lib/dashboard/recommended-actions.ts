// ---------------------------------------------------------------------------
// What to do next, and what it costs not to
// ---------------------------------------------------------------------------
//
// The dashboard's empty states used to be instructions ("Connect Search
// Console"). An instruction with no consequence is easy to ignore, and the
// consequences here are real: an approved article with no CMS is a draft
// forever, a plan with nothing on it means the cron writes nothing. Each card
// names the state, the consequence, and the one action that changes it.
//
// Derived from state the page already has. Nothing is fetched to decide what
// to recommend, and nothing is recommended on a guess.

export interface DashboardState {
  cmsConnected: boolean;
  gscConnected: boolean;
  pendingReviews: number;
  /** Planned entries with no article yet. */
  scheduledCount: number;
  /**
   * Keywords on the workspace, of any status.
   *
   * Without this the empty-plan card offered "Plan" to a workspace with nothing
   * to plan: the action ran, scheduled nothing, and reported "no keyword
   * qualifies or the plan is full" - a button that cannot work, failing quietly
   * after the click. An empty plan has two different causes and they need
   * different actions.
   */
  keywordCount: number;
}

export interface RecommendedAction {
  id: "connect-cms" | "connect-gsc" | "review-drafts" | "plan-month" | "research-keywords";
  title: string;
  /** What happens if this is left undone, in one sentence. */
  consequence: string;
  cta: string;
  /** Where the action lives, when it is a page. */
  href?: string;
  /** In-place action, when it is not. Handled by the strip's client component. */
  run?: "plan";
}

export function recommendedActions(state: DashboardState): RecommendedAction[] {
  const out: RecommendedAction[] = [];

  // Drafts first: they are the only item here that is waiting on a person.
  if (state.pendingReviews > 0) {
    out.push({
      id: "review-drafts",
      title: `${state.pendingReviews} draft${state.pendingReviews === 1 ? " is" : "s are"} waiting for your yes`,
      consequence: "Nothing publishes without your approval, so an unread draft is an article that never ships.",
      cta: "Review",
      href: "/articles",
    });
  }
  if (!state.cmsConnected) {
    out.push({
      id: "connect-cms",
      title: "No CMS connected",
      consequence: "Without a connected CMS, approved articles stay drafts and never reach your site.",
      cta: "Connect",
      href: "/connect",
    });
  }
  if (state.scheduledCount === 0) {
    // An empty plan has two causes and they need different actions. Offering
    // "Plan" with no keywords ran the action, scheduled nothing, and reported
    // "no keyword qualifies or the plan is full" after the click: a button that
    // could not work, failing quietly once pressed.
    out.push(
      state.keywordCount === 0
        ? {
            id: "research-keywords",
            title: "No keywords yet, so nothing can be scheduled",
            consequence:
              "The plan is built from keywords this site can realistically rank for. Until there are some, planning has nothing to place and no draft is written on any day.",
            cta: "Research",
            href: "/keywords",
          }
        : {
            id: "plan-month",
            title: "Nothing is scheduled",
            consequence:
              "An empty plan means no draft is written on any day; plan your month so the calendar has something to keep.",
            cta: "Plan",
            run: "plan",
          },
    );
  }
  if (!state.gscConnected) {
    out.push({
      id: "connect-gsc",
      title: "Search Console not connected",
      consequence: "Real search data improves keyword research and powers article performance; without it both run on estimates.",
      cta: "Connect",
      href: "/connect",
    });
  }
  return out;
}
