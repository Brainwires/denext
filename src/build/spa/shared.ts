// SPA mode: the pieces every SPA path (build, export, prod, dev) shares — URL/file
// constants, the generated entry, the HTML shell, and the config/entry resolution.

import { resolve } from "@std/path";
import type { SpaConfig } from "../../server/config.ts";
import { computeCsp } from "../../server/csp.ts";
import type { ProjectPaths } from "../paths.ts";

/** The client-asset URL prefix (matches the App Router prod server). */
export const CLIENT_PREFIX = "/_denext/client/";
/** Live-reload SSE endpoint (dev). */
export const RELOAD_PATH = "/_denext/reload";
/** The external dev-reload module URL (kept out of the CSP inline-script path). */
export const DEV_RELOAD_JS_PATH = "/_denext/dev-reload.js";
/** The SPA entry bundle basename. */
export const ENTRY_FILE = "index.js";
/** The SPA extracted-stylesheet basename. */
export const STYLE_FILE = "index.css";
/** The generated shell basename. */
export const SHELL_FILE = "index.html";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The bundle entry source: import the user's entry module for its side effects
 * (it mounts the app itself). Kept as a generated wrapper — rather than bundling
 * the entry file directly — so this seam can inject the dev Fast Refresh hooks.
 *
 * In `dev`, it installs Fast Refresh **before** the app mounts: `enableFastRefresh()`
 * runs as inline code (after the static `denext/client` import's body), then the
 * user entry is pulled in with a **dynamic** `import()` so its `createRoot(...)` runs
 * with the family seam already active — a plain static `import` of the entry would be
 * hoisted and execute before the inline enable call. The refresh runtime is dev-only,
 * so a production entry keeps the bare static import (nothing extra ships).
 */
export function generateSpaEntry(entryUrl: string, dev = false): string {
  if (!dev) {
    return `// denext generated SPA entry — do not edit.\nimport ${JSON.stringify(entryUrl)};\n`;
  }
  return `// denext generated SPA entry (dev) — do not edit.\n` +
    `import { enableFastRefresh } from "denext/client-runtime";\n` +
    `enableFastRefresh();\n` +
    `await import(${JSON.stringify(entryUrl)});\n`;
}

/**
 * Classify a batch of changed source paths into the dev live-reload action:
 * `"refresh"` (Fast Refresh — re-import the rebuilt bundle, reconcile in place,
 * preserve state) for ordinary component/source edits, or `"reload"` (full page
 * reload) when the change is one Fast Refresh can't safely reconcile — the SPA
 * **entry module itself** (its top-level `createRoot(...).render(...)` mount may
 * have changed) or a `public/` asset (served files, not part of the module graph).
 *
 * Conservative on purpose: any entry/public change in the batch forces a reload, so
 * a mixed edit is never silently half-applied. Exported for testing.
 */
export function classifySpaChange(
  changed: string[],
  entryPath: string,
  publicDir: string,
): "reload" | "refresh" {
  for (const p of changed) {
    if (p === entryPath) return "reload";
    if (p === publicDir || p.startsWith(publicDir + "/")) return "reload";
  }
  return "refresh";
}

let warnedSpaHead = false;
/**
 * Dev-only, once-per-process warning that `spa.head` is injected into `<head>` as raw
 * HTML (mirrors `metadata.head`'s warning) — a reminder to sanitize any untrusted
 * input the app splices into it, since the SPA shell is the config most likely to be
 * fed dynamic values.
 */
function warnRawSpaHeadOnce(): void {
  if (warnedSpaHead) return;
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  warnedSpaHead = true;
  console.warn(
    "denext: spa.head is injected into <head> as raw HTML — sanitize any untrusted " +
      "input to avoid injection. (dev-only warning)",
  );
}

/**
 * Opt-in CSP for the shell (client-only React ships none by default; this is parity
 * with Vite/CRA, not a limitation). Emitted as a <meta> so it applies for `export`
 * (any static host), `start`, and `dev`. `frame-ancestors` is header-only — ignored
 * in <meta> — so it is dropped here; the always-on `X-Frame-Options: SAMEORIGIN`
 * (applyDefaultSecurityHeaders) covers clickjacking. The shell ships no inline
 * script, so `script-src 'self'` needs no hashes; inline <style> in `spa.head` is
 * hashed by computeCsp so it stays allowed.
 */
async function cspMetaTag(spa: SpaConfig, head: string): Promise<string> {
  if (!spa.csp || spa.csp === "off") return "";
  const route = spa.csp === "strict" ? undefined : spa.csp;
  const policy = (await computeCsp(head, route))
    .split("; ")
    .filter((d) => !/^frame-ancestors\b/.test(d))
    .join("; ");
  return `\n    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}" />`;
}

/** Generate the HTML shell that boots the SPA bundle. */
export async function spaShellHtml(opts: {
  spa: SpaConfig;
  /** URL of the client entry bundle (e.g. `/_denext/client/index.js`). */
  scriptSrc: string;
  /** URL of the extracted stylesheet, when the app has CSS. */
  styleHref?: string;
  /** URL of the dev-reload module (dev only). */
  devScriptSrc?: string;
}): Promise<string> {
  const { spa } = opts;
  const lang = spa.lang ?? "en";
  const title = spa.title ?? "denext app";
  const rootId = spa.rootId ?? "root";
  const style = opts.styleHref
    ? `\n    <link rel="stylesheet" href="${escapeHtml(opts.styleHref)}" />`
    : "";
  if (spa.head) warnRawSpaHeadOnce();
  const head = spa.head ? `\n    ${spa.head}` : "";
  const devScript = opts.devScriptSrc
    ? `\n    <script src="${escapeHtml(opts.devScriptSrc)}"></script>`
    : "";
  const cspMeta = await cspMetaTag(spa, head);
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="utf-8" />${cspMeta}
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>${style}${head}
  </head>
  <body>
    <div id="${escapeHtml(rootId)}"></div>
    <script type="module" src="${escapeHtml(opts.scriptSrc)}"></script>${devScript}
  </body>
</html>
`;
}

/** Resolve the SPA config + absolute entry path, throwing a clear error if absent. */
export function spaEntryPath(paths: ProjectPaths): { spa: SpaConfig; entryPath: string } {
  const spa = paths.config?.spa;
  if (!spa) {
    throw new Error(
      'denext: mode "spa" requires a `spa` config (e.g. `spa: { entry: "./src/main.tsx" }`)',
    );
  }
  return { spa, entryPath: resolve(paths.projectDir, spa.entry) };
}

/** Assert the entry module exists on disk (a clear error beats a cryptic bundle failure). */
export async function assertEntryExists(entryPath: string): Promise<void> {
  try {
    const info = await Deno.stat(entryPath);
    if (!info.isFile) throw new Error();
  } catch {
    throw new Error(`denext: SPA entry not found at ${entryPath} (check \`spa.entry\`).`);
  }
}

/** True for a request that should receive the SPA shell (a navigation), not a 404. */
export function wantsShell(request: Request, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) return true;
  // Extensionless paths are navigations (client-router routes); a path with a file
  // extension that wasn't served as an asset above is a genuine 404.
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}
