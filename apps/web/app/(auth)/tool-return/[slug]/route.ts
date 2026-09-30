import { NextResponse } from "next/server";
import { getTool } from "@/lib/public-tools/registry";
import { isPaidKind } from "@/lib/public-tools/types";
import { isToolSlugShape, toolPageUrl } from "@/lib/public-tools/return-url";

/**
 * GET /tool-return/<slug>
 *
 * The last hop of "sign up (or in) from a tool": the auth callback and the
 * sign-in form send the person here with a plain internal `next`, and this
 * sends them on to https://altorank.co/tools/<slug>/?run=1, where the widget
 * restores what they typed and runs it once.
 *
 * Inside the (auth) group, so the middleware keeps it behind a session like
 * every other page; and not under the dashboard layout, so the onboarding
 * wizard and the trial card do not intercept this one trip. They still apply
 * the next time the person opens the app themselves.
 *
 * The external URL is built here from a constant origin and a slug found in
 * the tool registry. A slug that is not a paid tool goes to the tools hub.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tool = isToolSlugShape(slug) ? getTool(slug) : undefined;
  const target = tool && isPaidKind(tool.kind) ? toolPageUrl(tool.slug) : toolPageUrl(null);
  return NextResponse.redirect(target, 303);
}
