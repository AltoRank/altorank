// One layout for every email the app sends, without exception: the auth
// emails, the invite, the monthly report, the growth plan, the free-tool
// results and every lifecycle notice. Supabase's own mailer is never
// triggered (lib/email/auth-emails.ts says why), so there are no templates
// outside this file to keep in step with it.
//
// Deliberately plain: a wordmark, one accent, one column, the legal entity in
// the footer. No images, so nothing is blocked or tracked, and it reads the
// same in a dark inbox. The accent is the app's indigo (oklch(0.52 0.16 265))
// in hex, since email clients do not speak oklch.

export const EMAIL_ACCENT = "#4B52D4";
export const EMAIL_INK = "#1A1A1A";
export const EMAIL_INK_2 = "#4A4A4A";
export const EMAIL_INK_3 = "#8A8A8A";
export const EMAIL_LINE = "#E6E5E2";
export const EMAIL_BG = "#FAF9F7";
/** The mark's tile and glyph, from public/brand/altorank-mark.svg. */
export const EMAIL_MARK_BG = "#1A1815";
export const EMAIL_MARK_INK = "#FDFCFA";
/** 40x40 render of brand/altorank-mark.svg on its tile; see BRAND_MARK. */
const MARK_PNG = "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";

// ---------------------------------------------------------------------------
// The dashboard's vocabulary, in the two things email understands
// ---------------------------------------------------------------------------
//
// The app's tokens are OKLCH (app/globals.css) and no mail client speaks it,
// so these are the same colours converted once, here, rather than eyeballed
// per email. `--line-soft` and `--panel` are the two the app uses to separate
// a panel's rows from its border; the three tinted pairs are the semantic
// pills (`ok`, `warn`, `err`) that StatusPill renders.
//
// Nothing below introduces an image, a webfont or a tracking pixel. The mono
// stack is the local one every OS already has: JetBrains Mono is the app's
// figure face and downloading it would mean a remote request per open.
export const EMAIL_LINE_SOFT = "#EEEDEA";
export const EMAIL_PANEL = "#F8F6F4";
export const EMAIL_OK_SOFT = "#E1F7E7";
export const EMAIL_OK_INK = "#1F5C39";
export const EMAIL_WARN_SOFT = "#FEF0D4";
export const EMAIL_WARN_INK = "#754B00";
export const EMAIL_ERR_SOFT = "#FFE9E6";
export const EMAIL_ERR_INK = "#90302E";
export const EMAIL_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * The wordmark's glyph: the mark from `public/brand/altorank-mark.svg` on its
 * tile, rasterised once at 2x and inlined as a data URI.
 *
 * This layout ships no *remote* images on purpose - nothing to be blocked, and
 * no fetch that reports when a message was opened. A data URI keeps both
 * properties: it travels inside the message and asks the network for nothing.
 * Inline `<svg>` would have been smaller but Gmail strips it, and the CSS
 * triangle this replaced was a solid wedge, not the notched peak the brand
 * actually uses - close enough to look like the logo, wrong enough to be the
 * only surface drawing its own.
 *
 * The `<img>` carries the dark tile as its background, so a client that drops
 * data URIs still shows a mark-shaped tile rather than a broken-image icon.
 */
const BRAND_MARK = `<img src="data:image/png;base64,${MARK_PNG}" width="20" height="20" alt="" style="display:inline-block;width:20px;height:20px;border-radius:5px;background:${EMAIL_MARK_BG};vertical-align:-4px;margin-right:8px;">`;

export const LEGAL_FOOTER = "SUPALABS SRL, Italy · VAT 04596950248";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function emailButton(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;margin:20px 0;padding:11px 18px;background:${EMAIL_ACCENT};color:#ffffff;text-decoration:none;border-radius:7px;font-size:14px;font-weight:600;">${esc(label)}</a>`;
}

export function emailParagraph(text: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${EMAIL_INK_2};">${text}</p>`;
}

/**
 * The uppercase micro-label the dashboard puts above every figure
 * (components/ui/stat-strip.tsx). Mono, wide tracking, ink-3: it names the
 * number without competing with it.
 */
export function emailLabel(text: string): string {
  return `<div style="font-family:${EMAIL_MONO};font-size:10px;letter-spacing:0.07em;text-transform:uppercase;color:${EMAIL_INK_3};margin:0 0 5px;">${esc(text)}</div>`;
}

/**
 * The dashboard's EyebrowCode: a mono chip on a panel ground, for the one
 * piece of the sentence that is data rather than prose - a keyword, a domain.
 */
export function emailCode(text: string): string {
  return `<span style="font-family:${EMAIL_MONO};font-size:12.5px;padding:2px 7px;border-radius:5px;background:${EMAIL_PANEL};color:${EMAIL_INK_2};white-space:nowrap;">${esc(text)}</span>`;
}

/** A quiet line: the 13px ink-3 aside the dashboard uses under a value. */
export function emailNote(html: string): string {
  return `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:${EMAIL_INK_3};">${html}</p>`;
}

export type EmailTone = "ok" | "warn" | "err" | "neutral";

const TONES: Record<EmailTone, { bg: string; ink: string }> = {
  ok: { bg: EMAIL_OK_SOFT, ink: EMAIL_OK_INK },
  warn: { bg: EMAIL_WARN_SOFT, ink: EMAIL_WARN_INK },
  err: { bg: EMAIL_ERR_SOFT, ink: EMAIL_ERR_INK },
  neutral: { bg: EMAIL_PANEL, ink: EMAIL_INK_2 },
};

/**
 * StatusPill, without the dot. The dot is a 6px rounded div, which Outlook's
 * Word engine renders as a square block; the label alone carries the same
 * meaning and survives everywhere.
 */
export function emailPill(label: string, tone: EmailTone = "neutral"): string {
  const t = TONES[tone];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${t.bg};color:${t.ink};font-size:11px;font-weight:600;line-height:1.5;white-space:nowrap;">${esc(label)}</span>`;
}

export type EmailStat = {
  label: string;
  /** Already formatted. "—" when nothing measured it: never a zero standing in for an unknown. */
  value: string;
  /** The small suffix the dashboard hangs off a figure, e.g. "/mo". */
  unit?: string;
  tone?: EmailTone;
};

/**
 * The dashboard's StatStrip, as a table.
 *
 * One row of equal cells divided by hairlines, each an uppercase mono label
 * over a large figure. A table rather than a grid because Outlook's Word
 * renderer supports neither flexbox nor grid and would stack the cells into a
 * column of unstyled text.
 *
 * Two per row, like the strip's own phone layout, and for the same reason: at
 * an inbox's reading width four figures across leave each one 80px, which is
 * narrower than the word DIFFICULTY. An odd last stat spans the row so no cell
 * is left empty. No media query is involved, so the layout is the same in the
 * clients that strip `<style>` as in the ones that keep it.
 */
export function emailStatRow(stats: readonly EmailStat[]): string {
  if (!stats.length) return "";
  const cell = (s: EmailStat, span: boolean, lastRow: boolean, first: boolean) =>
    `<td width="${span ? "100%" : "50%"}"${span ? ' colspan="2"' : ""} style="padding:12px 14px;vertical-align:top;` +
    `${first || span ? "" : `border-left:1px solid ${EMAIL_LINE_SOFT};`}` +
    `${lastRow ? "" : `border-bottom:1px solid ${EMAIL_LINE_SOFT};`}">` +
    emailLabel(s.label) +
    // Ink, except when the figure is the reason to act. The dashboard colours
    // a StatusPill and a delta, never the figure itself; a green "Clean" at
    // 21px shouts as loudly as the one verdict that actually needs a reader.
    `<div style="font-size:21px;font-weight:600;letter-spacing:-0.02em;line-height:1.15;color:${s.tone === "warn" || s.tone === "err" ? TONES[s.tone].ink : EMAIL_INK};">` +
    `${esc(s.value)}${s.unit ? `<span style="font-size:12px;font-weight:400;color:${EMAIL_INK_3};">${esc(s.unit)}</span>` : ""}` +
    `</div></td>`;

  const rows: string[] = [];
  for (let i = 0; i < stats.length; i += 2) {
    const pair = stats.slice(i, i + 2);
    const lastRow = i + 2 >= stats.length;
    rows.push(
      `<tr>${pair.map((s, j) => cell(s, pair.length === 1, lastRow, j === 0)).join("")}</tr>`,
    );
  }
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:separate;border-spacing:0;margin:0 0 18px;border:1px solid ${EMAIL_LINE};border-radius:10px;">` +
    rows.join("") +
    `</table>`
  );
}

/**
 * The dashboard's Card: a bordered panel with a title row over a body.
 *
 * `flush` matches the component's own prop - a body that already pays for its
 * own inset, such as a stat strip or a table of rows.
 */
export function emailCard(opts: { title?: string; meta?: string; bodyHtml: string; flush?: boolean }): string {
  const head = opts.title
    ? `<tr><td style="padding:11px 16px;border-bottom:1px solid ${EMAIL_LINE_SOFT};font-size:13.5px;font-weight:600;letter-spacing:-0.005em;color:${EMAIL_INK};">` +
      `${esc(opts.title)}` +
      (opts.meta ? `<span style="float:right;font-weight:400;font-size:12px;color:${EMAIL_INK_3};">${esc(opts.meta)}</span>` : "") +
      `</td></tr>`
    : "";
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:separate;border-spacing:0;margin:0 0 18px;border:1px solid ${EMAIL_LINE};border-radius:10px;">` +
    head +
    `<tr><td style="padding:${opts.flush ? "0" : "14px 16px"};">${opts.bodyHtml}</td></tr>` +
    `</table>`
  );
}

/**
 * Wrap body HTML in the branded frame.
 *
 * `preheader` is the line inbox clients show after the subject; it is hidden
 * in the body. `footerNote` is the one-line "why you got this", which every
 * transactional email should carry so the recipient never has to guess.
 *
 * `unsubscribeUrl` is set only for the optional categories
 * (lib/email/categories.ts). A confirmation link or a failed-payment notice
 * does not offer one, and offering one there would be a promise we would have
 * to break the next time the account needed the person to act.
 */
export function emailLayout(opts: {
  title: string;
  bodyHtml: string;
  preheader?: string;
  footerNote?: string;
  unsubscribeUrl?: string | null;
}): string {
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(opts.preheader)}</div>`
    : "";
  const unsubscribe = opts.unsubscribeUrl
    ? ` · <a href="${esc(opts.unsubscribeUrl)}" style="color:${EMAIL_INK_3};text-decoration:underline;">Stop these emails</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_BG};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_BG};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${EMAIL_LINE};border-radius:12px;">
      <tr><td style="padding:24px 32px 0;">
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:${EMAIL_INK};">
          ${BRAND_MARK}AltoRank
        </div>
      </td></tr>
      <tr><td style="padding:20px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${EMAIL_INK};">
        ${opts.bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 32px 24px;border-top:1px solid ${EMAIL_LINE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${EMAIL_INK_3};">
        ${opts.footerNote ? `${esc(opts.footerNote)}<br>` : ""}
        <a href="https://altorank.co" style="color:${EMAIL_INK_3};text-decoration:underline;">altorank.co</a> · ${LEGAL_FOOTER}${unsubscribe}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
