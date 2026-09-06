// ---------------------------------------------------------------------------
// Where a report PDF lives, and for how long a link to it works
// ---------------------------------------------------------------------------
//
// The `reports` bucket is private (066). `reports.url` holds the object's
// path inside the bucket, and a link is minted on demand with
// `createSignedUrl`: the cron for the email, the dashboard per click. Rows
// written before 066 hold the old public URL; the path is recovered from it.

export const REPORTS_BUCKET = "reports";

/** A month is long enough for the email, short enough that a forwarded link dies. */
export const EMAIL_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A dashboard click opens the PDF now; nobody bookmarks a signed URL. */
export const DASHBOARD_LINK_TTL_SECONDS = 60 * 60;

export function reportStoragePath(workspaceId: string, startDate: string, endDate: string): string {
  return `reports/${workspaceId}/${startDate}_${endDate}.pdf`;
}

/**
 * The object path behind a `reports.url` value: the path itself for rows
 * written since 066, or the path inside a public/signed URL from before.
 * Null when the value is neither.
 */
export function storagePathFromReportUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value.replace(/^\/+/, "") || null;
  try {
    const path = new URL(value).pathname;
    const m = path.match(new RegExp(`/${REPORTS_BUCKET}/(reports/.+\\.pdf)$`));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
