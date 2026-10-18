// Cache Components on: a cacheable page renders as a cached static shell (PPR). The page is an
// isomorphic route (no "use client" boundary), so its `useApi({ suspense: true })` result must
// seed hydration from that shell. Exercised by use-api-ppr.e2e.test.ts.
export default { cacheComponents: true };
