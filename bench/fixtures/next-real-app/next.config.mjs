/**
 * Next.js config for the real-library benchmark fixture — a like-for-like mirror
 * of bench/fixtures/denext-app (same routes, same npm libraries: recharts,
 * react-hook-form, @radix-ui/react-dialog, lucide-react). Type/lint checks are
 * skipped so `next build` is fast and deterministic; emitted bytes are unaffected.
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
