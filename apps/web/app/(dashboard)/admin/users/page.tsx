import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { PageHead, Card, StatStrip, Chip } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { getOperator, isAdminEmail } from "@/lib/auth/admin";
import { PLAN_LABELS, type PlanTier } from "@/lib/stripe";
import type { AdminImpersonation } from "@/lib/types";
import { plural } from "@/lib/utils";
import { AdminTabs } from "../admin-tabs";
import { Table } from "../table";
import { ImpersonateButton } from "./impersonate-button";

export const metadata: Metadata = { title: "Users" };

/**
 * Every account, and a way into each one.
 *
 * Reads across all tenants, so like the costs pane it is gated on the operator
 * email and uses the service client: auth.users is not reachable any other
 * way, and RLS would hide every row that is not ours.
 *
 * Nothing here is estimated. A user who has never signed in shows a dash under
 * "last seen", not a date; an agency with no subscription shows "No plan",
 * not the `starter` default the row was created with.
 */

async function listAllUsers(admin: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < perPage) break;
  }
  return users;
}

type AgencyRow = { id: string; name: string; plan: PlanTier | null; plan_status: string | null };
type MemberRow = { user_id: string; agency_id: string; role: string };
type WorkspaceRow = { id: string; agency_id: string; domain: string | null };

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

function displayName(u: User): string | null {
  const meta = u.user_metadata ?? {};
  const name = (meta.name ?? meta.full_name) as unknown;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** Users whose last sign-in falls inside the trailing window. Outside the
 *  component so the clock read is not part of render. */
function seenWithin(users: User[], days: number): number {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return users.filter((u) => u.last_sign_in_at && new Date(u.last_sign_in_at).getTime() >= since).length;
}

function planLabel(agency: AgencyRow | undefined): string {
  if (!agency) return "—";
  const active = agency.plan_status === "active" || agency.plan_status === "trialing";
  if (!active || !agency.plan) return "No plan";
  return `${PLAN_LABELS[agency.plan]} · ${agency.plan_status}`;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const operator = await getOperator();
  if (!operator) notFound();

  const { q = "" } = await searchParams;
  const needle = q.trim().toLowerCase();

  const admin = createServiceClient();
  const [users, { data: members }, { data: agencies }, { data: workspaces }, { data: articles }, { data: log }] =
    await Promise.all([
      listAllUsers(admin),
      admin.from("agency_members").select("user_id, agency_id, role"),
      admin.from("agencies").select("id, name, plan, plan_status"),
      admin.from("workspaces").select("id, agency_id, domain"),
      admin.from("articles").select("workspace_id"),
      admin
        .from("admin_impersonations")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(25),
    ]);

  const agencyById = new Map((agencies ?? []).map((a) => [a.id, a as AgencyRow]));
  const membersByUser = new Map<string, MemberRow[]>();
  for (const m of (members ?? []) as MemberRow[]) {
    membersByUser.set(m.user_id, [...(membersByUser.get(m.user_id) ?? []), m]);
  }
  const workspacesByAgency = new Map<string, WorkspaceRow[]>();
  for (const w of (workspaces ?? []) as WorkspaceRow[]) {
    workspacesByAgency.set(w.agency_id, [...(workspacesByAgency.get(w.agency_id) ?? []), w]);
  }
  const articlesByWorkspace = new Map<string, number>();
  for (const a of articles ?? []) {
    articlesByWorkspace.set(a.workspace_id, (articlesByWorkspace.get(a.workspace_id) ?? 0) + 1);
  }

  const rows = users
    .map((u) => {
      const memberships = membersByUser.get(u.id) ?? [];
      const primary = memberships[0];
      const agency = primary ? agencyById.get(primary.agency_id) : undefined;
      const ws = agency ? workspacesByAgency.get(agency.id) ?? [] : [];
      const domains = ws.map((w) => w.domain).filter((d): d is string => Boolean(d));
      const articleCount = ws.reduce((n, w) => n + (articlesByWorkspace.get(w.id) ?? 0), 0);
      return {
        user: u,
        name: displayName(u),
        agency,
        role: primary?.role ?? null,
        extraAgencies: Math.max(0, memberships.length - 1),
        domains,
        articleCount,
        operator: isAdminEmail(u.email),
      };
    })
    .filter((r) => {
      if (!needle) return true;
      const hay = [r.user.email, r.name, r.agency?.name, ...r.domains]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    })
    .sort((a, b) => (b.user.created_at ?? "").localeCompare(a.user.created_at ?? ""));

  const confirmed = users.filter((u) => u.email_confirmed_at).length;
  const seenThisWeek = seenWithin(users, 7);
  const paying = (agencies ?? []).filter((a) => a.plan_status === "active" || a.plan_status === "trialing").length;

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span>
            {plural(users.length, "account")}
            {needle ? ` · ${plural(rows.length, "match", "matches")}` : ""}
          </span>
        }
        actions={
          <form method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Email, name, agency or domain"
              aria-label="Search accounts"
              className="w-[260px] rounded-[7px] border border-line bg-panel-2 px-2.5 py-1.5 text-[13px] focus:border-line focus:bg-bg focus:outline-0"
            />
            {needle && (
              <Link href="/admin/users" className="text-[12.5px] text-ink-3 hover:text-ink">
                Clear
              </Link>
            )}
          </form>
        }
      />

      <AdminTabs />

      <StatStrip
        stats={[
          { label: "Accounts", value: String(users.length), delta: `${confirmed} confirmed` },
          { label: "Seen this week", value: String(seenThisWeek), delta: "signed in within 7 days" },
          { label: "Agencies", value: String((agencies ?? []).length), delta: `${paying} on a plan` },
          {
            label: "Workspaces",
            value: String((workspaces ?? []).length),
            delta: `${(articles ?? []).length} articles in total`,
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card
          className="shrink-0"
          title="Accounts"
          meta="“View as” opens their dashboard in this tab, with a bar to come back. Every use is logged below."
        >
          <Table
            head={["Account", "Agency", "Plan", "Workspaces", "Articles", "Signed up", "Last seen", ""]}
            empty={needle ? "No account matches that." : "No accounts yet."}
            rows={rows.map((r) => [
              <span key="who" className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-ink">{r.user.email ?? "—"}</span>
                  {r.operator && <Chip label="operator" soft />}
                  {!r.user.email_confirmed_at && <Chip label="unconfirmed" soft />}
                </span>
                {r.name && <span className="text-[12px] text-ink-3">{r.name}</span>}
              </span>,
              <span key="agency" className="font-sans text-[13px]">
                {r.agency ? (
                  <>
                    {r.agency.name}
                    {r.role && <span className="text-ink-3"> · {r.role}</span>}
                    {r.extraAgencies > 0 && <span className="text-ink-3"> +{r.extraAgencies}</span>}
                  </>
                ) : (
                  <span className="text-ink-3">no agency</span>
                )}
              </span>,
              planLabel(r.agency),
              <span key="ws" className="font-sans text-[13px]" title={r.domains.join(", ")}>
                {r.domains.length === 0 ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <>
                    {r.domains.slice(0, 2).join(", ")}
                    {r.domains.length > 2 && <span className="text-ink-3"> +{r.domains.length - 2}</span>}
                  </>
                )}
              </span>,
              String(r.articleCount),
              day(r.user.created_at),
              when(r.user.last_sign_in_at),
              <span key="act" className="flex justify-end">
                <ImpersonateButton
                  userId={r.user.id}
                  email={r.user.email ?? r.user.id}
                  disabledReason={
                    r.user.id === operator.id
                      ? "This is you."
                      : !r.user.email_confirmed_at
                        ? "Unconfirmed address: opening it would confirm it on their behalf."
                        : undefined
                  }
                />
              </span>,
            ])}
          />
        </Card>

        <Card className="shrink-0" title="Recent “view as” sessions" meta="Newest first. Open rows have no end time yet.">
          <Table
            head={["Operator", "Viewed", "Started", "Ended", "Outcome"]}
            empty="Nobody has viewed as another account yet."
            rows={((log ?? []) as AdminImpersonation[]).map((e) => [
              e.operator_email,
              e.target_email,
              when(e.started_at),
              when(e.ended_at),
              e.end_reason ?? (e.ended_at ? "—" : "open"),
            ])}
          />
        </Card>
      </div>
    </>
  );
}
