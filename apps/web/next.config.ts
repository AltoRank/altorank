import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle with only the node_modules actually
  // reached, which is what makes the self-host image small enough to be worth
  // shipping. Vercel ignores this and uses its own adapter, so it is safe here.
  output: "standalone",

  async redirects() {
    return [
      { source: '/', destination: 'https://altorank.co', permanent: true },
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
