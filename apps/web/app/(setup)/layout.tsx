import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Setup runs outside the dashboard chrome.
 *
 * No sidebar, no workspace switcher, no nav: the wizard is the only thing on
 * screen because every one of those controls is an invitation to leave a flow
 * that takes four minutes and makes the rest of the product work.
 *
 * Auth is still required - this writes to a workspace - but the layout stops
 * there and does not fetch the counts, quota and membership the dashboard
 * layout needs.
 */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  return <div className="min-h-screen bg-bg">{children}</div>;
}
