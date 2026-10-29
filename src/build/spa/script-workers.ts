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

/** A `<script` open tag without a `nonce` attribute of its own. */
const SCRIPT_TAG = /<script(?=[\s>])(?![^>]*\snonce=)/g;

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
  const stamped = withPolicy.replace(SCRIPT_TAG, `<script nonce="${nonce}"`);
  const boot = `<script src="${escapeHtml(lib)}boot.js" nonce="${nonce}"></script>`;
  const at = stamped.indexOf("</head>");
  return at < 0 ? boot + stamped : `${stamped.slice(0, at)}${boot}\n  ${stamped.slice(at)}`;
}
