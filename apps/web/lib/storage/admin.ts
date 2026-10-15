import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The service-role client storage purges run with (lib/storage/purge.ts), or
 * null on a self-host without the key: nothing is removed there, as before,
 * rather than failing the delete.
 */
export function storageAdmin(): SupabaseClient | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? createServiceClient() : null;
}
