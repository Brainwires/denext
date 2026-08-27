// denext no-op for the npm `server-only` package on the deno-native SSR path.
//
// `server-only`'s real module throws "This module cannot be imported from a Client
// Component" so a client bundle that pulls it in fails LOUDLY. denext enforces that
// boundary at BUILD time instead (the esbuild env-poison plugin errors when a client
// bundle imports `server-only`), so at runtime the package only ever runs server-side
// and can be inert. Migrate aliases `server-only` here so the native SSR import resolves
// to this no-op rather than the throwing npm module (which denext's SSR loader, lacking
// the `react-server` export condition, would otherwise pick).
export {};
