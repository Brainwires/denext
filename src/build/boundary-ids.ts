// The stable ids of the client/server boundary's modules: a dependency-free leaf, so the server
// runtime (which names islands by these ids) imports it without the build tooling.

import { fromFileUrl, relative } from "@std/path";

/**
 * A stable, dependency-free short hash (FNV-1a, 32-bit) rendered in base-36.
 * Used to derive client/server ids from a module's app-relative path so ids are
 * deterministic across machines and runs.
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The app-relative, forward-slashed path of a module (the id/hash basis). */
function relKey(appDir: string, fileUrl: string): string {
  return relative(appDir, fromFileUrl(fileUrl)).replaceAll("\\", "/");
}

/** Derive the stable client id (`c_<hash>`) for a `"use client"` module. */
export function clientIdFor(appDir: string, fileUrl: string): string {
  return "c_" + shortHash(relKey(appDir, fileUrl));
}

/** Derive the stable module id (`<hash>`) for a `"use server"` module. */
export function serverModuleIdFor(appDir: string, fileUrl: string): string {
  return shortHash(relKey(appDir, fileUrl));
}
