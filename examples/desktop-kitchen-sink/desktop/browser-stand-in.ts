/**
 * The window test's stand-in for the system browser on Windows. The auth-session capability opens
 * a URL with `C:\Windows\System32\rundll32.exe` by absolute path (never through `PATH`, so a
 * same-named program earlier on `PATH` can't take its place), which leaves the test no program to
 * swap in as on macOS and Linux. With `KITCHEN_SINK_STAND_IN_BROWSER=1` (set by `e2e/window-test.ts`)
 * the app hands `runDesktop` an `openBrowser` that records the URL instead, and the `browserLog`
 * call of `desktop/kitchen.ts` reads it back.
 *
 * @module
 */

const asked: string[] = [];

/** The recording opener when the window test asked for it on Windows, else `undefined`. */
export function standInBrowser(): ((url: string) => void) | undefined {
  if (Deno.build.os !== "windows") return undefined;
  if (Deno.env.get("KITCHEN_SINK_STAND_IN_BROWSER") !== "1") return undefined;
  return (url) => {
    asked.push(url);
  };
}

/** The URLs the stand-in was asked to open, oldest first. */
export function standInBrowserUrls(): readonly string[] {
  return asked;
}
