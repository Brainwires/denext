// Client/server boundary guards.
//
// denext has no bundler transform of `"use client"`/`"use server"` directives,
// so it can't enforce the RSC boundary at build time. Instead it offers runtime
// guards — the equivalent of the npm `server-only` / `client-only` packages —
// that throw if a module is loaded in the wrong environment. Call one at module
// top level to fail fast (e.g. keep a module holding secrets off the client).

/** True when running on the server (no DOM document present). */
export function isServer(): boolean {
  return typeof document === "undefined";
}

/**
 * Assert the current module is running on the server. Call at module top level
 * to guarantee a module (e.g. one reading secrets or a database) never ships to
 * or executes in the browser.
 *
 * @param name Label used in the thrown error (defaults to "This module").
 * @throws If called in a browser environment.
 */
export function serverOnly(name = "This module"): void {
  if (!isServer()) {
    throw new Error(
      `${name} is server-only and must not be imported into client code.`,
    );
  }
}

/**
 * Assert the current module is running in the browser. Call at module top level
 * to guarantee a module that touches browser-only APIs never runs on the server.
 *
 * @param name Label used in the thrown error (defaults to "This module").
 * @throws If called on the server.
 */
export function clientOnly(name = "This module"): void {
  if (isServer()) {
    throw new Error(
      `${name} is client-only and must not run on the server.`,
    );
  }
}
