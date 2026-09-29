// `denext mobile add offline-screen`: the page a Capacitor app shows when its content cannot
// load, for App Review (guideline 4.2 rejects apps that are "a repackaged website", and an app
// that shows a blank or browser error page offline reads as one) and for users.
//
// It writes `public/offline.html` (a self-contained page: no script from the app's bundle, a
// Retry button that reloads) into the denext app, which `denext export` copies into the webDir,
// and points Capacitor's `server.errorPath` at it: "a local html page to display in case of
// errors" (https://capacitorjs.com/docs/config). At runtime, `installOfflineScreen()` from
// `denext/mobile` covers the other case, the app running with the network gone.
//
// The page carries a marker line like denext's native templates: an unedited one is upgraded by a
// later run, an edited one is kept.

import { join } from "@std/path";
import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";
import {
  capacitorConfigFile,
  readCapacitorConfig,
  withCapacitorConfigValue,
} from "./capacitor-config.ts";

/** The page's path in the web root (`server.errorPath` is relative to the webDir). */
const OFFLINE_PAGE = "offline.html";
/** Where it is written, relative to the project. */
const PUBLIC_PAGE = `public/${OFFLINE_PAGE}`;
const FAMILY = "offline-screen";
const TEMPLATE_VERSION = 1;

/** The page: system fonts, light and dark, safe areas, a Retry button. No external resource. */
export const OFFLINE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Offline</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --accent: #1d1d1b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121211; --fg: #ededea; --muted: #9a9a94; --accent: #ededea; } }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--fg);
    font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: env(safe-area-inset-top) 24px env(safe-area-inset-bottom);
  }
  main { max-width: 320px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 24px; }
  button {
    font: inherit; font-weight: 600; color: var(--bg); background: var(--accent); border: 0;
    border-radius: 12px; padding: 12px 28px; min-height: 44px;
  }
</style>
</head>
<body>
<main>
  <h1>You're offline</h1>
  <p>This screen needs a connection. Check Wi-Fi or mobile data, then try again.</p>
  <button type="button" onclick="location.replace('/')">Try again</button>
</main>
</body>
</html>
`;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** Write the page unless an edited one is there (kept unless `force`). */
async function writePage(
  dir: string,
  force: boolean,
  report: NativeInstallReport,
): Promise<void> {
  const path = join(dir, PUBLIC_PAGE);
  const next = await renderMarkedTemplate(FAMILY, TEMPLATE_VERSION, OFFLINE_PAGE_HTML, "xml");
  const current = await readText(path);
  if (current === next) return void report.unchanged.push(PUBLIC_PAGE);
  if (current !== undefined && !force && (await markedTemplateIntact(FAMILY, current)) !== true) {
    report.kept.push(PUBLIC_PAGE);
    report.manual.push(`${PUBLIC_PAGE} was edited and is kept (--force replaces it)`);
    return;
  }
  await Deno.mkdir(join(dir, "public"), { recursive: true });
  await Deno.writeTextFile(path, next);
  report.written.push(PUBLIC_PAGE);
  if (current !== undefined) report.upgraded.push(PUBLIC_PAGE);
}

/** Point `server.errorPath` at the page, unless the config already names one. */
async function setErrorPath(dir: string, report: NativeInstallReport): Promise<void> {
  const file = await capacitorConfigFile(dir);
  if (!file) return void report.skipped.push("no capacitor.config.* to set server.errorPath in");
  const rel = file.slice(dir.length + 1);
  const source = await Deno.readTextFile(file);
  const server = (await readCapacitorConfig(file, source))?.server as
    | Record<string, unknown>
    | undefined;
  if (typeof server?.errorPath === "string" || /\berrorPath\b/.test(source)) {
    if (server?.errorPath !== OFFLINE_PAGE) {
      report.manual.push(
        `${rel} already sets server.errorPath; point it at "${OFFLINE_PAGE}" to use this page`,
      );
    } else report.unchanged.push(rel);
    return;
  }
  try {
    await Deno.writeTextFile(
      file,
      await withCapacitorConfigValue(file, source, ["server", "errorPath"], OFFLINE_PAGE),
    );
    report.written.push(rel);
  } catch (err) {
    report.manual.push(
      `set server.errorPath: "${OFFLINE_PAGE}" in ${rel} (${
        err instanceof Error ? err.message : err
      })`,
    );
  }
}

/**
 * Install the offline / error screen into a Capacitor project: `public/offline.html` and
 * `server.errorPath` in the Capacitor config.
 *
 * @param opts The project root, and `force` to replace an edited page.
 * @returns What was written.
 */
export async function addOfflineScreenToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  await writePage(opts.dir, opts.force === true, report);
  await setErrorPath(opts.dir, report);
  if (
    !(await readText(join(opts.dir, "denext.config.ts"))) &&
    !(await readText(join(opts.dir, "denext.config.js")))
  ) {
    report.manual.push(
      `no denext.config here: move ${PUBLIC_PAGE} into the denext app's public/ folder so ` +
        "`denext export` copies it into the webDir",
    );
  }
  return report;
}
