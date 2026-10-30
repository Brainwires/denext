// SPA mode's `<Script strategy="worker">`: Partytown with a per-response CSP nonce.
//
// A SPA renders `<Script>` in the browser, where it reads the slot the Partytown boot script
// sets — the nonce that boot ran with (src/build/partytown.ts). So a SPA served by denext (`denext
// dev`, `denext start`) gets what an App Router page gets, at the shell instead of the render:
// every shell response mints a nonce, the boot tag and the shell's own scripts carry it, and the
// shell's `spa.csp` policy lists it, so the boot's check passes and the worker scripts the app
// renders later carry the same nonce. A static export has no response to mint one for (a nonce
// written into a file is public and reusable), so its worker scripts keep the main-thread
// fallback.

import { join } from "@std/path";
import type { DenextConfig } from "../../server/config.ts";
import {
  PARTYTOWN_BUILD_DIR,
  partytownPublicLib,
  preparePartytown,
  scriptWorkersEnabled,
} from "../partytown.ts";
import { escapeHtml } from "./shared.ts";

/** A SPA has no `basePath`: Partytown is served at the origin's own prefix. */
function spaConfig(config: DenextConfig | null | undefined): DenextConfig | null | undefined {
  return config ? { ...config, basePath: undefined } : config;
}

/** The public path a SPA serves Partytown under (`/_denext/~partytown/`). */
export function spaPartytownLib(config: DenextConfig | null | undefined): string {
  return partytownPublicLib(spaConfig(config));
}

/**
 * Publish the app's Partytown for a SPA server or build (`nextScriptWorkers` on and the package
 * installed): its files into `dest`. False — nothing published, a warning when the package is
 * missing — otherwise.
 *
 * @param config The app's config.
 * @param projectDir The app's directory (where `node_modules` is searched from).
 * @param dest The directory Partytown is served from.
 */
export function prepareSpaPartytown(
  config: DenextConfig | null | undefined,
  projectDir: string,
  dest: string,
): Promise<boolean> {
  return preparePartytown(spaConfig(config), projectDir, dest);
}

/**
 * `denext start`: the Partytown directory the SPA build wrote, or null when the app has it off
 * or the build published none.
 *
 * @param config The app's config.
 * @param clientDir The build's client directory.
 */
export async function builtSpaPartytown(
  config: DenextConfig | null | undefined,
  clientDir: string,
): Promise<string | null> {
  if (!scriptWorkersEnabled(config)) return null;
  const dir = join(clientDir, PARTYTOWN_BUILD_DIR);
  const built = await Deno.stat(join(dir, "boot.js")).then((s) => s.isFile, () => false);
  return built ? dir : null;
}

/** A fresh nonce: 128 random bits, hex. */
export function newScriptNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The shell's `spa.csp` meta tag: its policy is the second group. */
const CSP_META = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;

/**
 * The shell's tokens the stamp acts on, in document order: a comment (group 1 unset, left as it
 * is), an element whose content is text to the HTML parser (`script`, `style`, `textarea`,
 * `title`: group 1 its name, group 2 its attributes, group 3 the rest of the element), and
 * `</head>`. Matching the raw-text elements whole keeps a `<script` or `</head>` inside a
 * script's string literal, a style or a comment from being taken for a tag; an attribute value
 * may hold `>`.
 */
const SHELL_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)(?=[\s>\/])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?(?:<\/\1\s*>|$))|<\/head\s*>/gi;

/** Whether a start tag's attributes name a `nonce` (quoted values blanked first). */
function hasNonce(attributes: string): boolean {
  return /(?:^|\s)nonce\s*=/i.test(attributes.replace(/"[^"]*"|'[^']*'/g, '""'));
}

/**
 * The shell as one response serves it: the Partytown boot tag at the end of `<head>`, `nonce` on
 * every script of the shell (the module entry, the dev reload script, the `spa.shell` inline
 * scripts), and `'nonce-…'` in the `spa.csp` policy's `script-src`, so the boot's check that the
 * page's policy lists its nonce passes. Without `spa.csp` there is no policy to list it in, and
 * the boot accepts the nonce as is.
 *
 * @param shell The built (or dev) HTML shell.
 * @param lib The public path Partytown is served under (ends with `/`).
 * @param nonce This response's nonce ({@linkcode newScriptNonce}).
 * @returns The shell for this response.
 */
export function stampWorkerNonce(shell: string, lib: string, nonce: string): string {
  const source = `'nonce-${nonce}'`;
  const withPolicy = shell.replace(
    CSP_META,
    (_all, open: string, policy: string, close: string) =>
      open + policy.replace(/(^|;\s*)script-src\b/, `$1script-src ${source}`) + close,
  );
  const boot = `<script src="${escapeHtml(lib)}boot.js" nonce="${nonce}"></script>`;
  let booted = false;
  const stamped = withPolicy.replace(
    SHELL_TOKEN,
    (token: string, name: string | undefined, attributes: string, rest: string) => {
      if (name === undefined) {
        if (booted || !/^<\/head/i.test(token)) return token; // a comment, or a later `</head>`
        booted = true;
        return `${boot}\n  ${token}`;
      }
      if (name.toLowerCase() !== "script" || hasNonce(attributes)) return token;
      return `${token.slice(0, 7)} nonce="${nonce}"${attributes}>${rest}`;
    },
  );
  return booted ? stamped : boot + stamped;
}
