// The "email me this result" body. Plain HTML, the same nine rows the page
// shows, and the permanent link. No summary sentence the data does not back.

import { scoreLabel, type PublicCheckData } from "./shape";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MARK: Record<string, string> = { pass: "Pass", fail: "Fail", unknown: "Unknown" };

export function checkEmailSubject(data: PublicCheckData): string {
  return data.score === null
    ? `AI-readiness check for ${data.domain}`
    : `AI-readiness check for ${data.domain}: ${data.passed}/${data.known} checks pass`;
}

export function renderCheckEmail(data: PublicCheckData): string {
  const rows = data.checks
    .map(
      (c) =>
        `<tr><td style="padding:6px 10px 6px 0;white-space:nowrap;font-weight:600">${MARK[c.status]}</td>` +
        `<td style="padding:6px 0"><strong>${esc(c.label)}</strong>` +
        (c.evidence ? `<br><span style="color:#555">${esc(c.evidence)}</span>` : "") +
        (c.fix_summary ? `<br><span style="color:#333">Fix: ${esc(c.fix_summary)}</span>` : "") +
        `</td></tr>`,
    )
    .join("");
  const score = data.score === null ? "Not measured" : `${data.score}/100, ${scoreLabel(data.score)}`;
  return (
    `<p>Score for <strong>${esc(data.domain)}</strong>: ${esc(score)}. ` +
    `${data.passed} of ${data.known} completed checks pass${data.known < data.total ? `; ${data.total - data.known} could not be decided` : ""}.</p>` +
    `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` +
    `<p>The result stays at <a href="${esc(data.share_url)}">${esc(data.share_url)}</a>. ` +
    `Re-run it there after you change the site.</p>`
  );
}
