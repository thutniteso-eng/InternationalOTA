/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@internationalota/shared',
    '@internationalota/i18n',
    '@internationalota/money',
    '@internationalota/time',
  ],
};

export default nextConfig;
