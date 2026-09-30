// ---------------------------------------------------------------------------
// What a planned topic's verdict says about itself, in words for a screen
// ---------------------------------------------------------------------------
//
// The labels a topic can carry into the calendar, the first article's card
// and the setup screen, from its stored verdict (lib/keyword-research/
// opportunity.ts). Pure and client-safe, so every screen words them alike.

export interface TopicLabel {
  /** Short, for a pill. */
  label: string;
  /** One sentence, for a title attribute or a line under the pill. */
  explain: string;
}

/**
 * The labels a verdict carries, in the order a screen shows them.
 *
 * `current` is the keyword row as it is now. "Unmeasured" is stamped on the
 * verdict when the topic is judged, and a planned row is not judged again, so
 * a later metrics refresh that finds volume would leave a stale label hiding
 * the real number: the row's own volume, when it has one, wins.
 */
export function topicLabels(verdict: unknown, current?: { volume?: number | null }): TopicLabel[] {
  const o = verdict && typeof verdict === "object" ? (verdict as { confidence?: unknown; demand?: unknown; funnel?: unknown; tier?: unknown }) : null;
  const out: TopicLabel[] = [];
  if (o?.tier === "t3") {
    out.push({
      label: "Top of funnel",
      explain: "General interest in your field rather than one of your services: an easier article that earns a reader's trust before they need you. At most one in five planned topics is one.",
    });
  } else if (o?.funnel === "audience") {
    out.push({
      label: "Top of funnel",
      explain: "The reader has the problem you solve and is learning about it, not shopping yet: an article that earns their trust before they compare providers.",
    });
  }
  if (o?.confidence === "lower") {
    out.push({
      label: "Lower confidence",
      explain: "Planned to reach three topics: fewer than three were both about a service you sell and within reach, so this one is weaker on business value or on reach than we aim for.",
    });
  }
  const measuredNow = typeof current?.volume === "number";
  if (o?.demand === "unmeasured" && !measuredNow) {
    out.push({
      label: "Unmeasured",
      explain: "No search volume is reported for this phrase in your market yet, and your site has no impressions for it. Measured topics are always planned first.",
    });
  }
  return out;
}
