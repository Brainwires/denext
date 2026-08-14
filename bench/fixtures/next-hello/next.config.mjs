/**
 * Next.js config for the benchmark fixture. This app is a like-for-like mirror
 * of denext's examples/hello: same routes, same interactivity boundaries (which
 * pages ship JS, which are static, which island is code-split ssr:false), so the
 * two frameworks are measured building the same behavior.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // Compression is measured by us (gzip) off the raw build output, not by the
  // dev/prod server, so no server-level tuning is needed here.
  reactStrictMode: true,
  // The benchmark measures emitted bundle bytes, not type/lint correctness.
  // Skipping the in-build tsc + eslint passes makes `next build` fast and
  // deterministic without changing a single emitted byte.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
