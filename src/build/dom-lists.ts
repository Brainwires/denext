// `lists: "denext"` at build time: the DOM list packages (`@legendapp/list/react`, LegendList's
// DOM build), imported by the app's own modules or by its packages, resolve to denext's
// VirtualList-backed runtime modules (src/lists/). A browser bundle loads the prebuilt runtime
// copy (the same graph as the rest of denext, so one hooks instance); a server (SSR) bundle
// keeps the framework source external, as it does for every other denext module. The unbundled
// dev loop maps the same specifiers through `UnbundledDevOptions.specAliases`.

import type * as esbuild from "esbuild";
import { frameworkFileUrl } from "./bundle.ts";

/** One DOM list package specifier denext takes over. */
interface DomListPackage {
  /** The prebuilt runtime specifier (a `DENEXT_RUNTIME_FILES` key). */
  readonly runtime: string;
  /** The framework source behind it (what a server bundle imports). */
  readonly source: string;
}

/** The specifiers `lists: "denext"` resolves to denext modules. */
export const DOM_LIST_PACKAGES: Readonly<Record<string, DomListPackage>> = {
  "@legendapp/list/react": {
    runtime: "denext/lists/legend-list",
    source: "src/lists/legend-list.ts",
  },
};

/** `specifier → runtime specifier`, for the unbundled dev loop's resolver. */
export function domListAliases(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DOM_LIST_PACKAGES).map(([spec, pkg]) => [spec, pkg.runtime]),
  );
}

/** Every specifier taken over, as one esbuild filter. */
const FILTER = new RegExp(
  `^(?:${
    Object.keys(DOM_LIST_PACKAGES).map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")
  })$`,
);

/**
 * The esbuild plugin behind `lists: "denext"`: each DOM list package specifier resolves to its
 * denext module (through the build's own `denext/*` resolution in a browser bundle, the
 * framework source, external, in a server bundle).
 *
 * @param platform The bundle's platform (`"deno"` is the server bundle).
 */
export function domListsPlugin(platform: "browser" | "deno" | "node"): esbuild.Plugin {
  return {
    name: "denext-dom-lists",
    setup(build) {
      build.onResolve({ filter: FILTER }, (args) => {
        const pkg = DOM_LIST_PACKAGES[args.path];
        if (platform !== "browser") return { path: frameworkFileUrl(pkg.source), external: true };
        return build.resolve(pkg.runtime, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
        }).then((r): esbuild.OnResolveResult =>
          r.errors.length > 0
            ? { errors: r.errors }
            : { path: r.path, namespace: r.namespace, external: r.external }
        );
      });
    },
  };
}
