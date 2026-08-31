export const APP_NAME = 'AltoRank';
export const SITE_URL = 'https://altorank.co';
export const APP_URL = 'https://app.altorank.co';
export const SIGNUP_URL = `${APP_URL}/signup`;
export const SIGNIN_URL = `${APP_URL}/signin`;

// Named author for E-E-A-T (Person schema + visible bylines). A real,
// verifiable author materially improves AI-citation readiness vs an
// Organization-only byline.
export const AUTHOR_NAME = 'Mike Cecconello';
export const AUTHOR_URL = 'https://nl.linkedin.com/in/mikececconello';

// ── Open-source pivot ─────────────────────────────────────────────────────
// AltoRank is going AGPL-3.0 (decision locked 2026-07-29; see
// memory/plans/2026-07-29-open-source-agpl-pivot.md).
//
// OSS_REPO_PUBLIC is the single switch for every claim that is only TRUE once
// the repo is actually public: the repo link, "audit our scoring algorithm",
// star counts, and the $0 self-host CTA.
//
// FLIPPED TRUE 2026-08-30. github.com/AltoRank/altorank is public and serves
// 200. It is a NEW repository with no imported history, not this one made
// public: this one can never be, because closed pull-request refs #39-42 still
// serve lead CSVs with 852 named contacts and GitHub does not let an owner
// delete those refs. History rewriting does not reach them.
//
// So: do not add this repo as a remote of the public one, and do not push any
// branch from here to there. The public repo's tree is the source of truth for
// what is publishable.
//
// Still resolve the URL through OSS_REPO_URL rather than hardcoding it; the
// casing is AltoRank/altorank and only the constant is kept correct.
export const OSS_REPO_PUBLIC = true;
export const OSS_REPO_URL = 'https://github.com/AltoRank/altorank';
// The licence is still AGPL-3.0 and the LICENSE file in the repo is what
// actually conveys it. These two are for machine-readable and legal contexts
// only (schema.org `license`, terms), NOT for selling copy.
//
// The acronym is off the site as of 2026-08-30 (Mike): the ICP owns a site and
// wants SEO content, and does not know an AGPL from an MIT. "AGPL-3.0" in a
// hero reads as a compliance question, and a buyer who has to look up a term
// before understanding a benefit has already left. Say "open source" and
// "self-host it free", which is the same fact in words the reader has.
//
// Use OSS_LABEL in copy. Naming the licence is only correct on a page whose
// audience self-selects as licence-literate, and there is currently no such
// page. Do not put it back in a meta description.
export const OSS_LICENSE = 'AGPL-3.0';
export const OSS_LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
export const OSS_LABEL = 'open source';

// How the open-source row reads in comparison tables. Stays in the future tense
// until the repository is genuinely public, because "Yes" next to a
// competitor's "No" is a claim a reader can check in about ten seconds. Flips
// automatically with OSS_REPO_PUBLIC.
export const OSS_COMPARISON_LABEL = OSS_REPO_PUBLIC
  ? 'Yes, all of it'
  : 'Open source, launching';
export const OSS_COMPARISON_LABEL_DE = OSS_REPO_PUBLIC
  ? 'Ja, vollständig'
  : 'Open Source, in Kürze';

// First pilot engagements. Stated in the future tense on /agency-blueprint and
// its Italian mirror, deliberately with no count, because none have started yet
// and a traction number we cannot evidence is the exact failure mode commits
// cfd78ef / edc6ed9 were cleaning up.
//
// ⚠️ VERIFY BEFORE SENDING. September 2026 is an assumption, not a confirmed
// date. Change it here and both languages update. If the date slips, change it
// here rather than letting a stale claim sit on a document going to agencies.
export const PILOT_START = {
  en: 'September 2026',
  it: 'settembre 2026',
};

export const NAV_LINKS = [
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'Features', href: '/#features' },
  { label: 'Open source', href: '/open-source' },
  { label: 'Approval-first', href: '/approval-first-seo-content' },
  // Surfaces the comparison hub, which was previously footer-only. It carries
  // our money TOFU terms (e.g. "outrank alternative"). Points at /alternatives
  // since /vs/* was removed 2026-08-22 (thin templated pages that cannibalised
  // their /alternatives counterparts); see public/_redirects.
  { label: 'Compare', href: '/alternatives' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Blog', href: '/blog' },
] as const;

// ── Primary call to action ────────────────────────────────────────────────
// CORRECTED 2026-08-30. This block previously routed the primary CTA to a demo
// mailto on the belief that app.altorank.co was a dead redirect. That was wrong:
// CLAUDE.md says the host "only 308-redirects to the marketing site", but that
// is true of the ROOT ONLY. Verified by request on 2026-08-30:
//
//   GET https://app.altorank.co/         -> 308 -> https://altorank.co
//   GET https://app.altorank.co/signup   -> 200, real signup form
//
// So the app routes serve. Signup is a working destination and is the primary
// CTA. The guided onboarding behind it is built: app/actions/workspaces.ts
// (createWorkspace), app/actions/onboard-workspace.ts (crawl + voice training),
// and components/onboarding/ drive a five-step checklist, add-client ->
// add-keywords -> generate-article -> connect-cms -> train-voice.
//
// Keep APP_LIVE as the single switch so this is one line to flip if the app is
// ever actually down, rather than 28 pages of edits.
export const APP_LIVE = true;

export const PRIMARY_CTA = APP_LIVE
  ? {
      href: SIGNUP_URL,
      label: 'Add your domain',
      // Shorter form for the nav, where the full label crowds the bar.
      short: 'Add your domain',
      note: 'Add a domain, it sets up your workspace',
    }
  : {
      href: 'mailto:hello@altorank.co?subject=AltoRank%20demo%20request',
      label: 'Book a 20-min demo',
      short: 'Book a demo',
      note: null,
    };


// ── Legal entity ──────────────────────────────────────────────────────────
// AltoRank is operated by SUPALABS SRL, an Italian company. Stated on the
// footer, /about, /terms and /privacy so a European buyer can see who they are
// contracting with without hunting for it.
//
// Deliberately says the COMPANY is Italian, not that data is hosted in the EU.
// Data residency is not verified: the marketing site is on Cloudflare's global
// CDN and the app's Supabase region is not confirmed. Do not upgrade this to a
// residency claim without checking, it is exactly the kind of thing a GDPR
// buyer will hold you to.
export const LEGAL_ENTITY = {
  name: 'SUPALABS SRL',
  vat: '04596950248',
  country: 'Italy',
  parentUrl: 'https://supalabs.co',
  parentLabel: 'supalabs.co',
} as const;


// ── Hosting region ────────────────────────────────────────────────────────
// FALSE since 2026-08-30, and this is the second time this flag has been
// wrong in one day. Measure, do not assume.
//
// apps/web pins ["fra1"] in vercel.json. That line does nothing: region
// selection is a Pro-plan feature and the altorank team is on Hobby, so
// Vercel silently ignores it and runs every function in the default region.
// Measured on the real hostname, 8 requests, immediately after a fresh
// production deploy:
//
//   curl -sSI https://app.altorank.co/signup | grep x-vercel-id
//   -> fra1::iad1::...      edge Frankfurt, COMPUTE WASHINGTON DC
//
// So: database Ireland (eu-west-1, inside the EEA), application servers
// United States (outside it). /privacy now says that instead of claiming
// Frankfurt.
//
// Do not flip this back by editing vercel.json. Nothing changes until the
// team is on a paid plan; then re-measure the header before flipping. The
// config file states intent, x-vercel-id states fact.
export const EU_HOSTED = false;
