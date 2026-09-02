// One layout for every email the app sends itself (invite, monthly report,
// growth plan, free-tool results). Supabase's auth emails (confirm, reset,
// magic link) use the HTML files in supabase/templates/, which mirror this
// markup by hand because those templates cannot import code.
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
 * Wrap body HTML in the branded frame.
 *
 * `preheader` is the line inbox clients show after the subject; it is hidden
 * in the body. `footerNote` is the one-line "why you got this", which every
 * transactional email should carry so the recipient never has to guess.
 */
export function emailLayout(opts: { title: string; bodyHtml: string; preheader?: string; footerNote?: string }): string {
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(opts.preheader)}</div>`
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
          <span style="display:inline-block;width:18px;height:18px;border-radius:5px;background:${EMAIL_ACCENT};vertical-align:-3px;margin-right:8px;"></span>AltoRank
        </div>
      </td></tr>
      <tr><td style="padding:20px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${EMAIL_INK};">
        ${opts.bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 32px 24px;border-top:1px solid ${EMAIL_LINE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${EMAIL_INK_3};">
        ${opts.footerNote ? `${esc(opts.footerNote)}<br>` : ""}
        <a href="https://altorank.co" style="color:${EMAIL_INK_3};text-decoration:underline;">altorank.co</a> · ${LEGAL_FOOTER}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
