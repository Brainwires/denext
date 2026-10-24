// The client/server boundary's shape, and its `manifest.json` form: what the build's import-graph
// crawl (./module-graph.ts) finds and the production server reads back at startup. A leaf module,
// so the server (and a compiled app) never loads the crawler.

import { fromFileUrl, relative, resolve, SEPARATOR, toFileUrl } from "@std/path";

/** A discovered boundary module: its file URL and (optionally) its export names. */
export interface BoundaryRef {
  /** The module's `file://` URL. */
  url: string;
  /** Exported symbol names, when resolved (empty if not extracted). */
  exports: string[];
  /**
   * A `"use server"` module's exports the app's modules reference (./action-references.ts): the
   * only ones the server registers as actions. Absent: every export (an npm module, a module
   * imported as a namespace, or a build that predates the analysis).
   */
  exposed?: string[];
}

/** The client/server module split discovered across an app's import graph. */
export interface BoundaryManifest {
  /** `"use client"` modules keyed by a stable client id (`c_<hash>`). */
  client: Map<string, BoundaryRef>;
  /** `"use server"` modules keyed by a stable module id (`<hash>`). */
  server: Map<string, BoundaryRef>;
}

/** {@link BoundaryManifest} as the build manifest stores it: ids → project-relative paths. */
export interface SerializedBoundary {
  client: Record<string, SerializedRef>;
  server: Record<string, SerializedRef>;
}

/** A {@link BoundaryRef} as `manifest.json` stores it. */
interface SerializedRef {
  path: string;
  exports: string[];
  exposed?: string[];
}

/**
 * Serialize a boundary manifest for `manifest.json` (module URLs → paths relative to
 * `projectDir`, so a deployed build is portable), and rebuild it at server startup — which
 * saves the prod server the import-graph crawl the build already did (30 s on a large app).
 */
export function serializeBoundary(b: BoundaryManifest, projectDir: string): SerializedBoundary {
  const rel = (m: Map<string, BoundaryRef>) =>
    Object.fromEntries(
      [...m].map(([id, ref]) => [id, {
        // `/`-separated so a manifest built on Windows reads the same everywhere.
        path: relative(projectDir, fromFileUrl(ref.url)).split(SEPARATOR).join("/"),
        exports: ref.exports,
        ...(ref.exposed ? { exposed: ref.exposed } : {}),
      }]),
    );
  return { client: rel(b.client), server: rel(b.server) };
}

/** Inverse of {@link serializeBoundary}. */
export function deserializeBoundary(sb: SerializedBoundary, projectDir: string): BoundaryManifest {
  const abs = (r: Record<string, SerializedRef>) =>
    new Map(
      Object.entries(r).map(([id, ref]) => [id, {
        url: toFileUrl(resolve(projectDir, ref.path)).href,
        exports: ref.exports,
        ...(Array.isArray(ref.exposed) ? { exposed: ref.exposed } : {}),
      }]),
    );
  return { client: abs(sb.client), server: abs(sb.server) };
}
