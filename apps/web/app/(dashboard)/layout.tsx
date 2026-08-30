import { cookies } from "next/headers";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { createClient } from "@/lib/supabase/server";
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";
import { WorkspaceProvider } from "@/components/dashboard/workspace-context";
import { ensureAgency } from "@/lib/queries/agency";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [workspaces, articles, supabase, cookieStore] = await Promise.all([
    getWorkspaces(),
    getArticles(),
    createClient(),
    cookies(),
  ]);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const meta = user?.user_metadata ?? {};

  if (user) await ensureAgency(user.id, meta);

  const initialWorkspaceId = cookieStore.get("active_workspace")?.value;

  const showOnboarding =
    !meta.onboarding_completed && !meta.onboarding_dismissed;
  const initialSteps: Record<string, boolean> =
    meta.onboarding_steps ?? {};

  const content = (
    <WorkspaceProvider workspaces={workspaces} initialId={initialWorkspaceId}>
      <div className="grid h-screen min-h-[720px]" style={{ gridTemplateColumns: "var(--sidebar-w) 1fr" }}>
        <Sidebar badges={{ articles: articles.length }} />
        <div className="flex flex-col min-h-0 bg-bg">
          <Topbar />
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">{children}</main>
        </div>
      </div>
    </WorkspaceProvider>
  );

  if (!showOnboarding) return content;

  return (
    <OnboardingProvider initialSteps={initialSteps}>
      {content}
    </OnboardingProvider>
  );
}
