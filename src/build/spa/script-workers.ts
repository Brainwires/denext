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
import { newHtmlRewriter } from "../../server/html-rewriter.ts";
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

/**
 * The shell's tokens the stamp acts on, in document order: a comment (group 1 unset, left as it
 * is), an element whose content is text to the HTML parser (`script`, `style`, `textarea`,
 * `title`, …: group 1 its name, group 2 its attributes, group 3 the rest of the element), a
 * `<meta>` start tag (group 4 its name, group 5 its attributes), and `</head>`. Matching the
 * raw-text elements whole keeps a `<script` or `</head>` inside a script's string literal, a style
 * or a comment from being taken for a tag; an attribute value may hold `>`.
 */
const SHELL_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes)(?=[\s>\/])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?(?:<\/\1\s*>|$))|<(meta)(?=[\s>\/])((?:"[^"]*"|'[^']*'|[^'">])*)>|<\/head\s*>/gi;

/** One attribute of a start tag, as written. */
interface RawAttribute {
  /** Its name, lowercased. */
  name: string;
  /** Its text from the name to the end of the value (quotes included). */
  raw: string;
  /** Its value as written, without quotes (`undefined`: no value). */
  value?: string;
}

/** Whether `c` is HTML whitespace. */
function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
}

/** Where an attribute's value ends in `src` (it starts at `at`), and the value. */
function readValue(src: string, at: number): { end: number; value: string } {
  const quote = src[at];
  if (quote === '"' || quote === "'") {
    const close = src.indexOf(quote, at + 1);
    const end = close === -1 ? src.length : close + 1;
    return { end, value: src.slice(at + 1, close === -1 ? end : close) };
  }
  let end = at;
  while (end < src.length && !isSpace(src[end])) end++;
  return { end, value: src.slice(at, end) };
}

/** The first index from `i` on that is not whitespace. */
function skipSpace(src: string, i: number): number {
  while (i < src.length && isSpace(src[i])) i++;
  return i;
}

/** The attribute starting at `start` (its name's first character) and where it ends. */
function readAttribute(src: string, start: number): { attribute: RawAttribute; end: number } {
  let i = start + 1; // a name may start with `=`
  while (i < src.length && !isSpace(src[i]) && src[i] !== "/" && src[i] !== "=") i++;
  const name = src.slice(start, i).toLowerCase();
  const eq = skipSpace(src, i);
  if (src[eq] !== "=") return { attribute: { name, raw: src.slice(start, i) }, end: i };
  const { end, value } = readValue(src, skipSpace(src, eq + 1));
  return { attribute: { name, raw: src.slice(start, end), value }, end };
}

/**
 * A start tag's attributes as the HTML tokenizer reads them (the text between the tag name and
 * `>`), and whether the tag closes itself (`/` right before `>`).
 */
function parseAttributes(src: string): { attributes: RawAttribute[]; selfClosing: boolean } {
  const attributes: RawAttribute[] = [];
  let selfClosing = false;
  let i = 0;
  while (i < src.length) {
    if (isSpace(src[i])) {
      i++;
    } else if (src[i] === "/") {
      selfClosing = ++i === src.length;
    } else {
      const { attribute, end } = readAttribute(src, i);
      attributes.push(attribute);
      i = end;
    }
  }
  return { attributes, selfClosing };
}

/**
 * A start tag rewritten as the runtime's `HTMLRewriter` (lol_html) writes one it changed: each
 * attribute as written, one space apart, then the added ones, then ` /` for a self-closing tag.
 */
function startTag(
  name: string,
  attributes: readonly RawAttribute[],
  selfClosing: boolean,
  added = "",
): string {
  return `<${name}${attributes.map((a) => " " + a.raw).join("")}${added}${
    selfClosing ? " /" : ""
  }>`;
}

/** An attribute as `HTMLRewriter`'s `setAttribute` writes it: double quotes, `"` escaped. */
function quotedAttribute(name: string, value: string): string {
  return `${name}="${value.replace(/"/g, "&quot;")}"`;
}

/** The policy with `source` first in its `script-src` (unchanged without one). */
function withScriptSource(policy: string, source: string): string {
  return policy.replace(/(^|;\s*)script-src\b/, `$1script-src ${source}`);
}

/** A `<script>` start tag's attributes with `nonce="…"` added, unless it names one. */
function stampScript(name: string, attributes: string, rest: string, nonce: string): string {
  const parsed = parseAttributes(attributes);
  if (parsed.attributes.some((a) => a.name === "nonce")) return `<${name}${attributes}>${rest}`;
  return startTag(name, parsed.attributes, parsed.selfClosing, ` nonce="${nonce}"`) + rest;
}

/** A `<meta>` start tag; a `Content-Security-Policy` one gets `source` in its `script-src`. */
function stampMeta(token: string, name: string, attributes: string, source: string): string {
  const parsed = parseAttributes(attributes);
  const find = (n: string) => parsed.attributes.find((a) => a.name === n);
  if (find("http-equiv")?.value !== "Content-Security-Policy") return token;
  const content = find("content");
  if (content?.value === undefined) return token;
  const policy = withScriptSource(content.value, source);
  if (policy === content.value) return token;
  const rewritten = parsed.attributes.map((a) =>
    a === content ? { ...a, raw: quotedAttribute(a.raw.slice(0, a.name.length), policy) } : a
  );
  return startTag(name, rewritten, parsed.selfClosing);
}

/** The Partytown boot tag for this response. */
function bootTag(lib: string, nonce: string): string {
  return `<script src="${escapeHtml(lib)}boot.js" nonce="${nonce}"></script>`;
}

/**
 * The shell as one response serves it: the Partytown boot tag at the end of `<head>`, `nonce` on
 * every script of the shell (the module entry, the dev reload script, the `spa.shell` inline
 * scripts), and `'nonce-…'` in the `spa.csp` policy's `script-src`, so the boot's check that the
 * page's policy lists its nonce passes. Without `spa.csp` there is no policy to list it in, and
 * the boot accepts the nonce as is.
 *
 * This is the string path (the default); {@linkcode stampWorkerNonceBody} streams the same bytes
 * through the runtime's `HTMLRewriter` when `DENEXT_HTML_REWRITER=1` opts in. A tag it changes is written as `HTMLRewriter` writes
 * it (the attributes as written, one space apart, the added `nonce` last).
 *
 * @param shell The built (or dev) HTML shell.
 * @param lib The public path Partytown is served under (ends with `/`).
 * @param nonce This response's nonce ({@linkcode newScriptNonce}).
 * @returns The shell for this response.
 */
export function stampWorkerNonce(shell: string, lib: string, nonce: string): string {
  const source = `'nonce-${nonce}'`;
  const boot = bootTag(lib, nonce);
  let booted = false;
  const stamped = shell.replace(
    SHELL_TOKEN,
    (
      token: string,
      name: string | undefined,
      attributes: string,
      rest: string,
      meta: string | undefined,
      metaAttributes: string,
    ) => {
      if (meta !== undefined) return stampMeta(token, meta, metaAttributes, source);
      if (name === undefined) {
        if (booted || !/^<\/head/i.test(token)) return token; // a comment, or a later `</head>`
        booted = true;
        return `${boot}\n  ${token}`;
      }
      if (name.toLowerCase() !== "script") return token;
      return stampScript(name, attributes, rest, nonce);
    },
  );
  return booted ? stamped : boot + stamped;
}

/**
 * Whether the streaming path writes the same bytes as the string one for this shell: one
 * `<head>` that ends with `</head>` (`HTMLRewriter` adds the boot at the end of each head
 * element, and has nowhere to put it in a shell without one).
 */
function streamable(shell: string): boolean {
  return shell.match(/<head(?=[\s>\/])/gi)?.length === 1 &&
    shell.match(/<\/head\s*>/gi)?.length === 1;
}

/**
 * {@linkcode stampWorkerNonce} as a response body: the string path's string by default; streamed
 * through the runtime's `HTMLRewriter` only with `DENEXT_HTML_REWRITER=1` and a runtime that has
 * one (slower on today's runtimes: see src/server/html-rewriter.ts). Both are the same bytes.
 *
 * @param shell The built (or dev) HTML shell.
 * @param lib The public path Partytown is served under (ends with `/`).
 * @param nonce This response's nonce ({@linkcode newScriptNonce}).
 * @returns The body for this response.
 */
export function stampWorkerNonceBody(
  shell: string,
  lib: string,
  nonce: string,
): string | ReadableStream<Uint8Array> {
  // The opt-in first: the default path never runs the shell check's two regexes.
  const rewriter = newHtmlRewriter();
  if (!rewriter || !streamable(shell)) return stampWorkerNonce(shell, lib, nonce);
  const source = `'nonce-${nonce}'`;
  const boot = bootTag(lib, nonce);
  const stamped = rewriter
    .on('meta[http-equiv="Content-Security-Policy"]', {
      element(el) {
        const policy = el.getAttribute("content");
        if (policy === null) return;
        const next = withScriptSource(policy, source);
        if (next !== policy) el.setAttribute("content", next);
      },
    })
    .on("script", {
      element(el) {
        if (!el.hasAttribute("nonce")) el.setAttribute("nonce", nonce);
      },
    })
    .on("head", {
      element(el) {
        el.onEndTag((tag) => tag.before(`${boot}\n  `, { html: true }));
      },
    })
    .transform(new Response(shell));
  return stamped.body!;
}
