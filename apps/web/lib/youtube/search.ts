export interface YouTubeVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
}

export interface YouTubeSearchOptions {
  /**
   * `UC…` channel id or `@handle` from `workspace_output_settings.youtube_channel`.
   * A handle costs one extra API call to resolve; an unresolvable one returns
   * no results rather than falling back to the whole of YouTube, because
   * "only my channel" set and ignored is worse than no video.
   */
  channel?: string | null;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * A `@handle` to its `UC…` id via the channels endpoint. Null when the handle
 * is unknown, the key is missing or the call fails.
 */
export async function resolveYouTubeChannelId(channel: string): Promise<string | null> {
  if (CHANNEL_ID.test(channel)) return channel;
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !channel.startsWith("@")) return null;
  const params = new URLSearchParams({ part: "id", forHandle: channel, key: apiKey });
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: { id?: string }[] };
    const id = data.items?.[0]?.id;
    return typeof id === "string" && CHANNEL_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Search YouTube Data API v3 for videos related to a query.
 * Requires YOUTUBE_API_KEY env var.
 */
export async function searchYouTubeVideos(
  query: string,
  maxResults = 3,
  options: YouTubeSearchOptions = {},
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
  if (options.channel) {
    const channelId = await resolveYouTubeChannelId(options.channel);
    if (!channelId) return [];
    params.set("channelId", channelId);
  }

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
