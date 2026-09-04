// Unbundled dev server (Vite-class dev loop).
//
// The bundled dev path re-bundles a whole route through a `deno bundle` subprocess
// on every save (~hundreds of ms) and the client re-imports the entire route entry.
// This subsystem serves each source module UNBUNDLED — transformed on demand (~5ms,
// warm esbuild) at its own URL, with its imports rewritten to dev URLs — so the
// browser loads the native ESM graph. On an edit only the changed module is
// re-transformed and re-imported; the reconciler's family-current substitution
// (see refresh-runtime `enablePerModuleRefresh`) swaps the new code onto the live
// fiber tree with hook state intact. That is true per-module HMR.
//
// Dev-only. esbuild + the deno-loader are build-time tools; nothing here ships.
//
// URL scheme (all under `/_denext/` so the strict dev CSP's `script-src 'self'` and
// the same-origin dev-endpoint gate already cover it):
//   /_denext/@dep/<slug>.js   a pre-bundled dependency (denext core — single instance)
//   /_denext/@fs<abs-path>     a first-party source module, transformed + rewritten
//   /_denext/@entry?p=<route>  the generated unbundled client entry for a route
//   /_denext/@empty.js         the shared empty shim (stylesheet imports resolve here)
//   /_denext/@npm/<slug>.js    (compat) the on-demand npm dependency bundle
//
// The stages live under `./dev-unbundled/` around one shared `UnbundledState`:
// `resolve` (specifier → dev URL), `deps` (the pre-bundles), `transform` (per-module +
// generated-entry transforms), `entries` (route / Flight / SPA entries), `handler` (the
// HTTP surface) and `hmr` (change propagation). This module wires them into the object
// the dev servers use.
//
// @module

import * as esbuild from "esbuild";
import type { RouteManifest } from "../router/manifest.ts";
import type { BoundaryManifest } from "./module-graph.ts";
import { ensureDeps } from "./dev-unbundled/deps.ts";
import {
  entryUrlFor,
  serveFlightEntry,
  spaEntryUrl,
  supportsRoute,
} from "./dev-unbundled/entries.ts";
import { handle } from "./dev-unbundled/handler.ts";
import { onChange, propagate } from "./dev-unbundled/hmr.ts";
import {
  createUnbundledState,
  type UnbundledDevOptions,
  type UnbundledState,
  versionOf,
} from "./dev-unbundled/state.ts";
import { transform } from "./dev-unbundled/transform.ts";

export type { UnbundledDevOptions } from "./dev-unbundled/state.ts";

/**
 * The unbundled dev subsystem for one project. Owns the warm esbuild service, the
 * pre-bundled deps, the per-module transform cache, and the module graph used to
 * compute HMR updates. Created once per dev server; `stop()` on shutdown.
 */
export function createUnbundledDev(opts: UnbundledDevOptions) {
  const st: UnbundledState = createUnbundledState(opts);
  return {
    /** Handle an unbundled dev request, or return null if the URL isn't ours. */
    handle: (_request: Request, url: URL, manifest: RouteManifest) => handle(st, url, manifest),
    entryUrlFor,
    spaEntryUrl,
    supportsRoute,
    serveFlightEntry: (boundary: BoundaryManifest) => serveFlightEntry(st, boundary),
    onChange: (changed: string[]) => onChange(st, changed),
    stop: async (): Promise<void> => {
      await esbuild.stop().catch(() => {});
    },
    // exposed for tests
    _internal: {
      transform: (abs: string) => transform(st, abs),
      propagate: (abs: string, seen: Set<string>) => propagate(st, abs, seen),
      versionOf: (abs: string) => versionOf(st, abs),
      ensureDeps: () => ensureDeps(st),
    },
  };
}

export type UnbundledDev = ReturnType<typeof createUnbundledDev>;
