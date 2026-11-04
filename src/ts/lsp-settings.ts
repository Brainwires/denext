// The editor's TypeScript backend. denext's Deno toolchain ships `deno lsp` with two TypeScript
// language services: a TypeScript 7 ("tsgo") backend that runs the pinned native language server
// from `typescript-lsp/` beside `deno`, and the in-process TypeScript 6 service. From runtime
// 3.0.0-rc.3 on (the pinned build included) TypeScript 7 is the runtime's own default: `deno lsp`
// runs it with no setting at all. `DENO_UNSTABLE_TSGO_LSP=0` in the language server's environment
// keeps TypeScript 6.
//
// So denext writes no backend setting any more: `denext create` / `init` and `denext migrate` turn
// the Deno language server on and nothing else. Earlier denext versions wrote
// `"deno.unstable": ["tsgo-lsp"]` into `.vscode/settings.json`, which only the runtimes before
// rc.3 needed; `denext upgrade` takes that exact entry back out. Any other `deno.unstable` list (one
// that names other features, or `"tsgo-lsp"` beside them) is the project's own and is never
// touched.

import { parse as parseJsonc } from "@std/jsonc";

/** The `deno.unstable` feature that selected `deno lsp`'s TypeScript 7 backend before rc.3. */
const TSGO_LSP_FEATURE = "tsgo-lsp";
/** The editor setting `deno lsp` reads unstable features from. */
const DENO_UNSTABLE_SETTING = "deno.unstable";

/**
 * Whether a parsed `.vscode/settings.json` carries the entry earlier denext versions wrote:
 * `deno.unstable` is exactly `["tsgo-lsp"]`.
 *
 * @param settings The parsed settings object.
 * @returns Whether the legacy entry is there.
 */
export function hasLegacyTsgoLspSetting(settings: Record<string, unknown>): boolean {
  const value = settings[DENO_UNSTABLE_SETTING];
  return Array.isArray(value) && value.length === 1 && value[0] === TSGO_LSP_FEATURE;
}

/** The JSONC object in `text`, or `null` when it is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

/** `"deno.unstable": ["tsgo-lsp"]` as a member, with the whitespace before it on its line. */
const LEGACY_MEMBER = /(\r?\n)?[ \t]*"deno\.unstable"\s*:\s*\[\s*"tsgo-lsp"\s*\]/g;

/**
 * Remove `"deno.unstable": ["tsgo-lsp"]` (what earlier denext versions wrote) from a
 * `.vscode/settings.json` text, as a splice: the rest of the file (comments, formatting, key
 * order) keeps its bytes. `null` when there is nothing to do: no such entry, a `deno.unstable` that
 * names anything else, text that is not a JSONC object, or a file whose shape the splice can't
 * account for (the result must parse to the same settings without the key, else the file is left
 * alone).
 *
 * @param text The file's text.
 * @returns The new text, or `null` to leave the file alone.
 */
export function removeLegacyTsgoLspSetting(text: string): string | null {
  const settings = parseObject(text);
  if (!settings || !hasLegacyTsgoLspSetting(settings)) return null;
  const matches = [...text.matchAll(LEGACY_MEMBER)];
  if (matches.length !== 1) return null; // a duplicate key, or the text inside a comment
  const [match] = matches;
  const start = match.index;
  let end = start + match[0].length;
  let head = text.slice(0, start);
  const comma = /^\s*,/.exec(text.slice(end));
  if (comma) end += comma[0].length; // a member after it: its comma goes with it
  else head = head.replace(/,(\s*)$/, "$1"); // the last member: the comma before it
  const next = head + text.slice(end);
  const after = parseObject(next);
  const expected = { ...settings };
  delete expected[DENO_UNSTABLE_SETTING];
  return after && JSON.stringify(after) === JSON.stringify(expected) ? next : null;
}
