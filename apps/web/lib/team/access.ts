// ---------------------------------------------------------------------------
// Roles and workspace access, the parts a unit test can reach
// ---------------------------------------------------------------------------
//
// Three roles, unchanged since 001: owner, admin, editor. Editors can create
// and manage content but cannot invite or remove users or manage billing.
// Admins can do all of that except pay. Owners pay.
//
// Orthogonal to the role is *which workspaces* a member sees:
// `agency_members.workspace_ids`, NULL for every workspace (including ones added
// later) and an array for exactly those. The database enforces it
// (migration 053, user_workspace_ids()); this file is the vocabulary the
// Team page and its actions share.

export type Role = "owner" | "admin" | "editor";

export const ROLES: readonly Role[] = ["owner", "admin", "editor"] as const;

/** What an invite may grant. Ownership is not handed out by email. */
export const INVITABLE_ROLES: readonly Exclude<Role, "owner">[] = ["editor", "admin"] as const;

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
};

export const EDITOR_LIMITS_COPY =
  "Editors can create and manage content but cannot invite or remove users or manage billing.";

/** Invite, remove, change access. */
export function canManageMembers(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Checkout, portal, pause, cancel. */
export function canManageBilling(role: string | null | undefined): boolean {
  return role === "owner";
}

/**
 * Add a workspace to the account.
 *
 * Billing-shaped rather than content-shaped, which is why it is not something
 * an editor does: every plan sells a number of workspaces ("Up to 3
 * workspaces"), a new one takes a slot, and every workspace added shares the
 * account's monthly article allowance. When the plan is full the refusal an
 * editor got said "Upgrade on the Billing page" - a page they can only read.
 *
 * The other door that creates workspaces - `createWorkspacesFromProperties`,
 * behind Connect Search Console - has been owner/admin since it was written.
 * `createWorkspace` had no role check at all, so a member scoped to one site
 * could add a fourth to somebody else's account (verified 2026-09-06). Same
 * rule now, both doors.
 */
export function canAddWorkspace(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Turn a multi-select's values into what the column stores.
 *
 * Empty means all workspaces, so an empty selection becomes NULL rather than an
 * empty array - an empty array would be a member who can see nothing, which
 * no form offers. Anything not in `allowed` (the agency's own workspaces) is
 * dropped: the ids arrive from the browser.
 */
export function parseWorkspaceIds(values: readonly unknown[], allowed: readonly string[]): string[] | null {
  const allow = new Set(allowed);
  const picked = Array.from(
    new Set(values.filter((v): v is string => typeof v === "string" && allow.has(v))),
  );
  return picked.length === 0 ? null : picked;
}

/** "All workspaces", or their names, for the Team table. */
export function accessLabel(
  workspaceIds: readonly string[] | null | undefined,
  namesById: ReadonlyMap<string, string>,
): string {
  if (!workspaceIds) return "All workspaces";
  const names = workspaceIds.map((id) => namesById.get(id)).filter((n): n is string => Boolean(n));
  if (names.length === 0) return "No workspaces";
  return names.join(", ");
}

/**
 * Whether `actor` may change or remove `target`.
 *
 * Nobody edits themselves here (a sign-out is not a demotion). Owners are
 * touched only by owners, so an admin cannot lock the account's payer out.
 */
export function canEditMember(
  actor: { userId: string; role: string },
  target: { userId: string; role: string },
): boolean {
  if (!canManageMembers(actor.role)) return false;
  if (actor.userId === target.userId) return false;
  if (target.role === "owner" && actor.role !== "owner") return false;
  return true;
}
