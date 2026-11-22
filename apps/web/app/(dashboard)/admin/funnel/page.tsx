import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, Card, StatStrip } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { getOperator } from "@/lib/auth/admin";
import { attributionLabel, isAttributionSource } from "@/lib/attribution";
import { cn, plural } from "@/lib/utils";
import { readJourneys } from "@/lib/admin/funnel-data";
import {
  FUNNEL_STAGES,
  acquisitionRows,
  funnelRows,
  runOutcomeRows,
  signupsByDay,
  spanLabel,
  type AcquisitionDimension,
  type AcquisitionRow,
  type Journey,
} from "@/lib/admin/funnel";
import { AdminTabs } from "../admin-tabs";
import { Table } from "../table";

export const metadata: Metadata = { title: "Funnel" };

/**
 * Who signed up, where from, and where each of them stopped.
 *
 * The same reads the signup export script made by hand, kept on a page: one
 * journey per account owner (lib/admin/funnel.ts), counted per stage, per
 * source and per landing page. Our own addresses and invited teammates are
 * left out, so the numbers are customers'.
 *
 * Gated and read like every Operations pane: `getOperator`, then the service
 * client. Every figure is a count of rows; a stage nobody reached reads 0.
 */

const WINDOWS = [
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "all", label: "All time", days: null },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];

/** Outside the component so the clock read is not part of render. */
function clock(): Date {
  return new Date();
}

const pct = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function SignupBars({ days }: { days: Array<{ day: string; n: number }> }) {
  const max = Math.max(1, ...days.map((d) => d.n));
  return (
    <div className="flex h-[88px] items-end gap-[3px]" role="img" aria-label={`Signups per day, ${days.length} days`}>
      {days.map((d) => (
        <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${day(d.day)}: ${plural(d.n, "signup")}`}>
          <div
            className={cn("w-full rounded-[2px]", d.n ? "bg-ink" : "bg-line")}
            style={{ height: d.n ? `${Math.max(8, (d.n / max) * 100)}%` : "2px" }}
          />
        </div>
      ))}
    </div>
  );
}

function AcquisitionTable({ rows, first, label }: { rows: AcquisitionRow[]; first: string; label?: (value: string) => string }) {
  return (
    <Table
      head={[first, "Signups", "Draft", "Gate", "Trial click", "Trial", "Paying", "Signup → trial"]}
      empty="No signups in this window."
      rows={rows.map((r) => [
        <span key="v" className="font-sans text-[13px] text-ink">
          {label ? label(r.value) : r.value}
        </span>,
        r.signups,
        r.drafts,
        r.gate,
        r.trialClicks,
        r.trials,
        r.paid,
        pct(r.signups ? r.trials / r.signups : null),
      ])}
    />
  );
}

const DIMENSIONS: Array<{ key: AcquisitionDimension; title: string; first: string; meta: string }> = [
  { key: "source", title: "By source", first: "Source", meta: "The campaign on the signup link, else the site that sent them, else the page." },
  { key: "page", title: "By landing page", first: "Page", meta: "The first page of the visit, else the page signup was clicked on." },
  { key: "declared", title: "By their own answer", first: "How they heard", meta: "What the account picked when asked how it heard of us." },
];

const declaredLabel = (value: string) => (isAttributionSource(value) ? attributionLabel(value) : value);

export default async function AdminFunnelPage({ searchParams }: { searchParams: Promise<{ window?: string }> }) {
  const operator = await getOperator();
  if (!operator) notFound();

  const { window: asked } = await searchParams;
  const win = WINDOWS.find((w) => w.key === asked) ?? WINDOWS[0];
  const now = clock();
  const since = win.days ? new Date(now.getTime() - win.days * 86_400_000).toISOString() : null;

  const everyone = await readJourneys(createServiceClient());
  const cohort: Journey[] = since ? everyone.filter((j) => j.createdAt >= since) : everyone;

  const funnel = funnelRows(cohort);
  const stage = Object.fromEntries(funnel.map((r) => [r.key, r]));
  const outcomes = runOutcomeRows(cohort);
  const labelOf = Object.fromEntries(FUNNEL_STAGES.map((s) => [s.key, s.label]));
  const lastSignup = everyone[0]?.createdAt ?? null;
  const quietDays = lastSignup ? Math.floor((now.getTime() - new Date(lastSignup).getTime()) / 86_400_000) : null;

  return (
    <>
      <PageHead
        title="Operations"
        subtitle={
          <span>
            {plural(cohort.length, "signup")} · {win.label.toLowerCase()}
            {quietDays !== null && quietDays >= 3 ? ` · none for ${quietDays} days` : ""}
          </span>
        }
        actions={
          <div className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <Link
                key={w.key}
                href={w.key === "30" ? "/admin/funnel" : `/admin/funnel?window=${w.key satisfies WindowKey}`}
                className={cn(
                  "rounded-[7px] px-2.5 py-1.5 text-[12.5px]",
                  w.key === win.key ? "bg-panel-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {w.label}
              </Link>
            ))}
          </div>
        }
      />

      <AdminTabs />

      <StatStrip
        stats={[
          { label: "Signups", value: cohort.length, delta: lastSignup ? `last on ${day(lastSignup)}` : "none yet" },
          { label: "Draft written", value: stage.draft_written.reached, delta: `${pct(stage.draft_written.ofCohort)} of signups` },
          { label: "Saw the gate", value: stage.gate_shown.reached, delta: `${pct(stage.gate_shown.ofCohort)} of signups` },
          { label: "Clicked start trial", value: stage.trial_clicked.reached, delta: `${pct(stage.trial_clicked.ofCohort)} of signups` },
          { label: "Trials", value: stage.trial_started.reached, delta: `${stage.paid.reached} paying` },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card className="shrink-0" title="Signups per day" meta={`Customers only, UTC days, the last ${win.days ?? 90} days.`}>
          <SignupBars days={signupsByDay(everyone, win.days ?? 90, now)} />
        </Card>

        <Card
          className="shrink-0"
          title="Funnel"
          meta="Each stage counts the accounts with that stage's own record. “Stopped here” is the last stage an account reached, so that column adds up to the signups."
          flush
        >
          <Table
            head={["Stage", "Reached", "Of signups", "Of the stage before", "Stopped here", "Median time from signup", ""]}
            rows={funnel.map((r) => [
              <span key="s" className="font-sans text-[13px] font-medium text-ink">
                {r.label}
              </span>,
              r.reached,
              pct(r.ofCohort),
              pct(r.ofPrevious),
              r.stoppedHere || "—",
              spanLabel(r.medianMinutes),
              <span key="bar" className="block h-[6px] w-[160px] rounded-full bg-line" aria-hidden>
                <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.round(r.ofCohort * 100)}%` }} />
              </span>,
            ])}
          />
        </Card>

        <Card
          className="shrink-0"
          title="Why a first look wrote nothing"
          meta="The run's own reason, for accounts that still have no draft. Numbers are folded so one cause reads as one row."
          flush
        >
          <Table
            head={["Reason", "Accounts", "Sites"]}
            empty="Every account that ran a first look has a draft."
            rows={outcomes.map((o) => [
              <span key="r" className="font-sans text-[13px] text-ink">
                {o.reason}
              </span>,
              o.users,
              <span key="s" className="font-sans text-[12.5px]" title={o.sites.join(", ")}>
                {o.sites.slice(0, 4).join(", ")}
                {o.sites.length > 4 ? ` +${o.sites.length - 4}` : ""}
              </span>,
            ])}
          />
        </Card>

        {DIMENSIONS.map((d) => (
          <Card key={d.key} className="shrink-0" title={d.title} meta={d.meta} flush>
            <AcquisitionTable rows={acquisitionRows(cohort, d.key)} first={d.first} label={d.key === "declared" ? declaredLabel : undefined} />
          </Card>
        ))}

        <Card className="shrink-0" title="Signups in this window" meta="Newest first. Open one for everything recorded about it." flush>
          <Table
            head={["Site", "Source", "Signed up", "Got as far as", "If no draft, why"]}
            empty="No signups in this window."
            rows={cohort.slice(0, 100).map((j) => [
              <Link key="u" href={`/admin/users/${j.userId}`} className="font-medium text-ink underline-offset-2 hover:underline">
                {j.site ?? j.email ?? j.userId}
              </Link>,
              <span key="o" className="font-sans text-[13px]" title={j.origin.detail ?? undefined}>
                {j.origin.label}
              </span>,
              day(j.createdAt),
              <span key="f" className="font-sans text-[13px]">
                {labelOf[j.furthest]}
              </span>,
              <span key="w" className="font-sans text-[12.5px] text-ink-3">
                {j.runOutcome ? j.runOutcome.slice(0, 90) : "—"}
              </span>,
            ])}
          />
        </Card>
      </div>
    </>
  );
}
