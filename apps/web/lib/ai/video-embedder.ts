import { searchYouTubeVideos } from "@/lib/youtube/search";

/**
 * Insert YouTube video embeds into article HTML at appropriate H2 positions.
 * Places one embed after the first or second H2 section.
 */
export async function embedYouTubeVideos(
  html: string,
  keyword: string,
): Promise<string> {
  const videos = await searchYouTubeVideos(keyword, 1);
  if (videos.length === 0) return html;

  const video = videos[0];
  const iframe = [
    '<figure class="video-embed">',
    `<iframe width="100%" height="400" src="https://www.youtube.com/embed/${video.videoId}" `,
    `title="${escapeAttr(video.title)}" frameborder="0" `,
    'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ',
    "allowfullscreen></iframe>",
    "</figure>",
  ].join("");

  // Find the second </h2> closing tag and insert after the next </p>
  const h2Pattern = /<\/h2>/gi;
  let match: RegExpExecArray | null;
  let h2Count = 0;
  let insertPos = -1;

  while ((match = h2Pattern.exec(html)) !== null) {
    h2Count++;
    if (h2Count === 2) {
      const afterH2 = html.indexOf("</p>", match.index);
      if (afterH2 !== -1) {
        insertPos = afterH2 + 4;
      }
      break;
    }
  }

  // Fallback: insert after first </p> if not enough h2s
  if (insertPos === -1) {
    const firstP = html.indexOf("</p>");
    if (firstP !== -1) {
      insertPos = firstP + 4;
    }
  }

  if (insertPos === -1) return html;

  return html.slice(0, insertPos) + "\n" + iframe + "\n" + html.slice(insertPos);
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
