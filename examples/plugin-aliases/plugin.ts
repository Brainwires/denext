// A tiny, self-contained denext plugin — the second independent consumer of the
// plugin contract, and the first real one to use the **route-synthesizer** seam
// (`@denext/pages-router` uses the request-handler + build-step seams).
//
// `aliasesPlugin({ "/home": "/", "/about-us": "/about" })` makes each alias path
// render the SAME page as its target, with no file moved or duplicated. It works
// by post-processing every scanned route manifest: for each alias it finds the
// target page route and pushes a clone under the alias path. Because the clone is
// an ordinary `PageRoute` pointing at the real page module, it renders identically
// across dev, build, prod, and static export — the core does the rendering; the
// plugin only contributes routes.
//
// It also registers a teardown, purely to demonstrate the symmetric shutdown seam.

import type { DenextPlugin } from "@denext/denext/server";
import { parsePattern } from "@denext/denext/server";

/** A map of `aliasPath → targetPath` (both are absolute route paths like `/about`). */
export type Aliases = Record<string, string>;

/** Turn a route path (`/`, `/about`, `/blog/x`) into scanner pattern segments. */
function patternFor(routePath: string): ReturnType<typeof parsePattern> {
  return parsePattern(routePath.replace(/^\/+/, ""));
}

/**
 * A denext plugin that adds path aliases: each `aliasPath` renders the page at its
 * `targetPath`. Declare it in `denext.config.ts` as `plugins: [aliasesPlugin({…})]`.
 *
 * @param aliases A map of alias path → existing target path.
 * @returns A {@linkcode DenextPlugin}.
 */
export function aliasesPlugin(aliases: Aliases): DenextPlugin {
  return {
    name: "aliases",
    setup(ctx) {
      ctx.addRouteSynthesizer((manifest) => {
        for (const [alias, target] of Object.entries(aliases)) {
          // Don't shadow a real route that already lives at the alias path.
          if (manifest.pages.some((p) => p.routePath === alias)) continue;
          const source = manifest.pages.find((p) => p.routePath === target);
          if (!source) {
            console.warn(`denext(aliases): no page at "${target}" to alias from "${alias}"`);
            continue;
          }
          manifest.pages.push({
            ...source,
            routePath: alias,
            pattern: patternFor(alias),
          });
        }
      });

      // Demonstrates the teardown seam — runs when the server drains.
      ctx.addTeardown(() => {
        if (ctx.mode === "dev") console.log("denext(aliases): plugin torn down");
      });
    },
  };
}
