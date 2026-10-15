// ---------------------------------------------------------------------------
// Roles and workspace access, the parts a unit test can reach
// ---------------------------------------------------------------------------
//
// Three roles, unchanged since 001: owner, admin, editor. Editors can create
// and manage content but cannot invite or remove users or manage billing.
// Admins can do all of that except pay. Owners pay.
//
// Orthogonal to the role is *which workspaces* a member sees:
// `account_members.workspace_ids`, NULL for every workspace (including ones added
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
 * no form offers. Anything not in `allowed` (the account's own workspaces) is
 * dropped: the ids arrive from the browser.
 */
export function parseWorkspaceIds(values: readonly unknown[], allowed: readonly string[]): string[] | null {
  const allow = new Set(allowed);
  const picked = Array.from(
    new Set(values.filter((v): v is string => typeof v === "string" && allow.has(v))),
  );
  return picked.length === 0 ? null : picked;
}

// ---------------------------------------------------------------------------
// A member limited to some sites acts within them
// ---------------------------------------------------------------------------
//
// Per-site access is a boundary only if nobody inside it can move it. A
// member whose own `workspace_ids` is a list - whatever their role - grants,
// changes and invites within that list and no further: never NULL (every
// site, including ones added later), never a site they do not hold, and never
// a role change for someone whose access reaches past their own. Sites a
// target holds that the actor cannot see are kept as they are, so a save from
// a narrower picker does not silently take them away. Migration 111 holds the
// database to the same rule (account_members_guard_roles, invites_guard_scope).

/**
 * API keys and connected apps (hosted MCP) act for the whole account: the
 * agent API resolves a key to its account, not to a list of sites. So a
 * member limited to some sites cannot create one, by hand or by approving a
 * connector, and the keys page and the consent screen say why.
 */
export const LIMITED_NO_KEYS =
  "API keys and connected apps reach every site on this account, so only a member with access to every site can create one.";

/** NULL is every site. */
export type SiteScope = readonly string[] | null;

export type SitesDecision = { ok: true; workspaceIds: string[] | null } | { ok: false; error: string };

export const LIMITED_PICK_ONE =
  "Pick at least one site. You can give access only to sites you have yourself.";
export const LIMITED_EVERY_SITE_TARGET =
  "This member has every site. Only a member with every site can change their access.";
export const LIMITED_ROLE_REACH =
  "This member has sites you do not. Only a member with every site can change their role.";
export const LIMITED_REMOVE_REACH =
  "This member has sites you do not. Only a member with every site can remove them.";
export const LIMITED_REVOKE_REACH =
  "This invite gives sites you do not have. Only a member with every site can revoke it.";
export const LIMITED_DOMAIN =
  "Only a member with access to every site can change a site's domain: its Search Console, Analytics and Bing data are matched by it.";

/** Whether this member is limited to some sites. */
export function isSiteLimited(sites: SiteScope | undefined): sites is readonly string[] {
  return Array.isArray(sites);
}

/** Whether `target` reaches no site outside `actor`. Every site reaches past any list. */
export function withinScope(actor: SiteScope, target: SiteScope): boolean {
  if (actor === null) return true;
  if (target === null) return false;
  const own = new Set(actor);
  return target.every((id) => own.has(id));
}

/**
 * The site list an invite carries. An actor with every site invites to any
 * (empty means every site, as before); a limited one invites to at least one
 * of their own and to nothing else.
 */
export function decideInviteSites(input: {
  actorSites: SiteScope;
  picked: readonly unknown[];
  accountSites: readonly string[];
}): SitesDecision {
  const { actorSites, picked, accountSites } = input;
  if (actorSites === null) return { ok: true, workspaceIds: parseWorkspaceIds(picked, accountSites) };
  const own = new Set(actorSites);
  const chosen = parseWorkspaceIds(picked, accountSites.filter((id) => own.has(id)));
  if (chosen === null) return { ok: false, error: LIMITED_PICK_ONE };
  return { ok: true, workspaceIds: chosen };
}

/**
 * What a member's site list becomes when `actor` saves `picked` for them.
 *
 * An actor with every site: the picked list, empty meaning every site. A
 * limited actor changes only the part of the list inside their own sites;
 * the rest of the target's list is kept, the result is never NULL and never
 * empty, and a target with every site is left alone.
 */
export function decideMemberSites(input: {
  actorSites: SiteScope;
  targetSites: SiteScope;
  picked: readonly unknown[];
  accountSites: readonly string[];
}): SitesDecision {
  const { actorSites, targetSites, picked, accountSites } = input;
  if (actorSites === null) return { ok: true, workspaceIds: parseWorkspaceIds(picked, accountSites) };

  const own = new Set(actorSites);
  const chosen = parseWorkspaceIds(picked, accountSites.filter((id) => own.has(id))) ?? [];
  if (targetSites === null) {
    // Every site is wider than the actor; the only save allowed leaves it so.
    return chosen.length === 0 ? { ok: true, workspaceIds: null } : { ok: false, error: LIMITED_EVERY_SITE_TARGET };
  }
  const kept = targetSites.filter((id) => !own.has(id));
  const next = Array.from(new Set([...kept, ...chosen]));
  if (next.length === 0) return { ok: false, error: LIMITED_PICK_ONE };
  return { ok: true, workspaceIds: next };
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
