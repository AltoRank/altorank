import { cookies } from "next/headers";
import type { PlanTier } from "@/lib/stripe";

/**
 * Dev-only view simulation.
 *
 * "What does a Managed customer who is not us actually see?" was answered by
 * signing up test accounts, which leaves rows behind and still cannot make
 * you an operator or a paying customer. This reads a plain cookie that the
 * DevToolbar sets, so the answer becomes a dropdown.
 *
 * Guarded on NODE_ENV, not on a secret: in production this function returns
 * null before reading anything, so the cookie is inert there even if someone
 * sets it by hand. It changes what pages *show*, never what RLS lets through,
 * which is also why simulating "admin: off" is trustworthy but "admin: on"
 * only pretends: the Operations page re-checks the real email server-side.
 */
export type Simulation = {
  plan?: PlanTier;
  /** Simulate NOT being an operator, to see the nav a customer sees. */
  admin?: boolean;
};

export async function getSimulation(): Promise<Simulation | null> {
  if (process.env.NODE_ENV !== "development") return null;
  const jar = await cookies();
  const raw = jar.get("dev_simulation")?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Simulation;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
