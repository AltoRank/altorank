/** Server-controlled rollout; the page and worker must make the same choice. */
export function automaticFirstLookEnabled(workspaceId: string): boolean {
  const allowed = (process.env.AUTOMATIC_FIRST_LOOK_WORKSPACES ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return allowed.includes(workspaceId);
}
