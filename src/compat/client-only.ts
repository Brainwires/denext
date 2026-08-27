// denext no-op for the npm `client-only` package. Symmetric to `server-only` (see
// ./server-only.ts): the SERVER-bundle boundary is enforced at build time by the esbuild
// env-poison plugin, so at runtime `client-only` is inert. Migrate aliases `client-only`
// here so a native import resolves to this no-op instead of the throwing npm module.
export {};
