import vercel from "@/vercel.json";
import { Table } from "./table";
import type { Forecast, JobKey, RateCard } from "@/lib/billing/forecast";
import { SCHEDULED_JOBS } from "@/lib/billing/scheduled-jobs";

/**
 * The schedule, what each job spends on, and what it is expected to cost -
 * expected from the users' own settings, actual from provider_spend.
 *
 * The times are read from vercel.json rather than restated. What each job
 * does and what it is filed under are kept in lib/billing/scheduled-jobs.ts,
 * and a test fails when vercel.json names a cron that file does not.
 * Times are UTC because that is what Vercel runs them in.
 */

const RATE_LABEL: Record<keyof RateCard, string> = {
  serpQueued: "queued SERP",
  backlinksSync: "backlink sync",
  dfsPerArticle: "research per article",
  modelPerArticle: "model per article",
  geoProbe: "GEO probe",
  firstLook: "first look",
};

function cron(schedule: string): string {
  // "20 3 * * *" -> "03:20 daily"; "0 8 * * 1" -> "08:00 Mon"; "0 6 1 * *" -> "06:00 on the 1st"
  const [m, h, dom, , dow] = schedule.split(" ");
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (dow !== "*") return `${time} ${days[Number(dow)] ?? dow}`;
  if (dom !== "*") return `${time} on the ${dom}${dom === "1" ? "st" : "th"}`;
  return `${time} daily`;
}

// "$0.00" reads as "nothing ran", which is the one thing this card must
// not be ambiguous about. A run that cost a fraction of a cent says so.
const usd = (n: number) => (n === 0 ? "—" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

export function ScheduledWork({
  forecast,
  actual30d,
  rates,
  measured,
  pendingFirstLooks,
}: {
  forecast: Forecast;
  /** USD spent in the last 30 days, by job, from provider_spend. */
  actual30d: Record<JobKey, number>;
  rates: RateCard;
  measured: Array<keyof RateCard>;
  pendingFirstLooks: number;
}) {
  const crons = [...vercel.crons].sort((a, b) => {
    const [ma, ha] = a.schedule.split(" ");
    const [mb, hb] = b.schedule.split(" ");
    return Number(ha) * 60 + Number(ma) - (Number(hb) * 60 + Number(mb));
  });

  const expected = (key: JobKey | null): string => {
    if (!key) return "—";
    if (key === "analyze") return forecast.oneOff ? `${usd(forecast.oneOff)} once` : "—";
    // Rewrites follow each site's own refresh schedule and pace; there is no
    // forecast of them yet, which is not the same as costing nothing.
    if (key === "refresh") return "not forecast";
    return usd(forecast.byJob[key]);
  };

  const rows = crons.map((c) => {
    const job = SCHEDULED_JOBS[c.path] ?? { key: null, does: c.path, drivers: "—" };
    return [
      `${cron(c.schedule)} UTC`,
      c.path.replace("/api/cron/", ""),
      job.does,
      job.key === "analyze" && pendingFirstLooks ? `${pendingFirstLooks} pending` : job.drivers,
      expected(job.key),
      job.key ? usd(actual30d[job.key] ?? 0) : "—",
    ];
  });

  return (
    <div>
      <Table head={["When", "Job", "What it does", "Driven by", "Expected / month", "Actual, last 30 days"]} rows={rows} />
      <div className="px-3.5 py-3 border-t border-line-soft text-[12px] text-ink-3 flex flex-wrap gap-x-5 gap-y-1">
        <span>
          Expected total <b className="text-ink font-medium">{usd(forecast.monthlyTotal)}/month</b>
          {forecast.oneOff ? <> plus {usd(forecast.oneOff)} of pending first looks</> : null}.
        </span>
        <span>
          Units:{" "}
          {(Object.keys(RATE_LABEL) as Array<keyof RateCard>).map((k, i) => (
            <span key={k}>
              {i > 0 ? " · " : ""}
              {RATE_LABEL[k]} ${rates[k].toFixed(4)}
              <span className="text-ink-4">{measured.includes(k) ? " measured" : " default"}</span>
            </span>
          ))}
        </span>
        {forecast.geoBacklog > 0 && (
          <span className="text-warn-ink">
            {forecast.geoBacklog} GEO opt-in{forecast.geoBacklog === 1 ? "" : "s"} beyond the 3 a weekly run serves; they wait a week each.
          </span>
        )}
      </div>
    </div>
  );
}
