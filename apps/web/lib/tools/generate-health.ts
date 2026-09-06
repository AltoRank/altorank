// ---------------------------------------------------------------------------
// SEO Health Checker pipeline — single-page audit
// ---------------------------------------------------------------------------

import { fetchPageSpeed } from "@/lib/audit/pagespeed";
import type { HealthCheckResult, HealthIssue } from "./types";
import { fetchSite } from "@/lib/audit/lenient-fetch";

export async function generateHealthCheck(
  url: string,
): Promise<HealthCheckResult> {
  // Fetch the page
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let html = "";
  let status = 0;
  try {
    const res = await fetchSite(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AltoRank-HealthChecker/1.0" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    status = res.status;
    html = await res.text();
  } catch {
    clearTimeout(timeout);
    throw new Error("Could not reach the URL. Please check it's accessible.");
  }

  const loadTimeMs = Date.now() - start;

  if (status >= 400) {
    throw new Error(`Page returned HTTP ${status}. Please check the URL.`);
  }

  // Parse HTML
  const parsed = parsePageHtml(html, url);

  // Run checks
  const issues = runSinglePageChecks(parsed, loadTimeMs);

  // PageSpeed (don't block on failure)
  const pageSpeed = await fetchPageSpeed(url, "mobile").catch(() => null);

  // Add PageSpeed issues
  if (pageSpeed) {
    if (pageSpeed.performanceScore < 50) {
      issues.push({
        type: "performance",
        severity: "error",
        message: `Mobile performance score is ${pageSpeed.performanceScore}/100`,
      });
    } else if (pageSpeed.performanceScore < 90) {
      issues.push({
        type: "performance",
        severity: "warning",
        message: `Mobile performance score is ${pageSpeed.performanceScore}/100`,
      });
    } else {
      issues.push({
        type: "performance",
        severity: "pass",
        message: `Mobile performance score is ${pageSpeed.performanceScore}/100`,
      });
    }

    if (pageSpeed.largestContentfulPaint > 4000) {
      issues.push({
        type: "lcp",
        severity: "error",
        message: `LCP is ${(pageSpeed.largestContentfulPaint / 1000).toFixed(1)}s (should be under 2.5s)`,
      });
    } else if (pageSpeed.largestContentfulPaint > 2500) {
      issues.push({
        type: "lcp",
        severity: "warning",
        message: `LCP is ${(pageSpeed.largestContentfulPaint / 1000).toFixed(1)}s (should be under 2.5s)`,
      });
    }

    if (pageSpeed.cumulativeLayoutShift > 0.25) {
      issues.push({
        type: "cls",
        severity: "error",
        message: `CLS is ${pageSpeed.cumulativeLayoutShift.toFixed(3)} (should be under 0.1)`,
      });
    } else if (pageSpeed.cumulativeLayoutShift > 0.1) {
      issues.push({
        type: "cls",
        severity: "warning",
        message: `CLS is ${pageSpeed.cumulativeLayoutShift.toFixed(3)} (should be under 0.1)`,
      });
    }
  }

  // Calculate score
  const score = calculateScore(issues);

  // Count words
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = textContent.split(/\s+/).filter(Boolean).length;

  return {
    url,
    score,
    title: parsed.title,
    metaDescription: parsed.metaDescription,
    issues,
    pageSpeed: pageSpeed
      ? {
          performanceScore: pageSpeed.performanceScore,
          lcp: pageSpeed.largestContentfulPaint,
          cls: pageSpeed.cumulativeLayoutShift,
          tbt: pageSpeed.totalBlockingTime,
        }
      : null,
    headings: { h1: parsed.h1, h2: parsed.h2 },
    imageCount: parsed.images.length,
    imagesWithoutAlt: parsed.images.filter((img) => !img.alt).length,
    internalLinks: parsed.links.filter((l) => l.isInternal).length,
    externalLinks: parsed.links.filter((l) => !l.isInternal).length,
    wordCount,
    loadTimeMs,
  };
}

// ── HTML parsing ────────────────────────────────────────────────────────────

type ParsedPage = {
  title: string;
  metaDescription: string;
  h1: string[];
  h2: string[];
  images: Array<{ src: string; alt: string }>;
  links: Array<{ href: string; isInternal: boolean }>;
  hasCanonical: boolean;
  hasViewport: boolean;
  hasOpenGraph: boolean;
};

function parsePageHtml(html: string, pageUrl: string): ParsedPage {
  const origin = new URL(pageUrl).origin;

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";

  const metaMatch =
    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ??
    html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  const metaDescription = metaMatch?.[1]?.trim() ?? "";

  const h1: string[] = [];
  const h1Pattern = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let m: RegExpExecArray | null;
  while ((m = h1Pattern.exec(html)) !== null)
    h1.push(m[1].replace(/<[^>]+>/g, "").trim());

  const h2: string[] = [];
  const h2Pattern = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  while ((m = h2Pattern.exec(html)) !== null)
    h2.push(m[1].replace(/<[^>]+>/g, "").trim());

  const images: Array<{ src: string; alt: string }> = [];
  const imgPattern = /<img\s+[^>]*src=["']([^"']*)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
  while ((m = imgPattern.exec(html)) !== null) {
    images.push({ src: m[1], alt: m[2] ?? "" });
  }

  const links: Array<{ href: string; isInternal: boolean }> = [];
  const linkPattern = /<a\s+[^>]*href=["']([^"']*)["'][^>]*>/gi;
  while ((m = linkPattern.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], pageUrl);
      links.push({ href: resolved.href, isInternal: resolved.origin === origin });
    } catch {
      // Skip invalid URLs
    }
  }

  const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasOpenGraph = /<meta[^>]+property=["']og:/i.test(html);

  return { title, metaDescription, h1, h2, images, links, hasCanonical, hasViewport, hasOpenGraph };
}

// ── Checks ──────────────────────────────────────────────────────────────────

function runSinglePageChecks(page: ParsedPage, loadTimeMs: number): HealthIssue[] {
  const issues: HealthIssue[] = [];

  // Title
  if (!page.title) {
    issues.push({ type: "title", severity: "error", message: "Missing page title" });
  } else if (page.title.length > 60) {
    issues.push({ type: "title", severity: "warning", message: `Title is ${page.title.length} characters (recommended: under 60)` });
  } else {
    issues.push({ type: "title", severity: "pass", message: `Title is ${page.title.length} characters` });
  }

  // Meta description
  if (!page.metaDescription) {
    issues.push({ type: "meta_description", severity: "error", message: "Missing meta description" });
  } else if (page.metaDescription.length < 120 || page.metaDescription.length > 160) {
    issues.push({ type: "meta_description", severity: "warning", message: `Meta description is ${page.metaDescription.length} characters (recommended: 150-160)` });
  } else {
    issues.push({ type: "meta_description", severity: "pass", message: `Meta description is ${page.metaDescription.length} characters` });
  }

  // H1
  if (page.h1.length === 0) {
    issues.push({ type: "h1", severity: "error", message: "No H1 tag found" });
  } else if (page.h1.length > 1) {
    issues.push({ type: "h1", severity: "warning", message: `${page.h1.length} H1 tags found (should have exactly 1)` });
  } else {
    issues.push({ type: "h1", severity: "pass", message: "Single H1 tag present" });
  }

  // Images without alt
  const noAlt = page.images.filter((img) => !img.alt).length;
  if (noAlt > 0) {
    issues.push({ type: "alt_text", severity: "warning", message: `${noAlt} of ${page.images.length} images missing alt text` });
  } else if (page.images.length > 0) {
    issues.push({ type: "alt_text", severity: "pass", message: `All ${page.images.length} images have alt text` });
  }

  // Canonical
  if (!page.hasCanonical) {
    issues.push({ type: "canonical", severity: "warning", message: "No canonical URL set" });
  } else {
    issues.push({ type: "canonical", severity: "pass", message: "Canonical URL is set" });
  }

  // Viewport
  if (!page.hasViewport) {
    issues.push({ type: "viewport", severity: "error", message: "Missing viewport meta tag (not mobile-friendly)" });
  } else {
    issues.push({ type: "viewport", severity: "pass", message: "Viewport meta tag present" });
  }

  // Open Graph
  if (!page.hasOpenGraph) {
    issues.push({ type: "og_tags", severity: "info", message: "No Open Graph tags (social sharing won't show rich previews)" });
  } else {
    issues.push({ type: "og_tags", severity: "pass", message: "Open Graph tags present" });
  }

  // Load time
  if (loadTimeMs > 5000) {
    issues.push({ type: "load_time", severity: "error", message: `Page loaded in ${(loadTimeMs / 1000).toFixed(1)}s (should be under 3s)` });
  } else if (loadTimeMs > 3000) {
    issues.push({ type: "load_time", severity: "warning", message: `Page loaded in ${(loadTimeMs / 1000).toFixed(1)}s (should be under 3s)` });
  } else {
    issues.push({ type: "load_time", severity: "pass", message: `Page loaded in ${(loadTimeMs / 1000).toFixed(1)}s` });
  }

  return issues;
}

function calculateScore(issues: HealthIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    switch (issue.severity) {
      case "error": score -= 10; break;
      case "warning": score -= 4; break;
      case "info": score -= 1; break;
    }
  }
  return Math.max(0, Math.min(100, score));
}
