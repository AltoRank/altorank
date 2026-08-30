// Demo data matching the design handoff — used for static rendering until Supabase is wired up

import type { AvatarColor } from "./constants";

export type DemoWorkspace = {
  id: string;
  name: string;
  domain: string;
  color: AvatarColor;
  articles: number;
  live: number;
  plan: string;
  status: "on" | "review" | "paused" | "setup";
  initials: string;
  dr: number;
  traffic: string;
};

export const WORKSPACES: DemoWorkspace[] = [
  { id: "w1", name: "Northline", domain: "northline.co", color: "av-c1", articles: 42, live: 38, plan: "Growth", status: "on", initials: "NL", dr: 38, traffic: "48.2k" },
  { id: "w2", name: "Moonb", domain: "moonb.app", color: "av-c2", articles: 31, live: 29, plan: "Growth", status: "on", initials: "MO", dr: 31, traffic: "22.9k" },
  { id: "w3", name: "Vækster", domain: "vaekster.dk", color: "av-c3", articles: 58, live: 54, plan: "Scale", status: "on", initials: "VK", dr: 46, traffic: "71.6k" },
  { id: "w4", name: "Parallel Co", domain: "parallel.io", color: "av-c4", articles: 18, live: 12, plan: "Starter", status: "review", initials: "PC", dr: 22, traffic: "8.1k" },
  { id: "w5", name: "Axiom", domain: "axiom-hq.com", color: "av-c5", articles: 24, live: 24, plan: "Growth", status: "on", initials: "AX", dr: 29, traffic: "19.3k" },
  { id: "w6", name: "Bright Brands", domain: "brightbrands.co", color: "av-c6", articles: 12, live: 7, plan: "Starter", status: "paused", initials: "BB", dr: 14, traffic: "3.2k" },
  { id: "w7", name: "Kerrigold", domain: "kerrigold.com", color: "av-c7", articles: 63, live: 61, plan: "Scale", status: "on", initials: "KR", dr: 52, traffic: "102k" },
  { id: "w8", name: "Slowburn", domain: "slowburn.app", color: "av-c8", articles: 9, live: 4, plan: "Starter", status: "setup", initials: "SB", dr: 8, traffic: "540" },
];

export type DemoArticle = {
  id: string;
  ws: string;
  title: string;
  kw: string;
  status: string;
  score: number;
  vol: number;
  date: string;
  words: number;
  cms: string;
  pos: number | null;
};

export const ARTICLES: DemoArticle[] = [
  { id: "a1", ws: "w1", title: "Twitter Monetization in 2026: The Agency Playbook", kw: "twitter monetization 2026", status: "live", score: 94, vol: 8400, date: "Apr 18", words: 2840, cms: "WordPress", pos: 4 },
  { id: "a2", ws: "w1", title: "How to Price Done-for-You Services Without Scaring Clients", kw: "done-for-you pricing", status: "review", score: 88, vol: 1200, date: "Apr 22", words: 2140, cms: "WordPress", pos: null },
  { id: "a3", ws: "w3", title: "Kontinuerlig SEO: Derfor virker det for nordiske B2B", kw: "kontinuerlig seo b2b", status: "live", score: 91, vol: 590, date: "Apr 21", words: 1980, cms: "Webflow", pos: 2 },
  { id: "a4", ws: "w2", title: "The New Creator Economy Stack: 2026 Edition", kw: "creator economy stack", status: "drafting", score: 72, vol: 3200, date: "Apr 22", words: 0, cms: "Ghost", pos: null },
  { id: "a5", ws: "w5", title: "Observability on a Startup Budget", kw: "cheap observability", status: "live", score: 96, vol: 2100, date: "Apr 19", words: 3100, cms: "Framer", pos: 1 },
  { id: "a6", ws: "w7", title: "Grass-Fed Butter vs Cultured: What Chefs Actually Buy", kw: "grass fed butter chef", status: "scheduled", score: 89, vol: 4800, date: "Apr 24", words: 2460, cms: "Shopify", pos: null },
  { id: "a7", ws: "w4", title: "Agency Retainer Math: A Working Template", kw: "agency retainer template", status: "review", score: 81, vol: 1600, date: "Apr 22", words: 2010, cms: "Webflow", pos: null },
  { id: "a8", ws: "w1", title: "How Founder-Led Content Actually Converts", kw: "founder-led content", status: "live", score: 92, vol: 880, date: "Apr 16", words: 2250, cms: "WordPress", pos: 3 },
  { id: "a9", ws: "w3", title: "SEO-rapportering til agentur-kunder uden BS", kw: "seo rapport klient", status: "live", score: 87, vol: 410, date: "Apr 15", words: 1720, cms: "Webflow", pos: 5 },
  { id: "a10", ws: "w2", title: "Ghost vs Substack vs Beehiiv: 2026 Comparison", kw: "ghost vs substack 2026", status: "drafting", score: 0, vol: 5200, date: "Apr 23", words: 0, cms: "Ghost", pos: null },
  { id: "a11", ws: "w7", title: "The Butter-Fat Index: A Working Chef's Guide", kw: "butter fat index", status: "error", score: 0, vol: 210, date: "Apr 22", words: 0, cms: "Shopify", pos: null },
  { id: "a12", ws: "w5", title: "SLOs for People Who Hate Dashboards", kw: "slo for startups", status: "scheduled", score: 93, vol: 1400, date: "Apr 25", words: 2680, cms: "Framer", pos: null },
];

export type DemoKeyword = {
  k: string;
  vol: number;
  diff: number;
  intent: string;
  ws: string;
  status: string;
};

export const KEYWORDS: DemoKeyword[] = [
  { k: "agency retainer template", vol: 1600, diff: 38, intent: "commercial", ws: "Parallel Co", status: "planned" },
  { k: "founder led content", vol: 880, diff: 22, intent: "info", ws: "Northline", status: "shipped" },
  { k: "done for you pricing", vol: 1200, diff: 31, intent: "commercial", ws: "Northline", status: "drafting" },
  { k: "grass fed butter chef", vol: 4800, diff: 44, intent: "commercial", ws: "Kerrigold", status: "scheduled" },
  { k: "ghost vs substack 2026", vol: 5200, diff: 62, intent: "commercial", ws: "Moonb", status: "drafting" },
  { k: "kontinuerlig seo b2b", vol: 590, diff: 18, intent: "info", ws: "Vækster", status: "shipped" },
  { k: "cheap observability", vol: 2100, diff: 41, intent: "info", ws: "Axiom", status: "shipped" },
  { k: "twitter monetization 2026", vol: 8400, diff: 58, intent: "info", ws: "Northline", status: "shipped" },
  { k: "slo for startups", vol: 1400, diff: 35, intent: "info", ws: "Axiom", status: "scheduled" },
  { k: "creator economy stack", vol: 3200, diff: 48, intent: "info", ws: "Moonb", status: "drafting" },
  { k: "seo rapport klient", vol: 410, diff: 14, intent: "info", ws: "Vækster", status: "shipped" },
  { k: "webflow seo agencies", vol: 1800, diff: 46, intent: "commercial", ws: "Parallel Co", status: "new" },
  { k: "butter fat index", vol: 210, diff: 9, intent: "info", ws: "Kerrigold", status: "error" },
];

export type DemoBacklink = {
  from: string;
  dr: number;
  anchor: string;
  to: string;
  ws: string;
  status: string;
  date: string;
};

export const BACKLINKS: DemoBacklink[] = [
  { from: "indiehackers.com", dr: 78, anchor: "AltoRank SEO playbook", to: "northline.co/blog/founder-content", ws: "Northline", status: "live", date: "Apr 18" },
  { from: "zapier.com/blog", dr: 92, anchor: "automation for agencies", to: "moonb.app/creator-stack", ws: "Moonb", status: "live", date: "Apr 17" },
  { from: "substack.com", dr: 91, anchor: "Ghost vs Substack", to: "moonb.app/ghost-vs-substack", ws: "Moonb", status: "pending", date: "Apr 22" },
  { from: "agenturpilot.dk", dr: 41, anchor: "kontinuerlig SEO", to: "vaekster.dk/seo-b2b", ws: "Vækster", status: "live", date: "Apr 15" },
  { from: "observability.dev", dr: 62, anchor: "SLOs for startups", to: "axiom-hq.com/slo-guide", ws: "Axiom", status: "live", date: "Apr 13" },
  { from: "chefsteps.com", dr: 68, anchor: "butter fat chart", to: "kerrigold.com/chef-guide", ws: "Kerrigold", status: "live", date: "Apr 11" },
  { from: "smashingmagazine.com", dr: 88, anchor: "Webflow CMS for agencies", to: "parallel.io/webflow-seo", ws: "Parallel Co", status: "pending", date: "Apr 22" },
  { from: "marketingbrew.com", dr: 80, anchor: "content ops playbook", to: "northline.co/content-ops", ws: "Northline", status: "negotiating", date: "Apr 23" },
];

export type DemoIntegration = {
  id: string;
  name: string;
  tag: string;
  connected: number;
  desc: string;
};

export const INTEGRATIONS: DemoIntegration[] = [
  { id: "wp", name: "WordPress", tag: "CMS", connected: 6, desc: "Publish posts, categories, featured images, SEO plugin fields" },
  { id: "wf", name: "Webflow", tag: "CMS", connected: 4, desc: "CMS collection items + binding to your blog template" },
  { id: "sh", name: "Shopify", tag: "CMS", connected: 2, desc: "Blog articles, product-linked posts, metafields" },
  { id: "gh", name: "Ghost", tag: "CMS", connected: 3, desc: "Posts + tags + feature image + members visibility" },
  { id: "fr", name: "Framer", tag: "CMS", connected: 2, desc: "CMS item sync with your blog template slots" },
  { id: "no", name: "Notion", tag: "CMS", connected: 1, desc: "Post to a database; map title / body / cover / tags" },
  { id: "wix", name: "Wix", tag: "CMS", connected: 0, desc: "Blog posts + collections; use existing category taxonomy" },
  { id: "ga", name: "GA4", tag: "Analytics", connected: 7, desc: "Traffic + engagement, auto-attributed to each article" },
  { id: "gsc", name: "Search Console", tag: "Analytics", connected: 8, desc: "Clicks, impressions, average position per URL" },
  { id: "ahr", name: "Ahrefs", tag: "Data", connected: 5, desc: "Rank tracking + backlink index for each workspace" },
  { id: "slk", name: "Slack", tag: "Notify", connected: 6, desc: "Pipe approvals, publishes and failures to any channel" },
  { id: "zp", name: "Zapier", tag: "Automate", connected: 2, desc: "3,000+ downstream destinations via zap triggers" },
];

export const CALENDAR = (() => {
  const out: { day: number; ws: string; kw: string; status: string }[] = [];
  const WS_ROT = ["w1", "w3", "w7", "w2", "w5", "w1", "w7", "w3", "w4", "w5", "w1", "w7", "w2", "w3", "w5"];
  const TITLES = [
    "twitter monetization 2026", "founder-led content", "done-for-you pricing", "kontinuerlig seo b2b",
    "creator economy stack", "cheap observability", "grass fed butter chef", "agency retainer template",
    "ghost vs substack 2026", "slo for startups", "seo rapport klient", "webflow seo agencies",
    "founder story pages", "pricing page teardowns", "link-building for b2b",
  ];
  for (let i = 0; i < 30; i++) {
    const st = i < 12 ? "done" : i === 12 ? "run" : i < 16 ? "scheduled" : "queue";
    out.push({ day: i + 1, ws: WS_ROT[i % WS_ROT.length], kw: TITLES[i % TITLES.length], status: st });
  }
  return out;
})();

export const MEMBERS = [
  { name: "Matteo Bianchi", role: "Owner", email: "matteo@altorank.co", ws: 8, av: "av-c5", init: "MB" },
  { name: "Alice Lin", role: "Editor", email: "alice@altorank.co", ws: 4, av: "av-c1", init: "AL" },
  { name: "Nico Marchetti", role: "Editor", email: "nico@altorank.co", ws: 3, av: "av-c2", init: "NM" },
  { name: "Sara Persson", role: "Reviewer", email: "sara@altorank.co", ws: 6, av: "av-c3", init: "SP" },
  { name: "Kira Rafael", role: "Admin", email: "kira@altorank.co", ws: 8, av: "av-c4", init: "KR" },
];

export const VOICE_SAMPLES: Record<string, string> = {
  w1: "We don't sell software. We sell fewer Monday-morning surprises. That's why our pricing starts with a conversation, not a calculator.",
  w2: "Good creators don't need more tools. They need one that disappears and lets them ship.",
  w3: "Nordisk B2B sælges ikke med buzzwords — det sælges med klare tal og ærlige cases.",
  w4: "A retainer is a promise. Our job is to make that promise boring and repeatable.",
  w5: "Logs lie. Metrics are honest. Traces are the truth in between.",
  w6: "The best brand work feels inevitable in hindsight.",
  w7: "Butter is a seasonal product. Anyone who tells you different is selling margarine.",
  w8: "Ship small. Ship often. Slow burn beats flash bang.",
};
