import path from "node:path";
import type { NextConfig } from "next";

/** The hosted app. Only it hands its root and marketing paths to altorank.co. */
const HOSTED_APP_HOST = "app.altorank.co";
const MARKETING_SITE = "https://altorank.co";

/**
 * Whether this build is the hosted app, read from NEXT_PUBLIC_APP_URL (set at
 * build time on every real deployment). A self-hosted install has no
 * marketing site: its root and /pricing used to answer a permanent redirect to
 * altorank.co, so its own users landed on the vendor's homepage.
 */
function isHostedApp(appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): boolean {
  try {
    return new URL(appUrl ?? "").hostname === HOSTED_APP_HOST;
  } catch {
    return false;
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Next 16 holds an exclusive lock on `<distDir>/dev`, so a second `next dev`
  // in the same checkout (the e2e runner's stubbed server on 3110 beside a
  // normal `next dev`) refuses to start. The e2e config sets NEXT_DIST_DIR so
  // its server builds into its own directory; unset everywhere else.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // `E2E_STUBS` is a server-only flag everywhere else, but the PostHog client
  // hook has to see it: it warns about a missing key in development, and the
  // e2e runner is a development server with no key by design. Mirroring it
  // under a NEXT_PUBLIC_ name is what gets it into the client bundle.
  env: { NEXT_PUBLIC_E2E_STUBS: process.env.E2E_STUBS ?? "" },
  // Emits a self-contained server bundle with only the node_modules actually
  // reached, which is what makes the self-host image small enough to be worth
  // shipping. Vercel ignores this and uses its own adapter, so it is safe here.
  output: "standalone",
  // Without this, Next picks the tracing root by walking up for a lockfile, and
  // it does not stop at ours: a stray package-lock.json two directories above
  // the repo wins, so `standalone` gets traced from the wrong root and drags in
  // whatever else lives up there. npm hoists our workspace deps to the repo
  // root, so that - not apps/web - is the correct root to pin.
  outputFileTracingRoot: path.join(__dirname, "../.."),

  async redirects() {
    const common = [
      // The section was called Clients in the nav and Workspaces on the
      // dashboard, for the same `getWorkspaces()` rows. POSITIONING.md's third
      // defensible claim is "a workspace per site or per client", so the model
      // already had the neutral word. Bookmarks and any link we have sent out
      // still resolve.
      { source: '/clients', destination: '/workspaces', permanent: true },
      { source: '/clients/:path*', destination: '/workspaces/:path*', permanent: true },
    ];
    if (!isHostedApp()) {
      // Any other install: the root goes to the dashboard (the middleware
      // sends a signed-out visitor on to /signin). Not permanent, so a later
      // change of address is not stuck in browsers. The auth-code exception
      // is the same as the hosted one below.
      return [
        ...common,
        { source: '/', destination: '/dashboard', permanent: false, missing: [{ type: 'query', key: 'code' }] },
      ];
    }
    return [
      ...common,
      // The root bounces to the marketing site - EXCEPT when it carries an
      // auth code. Config redirects run before middleware, so without this
      // matcher the middleware's stray-code handler was unreachable: any auth
      // email link that fell back to the Site URL handed its one-shot code to
      // the marketing site. Found by walking a reset link end to end.
      {
        source: '/',
        destination: MARKETING_SITE,
        permanent: true,
        missing: [{ type: 'query', key: 'code' }],
      },
      { source: '/pricing', destination: MARKETING_SITE + '/pricing', permanent: true },
      // The free tools live on the marketing site like /pricing and /blog do,
      // and this was the one of its siblings nobody added: a link to
      // app.altorank.co/tools/... 404ed instead of landing on the tool.
      { source: '/tools', destination: MARKETING_SITE + '/tools', permanent: true },
      { source: '/tools/:path*', destination: MARKETING_SITE + '/tools/:path*', permanent: true },
      { source: '/integrations', destination: MARKETING_SITE + '/integrations', permanent: true },
      { source: '/blog/:path*', destination: MARKETING_SITE + '/blog/:path*', permanent: true },
      { source: '/success-stories/:path*', destination: MARKETING_SITE + '/success-stories/:path*', permanent: true },
      { source: '/vs/:path*', destination: MARKETING_SITE + '/vs/:path*', permanent: true },
      { source: '/for/:path*', destination: MARKETING_SITE + '/for/:path*', permanent: true },
    ];
  },
};

export default nextConfig;
