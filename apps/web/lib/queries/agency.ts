import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { Agency } from "@/lib/types";

export async function getAgency(): Promise<Agency | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from("agency_members")
    .select("agency_id")
    .eq("user_id", user.id)
    .single();

  if (!member) return null;

  const { data } = await supabase
    .from("agencies")
    .select("*")
    .eq("id", member.agency_id)
    .single();

  return (data as Agency) ?? null;
}

/**
 * Ensures the user has an agency. Returns their agency_id.
 * Fast path: single SELECT (user already has one).
 * Slow path: creates agency + membership via service role (runs once).
 */
export async function ensureAgency(
  userId: string,
  meta: Record<string, unknown>
): Promise<string> {
  const supabase = await createClient();

  const { data: existing, error } = await supabase
    .from("agency_members")
    .select("agency_id")
    .eq("user_id", userId)
    .limit(1)
    .single();

  if (existing) return existing.agency_id;

  // Distinguish "this user has no agency" from "the lookup failed". Only the
  // first justifies creating one.
  //
  // The error was previously discarded, so any failure fell through to the
  // create path. When an RLS recursion made this select raise on every call
  // (fixed in migration 016), the slug's Date.now() suffix meant nothing ever
  // collided and a fresh agency plus membership was inserted on every page
  // load. Silently provisioning on an unknown error is the more dangerous half
  // of that bug, because it turns any transient database problem into runaway
  // writes rather than a visible failure.
  //
  // PGRST116 is PostgREST for "no rows", which is the genuine no-agency case.
  if (error && error.code !== "PGRST116") {
    throw new Error(`Could not look up agency membership: ${error.message}`);
  }

  // Auto-create using service role (bypasses RLS)
  const admin = createServiceClient();
  const name = (meta.name as string) || "My Agency";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const { data: agency } = await admin
    .from("agencies")
    .insert({ name, slug: `${slug}-${Date.now()}` })
    .select("id")
    .single();

  if (!agency) throw new Error("Failed to create agency");

  await admin.from("agency_members").insert({
    agency_id: agency.id,
    user_id: userId,
    role: "owner",
  });

  return agency.id;
}
