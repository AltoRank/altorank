// Pure: imported by the client-side switcher, so nothing here may reach the
// server Supabase client. Deriving the allowance from a quota lives in
// ./allowance.ts, which the dashboard layout calls on the server.

/** What the switcher needs to say how many sites the plan allows. Null when unknown. */
export type SiteAllowance = { used: number; limit: number | null } | null;

/** "2 of 3 sites used", "4 sites, no limit", or a dash when nobody knows. */
export function siteSlotsLabel(a: SiteAllowance): string {
  if (!a) return "—";
  const noun = (n: number) => (n === 1 ? "site" : "sites");
  if (a.limit === null) return `${a.used} ${noun(a.used)}, no limit`;
  return `${a.used} of ${a.limit} ${noun(a.limit)} used`;
}

export function siteSlotsRemaining(a: SiteAllowance): number | null {
  if (!a || a.limit === null) return null;
  return Math.max(0, a.limit - a.used);
}
