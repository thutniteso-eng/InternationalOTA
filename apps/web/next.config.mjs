/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@internationalota/shared',
    '@internationalota/i18n',
    '@internationalota/money',
    '@internationalota/time',
  ],
  async rewrites() {
    const raw = process.env['API_INTERNAL_URL']?.trim();
    const apiBase = (raw && raw.length > 0 ? raw : 'http://localhost:4000').replace(/\/+$/, '');
    return [
      {
        source: '/api/auth/:path*',
        destination: `${apiBase}/api/auth/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${apiBase}/:path*`,
      },
      {
        source: '/mock-psp/:path*',
        destination: `${apiBase}/mock-psp/:path*`,
      },
    ];
  },
};

export default nextConfig;
