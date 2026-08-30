export interface YouTubeVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
}

/**
 * Search YouTube Data API v3 for videos related to a query.
 * Requires YOUTUBE_API_KEY env var.
 */
export async function searchYouTubeVideos(
  query: string,
  maxResults = 3,
): Promise<YouTubeVideo[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return []; // Silently skip if not configured

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(maxResults),
    videoEmbeddable: "true",
    key: apiKey,
  });

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${params}`,
  );

  if (!res.ok) return [];

  const data = await res.json();

  return (data.items ?? []).map(
    (item: {
      id: { videoId: string };
      snippet: { title: string; channelTitle: string; thumbnails: { medium: { url: string } } };
    }) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails?.medium?.url ?? "",
    }),
  );
}
