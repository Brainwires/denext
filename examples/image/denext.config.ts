import type { DenextConfig } from "denext/server";

export default {
  images: {
    // Remote sources must be allowlisted before the `/_denext/image` endpoint
    // will fetch and optimize them (SSRF defense). Add the hosts you actually use.
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "*.githubusercontent.com" },
    ],
    // The endpoint only honors `w=` values drawn from deviceSizes ∪ imageSizes;
    // any other width is refused with a 400. These defaults match Next.js — shown
    // here explicitly so the demo's widths are obviously in-allowlist.
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
} satisfies DenextConfig;
