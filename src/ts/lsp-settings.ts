// The editor's TypeScript backend. denext's Deno toolchain ships `deno lsp` with two TypeScript
// language services: the in-process TypeScript 6 service (Deno's default) and a TypeScript 7
// ("tsgo") backend that runs the pinned native language server from `typescript-lsp/` beside
// `deno`. `deno lsp` picks the backend once, at `initialize`, from the editor's settings:
// `"deno.unstable": ["tsgo-lsp"]` selects tsgo (`DENO_UNSTABLE_TSGO_LSP=0` / `=1` in the language
// server's environment overrides the setting either way).
//
// denext makes tsgo the default wherever it sets up an editor: `denext create` / `init` and
// `denext migrate` write the entry into `.vscode/settings.json`, and `denext upgrade` adds it to an
// existing project's settings. Only when the settings have no `deno.unstable` key at all: a project
// that set one (to anything, `[]` included) keeps its own choice. `DENEXT_TSGO_LSP=0` (or `false` /
// `off` / `no`) makes those commands leave the setting out — the opt-out that keeps TypeScript 6,
// mirroring `DENEXT_NATIVE_CHECK=0` for type checking.

import { parse as parseJsonc } from "@std/jsonc";

/** The `deno.unstable` editor-setting entry that selects `deno lsp`'s TypeScript 7 backend. */
export const TSGO_LSP_FEATURE = "tsgo-lsp";
/** The editor setting `deno lsp` reads the backend from. */
export const DENO_UNSTABLE_SETTING = "deno.unstable";
/** denext's opt-out: `0` / `false` / `off` / `no` writes no tsgo setting (TypeScript 6 stays). */
const TSGO_LSP_ENV = "DENEXT_TSGO_LSP";

/** Env reader. */
type EnvGet = (name: string) => string | undefined;
const processEnv: EnvGet = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined; // no env permission
  }
};

/**
 * Whether denext writes the tsgo setting when it sets up an editor: yes, unless
 * `DENEXT_TSGO_LSP` is `0` / `false` / `off` / `no`.
 *
 * @param env Env reader (default: the process environment).
 * @returns Whether the TypeScript 7 language server is denext's default.
 */
export function tsgoLspByDefault(env: EnvGet = processEnv): boolean {
  const value = env(TSGO_LSP_ENV)?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * Whether a parsed `.vscode/settings.json` should get the tsgo setting: it has no
 * `deno.unstable` key (any value there is the user's own choice, an empty list included).
 *
 * @param settings The parsed settings object.
 * @returns Whether the setting is missing.
 */
export function needsTsgoLspSetting(settings: Record<string, unknown>): boolean {
  return !Object.hasOwn(settings, DENO_UNSTABLE_SETTING);
}

/** Skip whitespace and JSONC comments from `i`; the index of the next significant character. */
function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    if (/\s/.test(text[i])) i++;
    else if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else break;
  }
  return i;
}

/**
 * Add `"deno.unstable": ["tsgo-lsp"]` to a `.vscode/settings.json` text that lacks a
 * `deno.unstable` key, as a splice right after the opening `{`: the rest of the file (comments,
 * formatting, key order) keeps its bytes. `null` when there is nothing to do: the key is present,
 * or the text is not a JSONC object (never rewritten).
 *
 * @param text The file's text.
 * @returns The new text, or `null` to leave the file alone.
 */
export function addTsgoLspSetting(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (!needsTsgoLspSetting(parsed as Record<string, unknown>)) return null;
  const open = skipTrivia(text, 0);
  if (text[open] !== "{") return null;
  const entry = `"${DENO_UNSTABLE_SETTING}": ${JSON.stringify([TSGO_LSP_FEATURE])}`;
  // An empty object takes the entry alone; otherwise a comma separates it from the first member.
  const comma = Object.keys(parsed).length === 0 ? "" : ",";
  return `${text.slice(0, open + 1)}\n  ${entry}${comma}${text.slice(open + 1)}`;
}
