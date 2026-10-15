/// <reference path="./globals.d.ts" />
/**
 * `denext/platform` — the build target as a compile-time constant.
 *
 * ```ts
 * import { platform } from "denext/platform";
 * if (platform === "ios") {
 *   // …only reaches the iOS build: every other target's bundle drops this branch
 * }
 * ```
 *
 * denext builds one client per target: `web` for `denext build` / `start` / `dev` and a plain
 * `denext export`, `ios` / `android` for `denext mobile build` (and `denext export --platform`),
 * `macos` / `windows` / `linux` for `denext desktop package` / `run`. At build time every read
 * of `platform` in the app's own modules is folded to that target's name, and a comparison with
 * a string literal (`platform === "ios"`, `platform !== "web"`) to `true` / `false`, so the
 * bundler dead-code-eliminates the other targets' branches and whatever only they import. The
 * fold runs on every build path: the App Router (native and drop-in), SPA mode, React Native
 * mode, and `denext dev` (per request, for the target the page names). Server rendering agrees:
 * the render of a `denext export --platform` and of a shell's `denext dev` request loads the
 * app's modules with the same fold.
 *
 * A read the fold can't see (a dependency that imports `denext/platform`) takes the value the
 * build seeded where it could (the esbuild paths), else `"web"`. Platform-specific files
 * (`Button.ios.tsx`) pick whole modules per target; `runtimePlatform()` from `denext/mobile`
 * asks the running shell instead.
 *
 * @module
 */

/** A build target: the web, a phone OS, or a desktop OS. */
export type Platform = "web" | "ios" | "android" | "macos" | "windows" | "linux";

const TARGETS: readonly string[] = ["web", "ios", "android", "macos", "windows", "linux"];

/** The seeded target, when one was seeded and names a target. */
function seeded(): Platform {
  const value = typeof __DENEXT_PLATFORM__ === "string" ? __DENEXT_PLATFORM__ : undefined;
  return value !== undefined && TARGETS.includes(value) ? value as Platform : "web";
}

/**
 * The target this build is for. Folded to a string literal at build time in the app's own
 * modules (and `platform === "…"` to a boolean), so other targets' branches are removed.
 */
export const platform: Platform = seeded();
