import { createClient } from "@/lib/supabase/server";
import type { CalendarEntry } from "@/lib/types";

export async function getCalendarEntries(workspaceId?: string, month?: string): Promise<CalendarEntry[]> {
  const supabase = await createClient();
  let query = supabase
    .from("calendar_entries")
    .select("*")
    .order("scheduled_date", { ascending: true });

  if (workspaceId) {
    query = query.eq("workspace_id", workspaceId);
  }

  if (month) {
    // month format: "2026-04"
    const start = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const end = `${nextMonth}-01`;
    query = query.gte("scheduled_date", start).lt("scheduled_date", end);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as CalendarEntry[];
}
