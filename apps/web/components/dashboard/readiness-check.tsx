"use client";

import { useState, useTransition } from "react";
import { checkReadiness } from "@/app/actions/readiness";
import type { ReadinessReport } from "@/lib/audit/readiness-report";
import { Button, Card, Icons, StatStrip, StatusPill } from "@/components/ui";

function scoreLabel(score: number): { status: string; label: string } {
  if (score >= 85) return { status: "on", label: "Good" };
  if (score >= 70) return { status: "on", label: "Workable" };
  if (score >= 50) return { status: "warn", label: "Weak" };
  return { status: "error", label: "Poor" };
}

/** Copy button that confirms, since a silent copy leaves you unsure it worked. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function ReadinessCheck() {
  const [domain, setDomain] = useState("");
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    if (!domain.trim()) return;
    startTransition(async () => setReport(await checkReadiness(domain)));
  };

  const blocking = report?.result.findings.filter((f) => !f.passed && f.severity !== "low") ?? [];
  const minor = report?.result.findings.filter((f) => !f.passed && f.severity === "low") ?? [];
  const passed = report?.result.findings.filter((f) => f.passed) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <Card title="Check a domain">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="example.com"
              className="flex-1 bg-bg border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent"
              disabled={pending}
            />
            <Button variant="accent" disabled={pending || !domain.trim()} onClick={run}>
              {pending ? "Checking…" : "Run check"}
            </Button>
          </div>
          <p className="m-0 text-xs text-ink-3">
            Reads public site configuration only: robots.txt, sitemap, llms.txt and the homepage.
            Any domain, no workspace needed.
          </p>
        </div>
      </Card>

      {report?.error && (
        <Card title="Could not check that domain">
          <div className="text-sm text-ink-2">{report.error}</div>
        </Card>
      )}

      {report && !report.error && (
        <>
          <StatStrip
            cols={4}
            stats={[
              { label: "Score", value: report.result.score, unit: "/100" },
              { label: "Checks passed", value: `${passed.length}/${report.result.findings.length}` },
              { label: "Blocking", value: blocking.length },
              { label: "Artifacts", value: report.artifacts.filter((a) => a.body).length },
            ]}
          />

          <Card
            title={report.domain}
            meta={<StatusPill {...scoreLabel(report.result.score)} />}
          >
            <div className="flex flex-col gap-4">
              {blocking.length > 0 && (
                <div>
                  <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
                    Blocking
                  </h4>
                  <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                    {blocking.map((f) => (
                      <li key={f.check} className="text-sm text-ink-2 flex gap-2">
                        <span className="text-red-600">•</span>
                        <span>
                          <strong className="text-ink">{f.check}</strong> {f.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {minor.length > 0 && (
                <div>
                  <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
                    Minor
                  </h4>
                  <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                    {minor.map((f) => (
                      <li key={f.check} className="text-sm text-ink-3">
                        {f.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
                  Already in place
                </h4>
                <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                  {passed.map((f) => (
                    <li key={f.check} className="text-sm text-ink-3 flex gap-2">
                      <Icons.check size={13} />
                      {f.detail}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>

          {report.artifacts.map((a) => (
            <Card
              key={a.name}
              title={a.body ? a.name : `${a.name} (no artifact, instruction only)`}
              meta={a.body ? <CopyButton text={a.body} /> : null}
            >
              <div className="flex flex-col gap-3">
                {a.body && (
                  <pre className="m-0 p-3 bg-panel border border-line-soft rounded-md text-xs overflow-x-auto">
                    {a.body}
                  </pre>
                )}
                <p className="m-0 text-xs text-ink-2">
                  <strong className="text-ink">Where it goes:</strong> {a.placement}
                </p>
              </div>
            </Card>
          ))}

          {/* Provenance is what makes a proposal reviewable rather than trusted.
              Every field says where it came from, and anything unsourceable is
              named rather than guessed. */}
          {report.proposals.map((p) =>
            p.provenance.length ? (
              <Card key={p.type} title={`${p.type}: where each field came from`}>
                <div className="flex flex-col gap-2">
                  {p.provenance.map((pv) => (
                    <div key={pv.field} className="text-xs flex gap-2 flex-wrap">
                      <code className="text-ink font-semibold">{pv.field}</code>
                      <span className="text-ink-2">
                        {typeof pv.value === "string" ? pv.value : JSON.stringify(pv.value)}
                      </span>
                      <span className="text-ink-3">
                        ({pv.source}, {pv.confidence})
                      </span>
                    </div>
                  ))}
                  {p.missing.length > 0 && (
                    <p className="m-0 mt-1 text-xs text-ink-2">
                      <strong className="text-ink">Needs a human:</strong> {p.missing.join(", ")}.
                      Not guessed.
                    </p>
                  )}
                  {p.warnings.map((w) => (
                    <p key={w} className="m-0 text-xs text-yellow-700">
                      {w}
                    </p>
                  ))}
                </div>
              </Card>
            ) : null,
          )}

          {report.extraction && (
            <p className="m-0 text-xs text-ink-3">
              Content read from <code>{report.extraction.source}</code>
              {report.extraction.heuristic && " (heuristic: the page offered no semantic landmark)"},{" "}
              {report.extraction.words} words.
              {report.notes.length > 0 && ` ${report.notes.join(" ")}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
