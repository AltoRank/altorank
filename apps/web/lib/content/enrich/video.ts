// ---------------------------------------------------------------------------
// Step 4: one video, where the article teaches something
// ---------------------------------------------------------------------------
//
// A how-to section is the one place a video earns its height: the reader is
// about to follow steps and can watch them instead. Everywhere else an embed
// is a slow iframe between two paragraphs. So: find the first section that
// reads as instructions, search with its heading rather than the article
// keyword, and embed the top result from the privacy-enhanced host.
//
// `lib/youtube/search` returns nothing when no key is configured, and this
// step does the same: no key, no video, no warning. With a channel set, the
// search is restricted to it, and a channel with nothing on the topic means
// no video rather than someone else's.

import { searchYouTubeVideos, type YouTubeVideo } from "@/lib/youtube/search";
import { labelsFor } from "./labels";
import { splitSections, firstParagraph, hasVideoEmbed, escapeAttr, escapeHtml } from "./html";

export interface VideoOptions {
  /** `workspace_output_settings.video`; defaults on. */
  enabled?: boolean;
  search?: (query: string) => Promise<YouTubeVideo[]>;
  language?: string | null;
  /** `workspace_output_settings.youtube_channel`: search only this channel. Ignored when `search` is injected. */
  channel?: string | null;
}

const HOW_TO_HEADING =
  /^(how to|how do|how can|how should|steps? to|step[- ]by[- ]step|setting up|getting started|installing|configuring|come (fare|si|installare|configurare)|cómo|comment|wie (man|du|sie))\b|\b(tutorial|walkthrough|guida passo|paso a paso|étape par étape|schritt für schritt)\b/i;

/**
 * Whether a section reads as instructions: a how-to heading, or a numbered
 * list of at least three steps under it.
 */
export function isHowToSection(headingText: string, body: string): boolean {
  if (HOW_TO_HEADING.test(headingText.trim())) return true;
  const ol = body.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i);
  return !!ol && (ol[1].match(/<li\b/gi) ?? []).length >= 3;
}

export function renderVideoFigure(video: YouTubeVideo, language?: string | null): string {
  const labels = labelsFor(language);
  const caption = `${labels.video}: ${video.title} (${video.channelTitle}, ${labels.onYouTube.replace(/^(on|su|en|sur|auf)\s+/i, "")})`;
  return (
    `<figure class="video-embed">` +
    `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.videoId)}" ` +
    `title="${escapeAttr(video.title)}" loading="lazy" ` +
    `allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ` +
    `referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>` +
    `<figcaption>${escapeHtml(caption)}</figcaption>` +
    `</figure>`
  );
}

export async function addHowToVideo(
  html: string,
  opts: VideoOptions = {},
): Promise<{ html: string; added: boolean }> {
  if (opts.enabled === false) return { html, added: false };
  if (hasVideoEmbed(html)) return { html, added: false };
  const { intro, sections } = splitSections(html);
  const target = sections.find((s) => isHowToSection(s.headingText, s.body));
  if (!target) return { html, added: false };

  const search = opts.search ?? ((q: string) => searchYouTubeVideos(q, 1, { channel: opts.channel }));
  const results = await search(target.headingText);
  const video = results[0];
  if (!video?.videoId) return { html, added: false };

  const figure = renderVideoFigure(video, opts.language);
  // After the section's first paragraph, so the reader gets the sentence that
  // says what the steps achieve before the player.
  const p = firstParagraph(target.body);
  const at = p ? p.end : 0;
  const body = target.body.slice(0, at) + "\n" + figure + "\n" + target.body.slice(at);

  return {
    html: intro + sections.map((s) => s.heading + (s === target ? body : s.body)).join(""),
    added: true,
  };
}
