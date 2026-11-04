// The plugin kit's build-step primitives (src/plugin/kit.ts re-exports them): the next-compat
// build, the MDX compile, client bundling, the CSS pipeline and the Edge Function scaffold. They reach the build tooling (esbuild, swc, lightningcss, sass,
// `@mdx-js/mdx`), so they come through this one module, which `denext build --compile` maps to
// ./build-only-stub.ts: a plugin's build steps never run in a compiled app, and its binary then
// embeds none of that tooling.

export { buildNextCompatModules } from "./next-compat-build.ts";
export { compileMdxSource } from "./next-compat.ts";
export { bundleRoutes, platformClientRedirects } from "./plugin-bundle.ts";
export { buildAppCss, extractRouteCss } from "./plugin-css.ts";
export { edgeFunctionSource } from "./generate.ts";
