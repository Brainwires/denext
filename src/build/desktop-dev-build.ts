// The mark a `denext desktop dev` build carries. Its generated entry (see `desktop-launch.ts`) sets
// `globalThis[Symbol.for(DESKTOP_DEV_BUILD_KEY)] = true` before the app's desktop entry runs, and
// `runDesktop` reads it: a built binary is not the `deno` CLI, so without the mark it would ignore
// `DENEXT_DESKTOP_DEV_URL`, as a packaged app must. Its own module so the desktop runtime does not
// pull in the CLI's build helpers.

/** The `Symbol.for` key of the dev-build mark. */
export const DESKTOP_DEV_BUILD_KEY = "denext.desktop.devBuild";
