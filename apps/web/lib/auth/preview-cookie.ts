import type { PlanTier } from "@/lib/stripe";

/**
 * The client-safe half of the customer preview.
 *
 * Split from `preview.ts` because three of the five callers cannot import that
 * file: the banner and the Operations control are client components, and
 * middleware runs on the edge - while `preview.ts` reaches for `next/headers`
 * and the Supabase server client. Importing it from a client component does
 * not fail a typecheck; it fails the build, with a stack that blames
 * `next/headers` rather than the import that dragged it in.
 *
 * Everything here is a constant or a pure function of a string. No I/O.
 */

export const PREVIEW_COOKIE = "operator_preview";

export type OperatorPreview = {
  /** Which plan to render the gates for. Undefined means "no plan at all". */
  plan?: PlanTier;
};

export function parsePreview(raw: string | undefined): OperatorPreview | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as OperatorPreview;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether this request carries a preview cookie at all. Cheap; no auth. */
export function hasPreviewCookie(raw: string | undefined): boolean {
  return parsePreview(raw) !== null;
}
