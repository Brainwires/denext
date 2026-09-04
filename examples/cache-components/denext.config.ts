import type { DenextConfig } from "denext/server";

export default {
  // Cache Components (Next.js 16): compile `use cache` into cross-request server
  // caching, and render cacheable pages as a static shell + per-request dynamic
  // holes (Partial Prerendering). A stable opt-in — off by default framework-wide.
  cacheComponents: true,
} satisfies DenextConfig;
