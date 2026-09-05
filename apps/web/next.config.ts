import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Next 16 holds an exclusive lock on `<distDir>/dev`, so a second `next dev`
  // in the same checkout (the e2e runner's stubbed server on 3110 beside a
  // normal `next dev`) refuses to start. The e2e config sets NEXT_DIST_DIR so
  // its server builds into its own directory; unset everywhere else.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Emits a self-contained server bundle with only the node_modules actually
  // reached, which is what makes the self-host image small enough to be worth
  // shipping. Vercel ignores this and uses its own adapter, so it is safe here.
  output: "standalone",

  async redirects() {
    return [
      // The section was called Clients in the nav and Workspaces on the
      // dashboard, for the same `getWorkspaces()` rows. POSITIONING.md's third
      // defensible claim is "a workspace per site or per client", so the model
      // already had the neutral word. Bookmarks and any link we have sent out
      // still resolve.
      { source: '/clients', destination: '/workspaces', permanent: true },
      { source: '/clients/:path*', destination: '/workspaces/:path*', permanent: true },

      // The root bounces to the marketing site - EXCEPT when it carries an
      // auth code. Config redirects run before middleware, so without this
      // matcher the middleware's stray-code handler was unreachable: any auth
      // email link that fell back to the Site URL handed its one-shot code to
      // the marketing site. Found by walking a reset link end to end.
      {
        source: '/',
        destination: 'https://altorank.co',
        permanent: true,
        missing: [{ type: 'query', key: 'code' }],
      },
      { source: '/pricing', destination: 'https://altorank.co/pricing', permanent: true },
      { source: '/integrations', destination: 'https://altorank.co/integrations', permanent: true },
      { source: '/blog/:path*', destination: 'https://altorank.co/blog/:path*', permanent: true },
      { source: '/success-stories/:path*', destination: 'https://altorank.co/success-stories/:path*', permanent: true },
      { source: '/vs/:path*', destination: 'https://altorank.co/vs/:path*', permanent: true },
      { source: '/for/:path*', destination: 'https://altorank.co/for/:path*', permanent: true },
    ];
  },
};

export default nextConfig;
