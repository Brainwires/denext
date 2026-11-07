// A stand-in for the system browser opener (`rundll32.exe` on Windows), compiled by the window test
// into a folder it puts first on the app's PATH: it records the URL it was asked to open in
// `browser.log` next to itself and opens nothing. macOS and Linux get the same as a shell script
// (`open` / `xdg-open`, see `e2e/window-test.ts`).

import { dirname, join } from "@std/path";

/** The argument of the window test's warm-up run (`BROWSER_STUB_WARM_UP` there). */
const WARM_UP = "--kitchen-sink-warm-up";

const log = join(dirname(Deno.execPath()), "browser.log");
// The window test runs it once with WARM_UP before the app starts (see `installBrowserStub`):
// that run records nothing.
if (Deno.args[0] !== WARM_UP) {
  // rundll32's argv is `url.dll,FileProtocolHandler <url>`: record the URL (the last argument).
  await Deno.writeTextFile(log, `${Deno.args.at(-1) ?? ""}\n`, { append: true });
}
