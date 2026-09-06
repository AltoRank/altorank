// ---------------------------------------------------------------------------
// Remote images, fetched for upload into a CMS media library
// ---------------------------------------------------------------------------
//
// A generated article references its images by URL on our storage. Publishing
// that URL as-is hot-links the customer's post to a bucket they do not control:
// the picture disappears the day the workspace is deleted, and every page view
// on their site is a request to ours. The REST adapter downloads each one and
// uploads it to the site's own media library instead; the WordPress plugin does
// the same in PHP (media_sideload_image).

const MAX_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export type RemoteImage = {
  bytes: Buffer;
  filename: string;
  contentType: string;
};

/**
 * Every absolute http(s) <img src> in the document that is not already on the
 * destination host. Relative sources are the site's own and are left alone.
 */
export function remoteImageUrls(html: string, destinationHost: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (!/^https?:\/\//i.test(src)) continue;
    try {
      if (new URL(src).host === destinationHost) continue;
    } catch {
      continue;
    }
    out.add(src);
  }
  return [...out];
}

/** Download one image. Throws on non-image responses and on anything over 10MB. */
export async function fetchRemoteImage(url: string): Promise<RemoteImage> {
  const res = await fetch(url, { headers: { "User-Agent": "AltoRank" } });
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}): ${url}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(`Not an image (${contentType || "no content-type"}): ${url}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Image over 10MB: ${url}`);

  return { bytes, filename: filenameFor(url, contentType), contentType };
}

/** A safe filename: the URL's last path segment when it has one, else derived from the type. */
export function filenameFor(url: string, contentType: string): string {
  const ext = EXTENSION_BY_TYPE[contentType] ?? "img";
  let base = "";
  try {
    base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    base = "";
  }
  base = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base) return `image.${ext}`;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}
