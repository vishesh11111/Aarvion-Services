/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Produces a minimal self-contained server bundle in `.next/standalone`, which
  // is what the production Dockerfile copies. Cuts the runtime image from
  // ~1.2 GB (full node_modules) to ~200 MB.
  output: 'standalone',

  poweredByHeader: false,
  compress: true,

  eslint: {
    // Lint runs as its own CI step; failing the build on a style rule turns a
    // formatting nit into a deploy blocker.
    ignoreDuringBuilds: true,
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
