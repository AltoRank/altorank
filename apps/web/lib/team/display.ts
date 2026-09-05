// ---------------------------------------------------------------------------
// What to call a member on the Team page
// ---------------------------------------------------------------------------
//
// agency_members holds a user id and nothing about the person; the email and
// any name live in auth.users, which lib/queries/team resolves with the service
// role. This is the last step: pick the label, and the two letters on the
// avatar, from whatever was resolved.

export type ResolvedUser = {
  email: string;
  raw_user_meta_data: Record<string, unknown>;
} | null;

/** Shown when the user could not be resolved. Honest, and not a role name. */
export const UNKNOWN_MEMBER = "Unknown member";

/**
 * A name from the sign-up metadata when there is one, else the email. Both
 * metadata keys are read because both exist: the admin users page reads
 * `name` then `full_name`, and the Team page used to read only `full_name`.
 */
export function memberDisplayName(user: ResolvedUser): string {
  if (!user) return UNKNOWN_MEMBER;
  const meta = user.raw_user_meta_data ?? {};
  for (const key of ["full_name", "name"]) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return user.email;
}

/**
 * Two letters for the avatar. A name gives its first two initials; an email
 * gives the first two letters of its local part, so "mike@limineer.com" reads
 * "MI" rather than the "M" every member used to share. An unresolved user is a
 * question mark, not initials invented from the fallback label.
 */
export function memberInitials(user: ResolvedUser): string {
  if (!user) return "?";
  const label = memberDisplayName(user);
  const base = label.includes("@") ? label.slice(0, label.indexOf("@")) : label;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const initials = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return initials.toUpperCase();
}
