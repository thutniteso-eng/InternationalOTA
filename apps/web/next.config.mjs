/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@internationalota/shared',
    '@internationalota/i18n',
    '@internationalota/money',
    '@internationalota/time',
  ],
};

export default nextConfig;
