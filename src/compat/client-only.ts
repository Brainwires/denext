// denext's `client-only` package equivalent (aliased in by `denext migrate`).
//
// The server-bundle boundary is enforced at BUILD time by the esbuild env-poison plugin.
// Unlike `server-only` (see ./server-only.ts), this module does NOT add a runtime
// wrong-environment throw: denext server-renders client components for the initial HTML,
// so a client component's `import "client-only"` is legitimately evaluated on the SERVER
// during SSR. A server-side throw here (like `clientOnly()` from ../runtime/environment.ts)
// would break that SSR. React's own `client-only` only throws under the `react-server`
// (RSC) export condition, which denext's SSR loader does not select — so it stays inert,
// with the build plugin remaining the enforcement point.
export {};
