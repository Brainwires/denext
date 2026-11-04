// Render-time style sheets (../runtime/server-style-sheets.ts) for the Suspense boundaries that
// stream after the shell.
//
// React Native mode's react-native-web collects its atomic CSS while rendering, into one sheet
// per process that the page renderer writes into the `<head>` once the shell has rendered. A
// boundary that streams later can add rules — a module first loaded inside it runs its
// `StyleSheet.create` then — and its content would show unstyled until the client renders the
// boundary again, or never, for a Server Component the client never runs.
//
// So a streamed response is passed through {@linkcode streamLateStyleSheets}: before each
// chunk that carries a boundary's `<template data-dnx-r>`, it writes the rules the registered
// sheets gained since the head (or the previous chunk) was sent — each rule once per response
// — as an inert JSON block, then one inline script, a framework constant
// ({@linkcode LATE_STYLES_RUNTIME_BODY}), that inserts them into the head's `<style id>` sheet
// through the CSSOM (`insertRule`). The browser runs that script as it parses it, before it
// parses the template the swap runtime moves into place, so the content never paints without its
// styles. react-native-web's ordered groups are kept: a rule goes into its group (the
// `[stylesheet-group="N"]{}` marker rules react-native-web writes), which the runtime adds when
// the sheet lacks it, so react-native-web's client adopts the sheet as if it had made it.
//
// Under the CSP: denext's policy is hash-based (./csp.ts), and the streaming policy is sent with
// the shell. The runtime is a constant, so its `'sha256-…'` is in that policy whenever a sheet
// is registered (`lateStylesRuntimeHash` there); the JSON block is not executed and the
// CSSOM is not governed by `style-src`, so no streamed `<style>` element needs a hash the
// shell's policy could not list. An app with no registered sheet streams unchanged.

import { hasServerStyleSheets, readServerStyleSheets } from "../runtime/server-style-sheets.ts";

/**
 * The inline runtime that applies each streamed rules block (the text a CSP `'sha256-…'` is
 * computed over). It reads every `script[data-dnx-rules]` not applied yet — `{ "<sheet id>":
 * [[group | null, cssText], …] }` — and inserts each rule into the sheet of the `<style>` with
 * that id: with a group, before the next group's marker (adding the group's marker when the sheet
 * has none); without, at the end. A rule the browser rejects is skipped. A sheet with no element
 * in the page is left alone. Self-contained and constant, so its hash is fixed.
 */
export const LATE_STYLES_RUNTIME_BODY =
  `(function(){function a(s,t,p){try{s.insertRule(t,p);return 1}catch(e){return 0}}var l=document.querySelectorAll('script[data-dnx-rules]');for(var i=0;i<l.length;i++){var c=l[i],d;c.removeAttribute('data-dnx-rules');try{d=JSON.parse(c.textContent)}catch(e){continue}for(var k in d){var el=document.getElementById(k),s=el&&el.sheet;if(!s)continue;var r=d[k];for(var j=0;j<r.length;j++){var g=r[j][0],t=r[j][1];if(g===null){a(s,t,s.cssRules.length);continue}var n=s.cssRules.length,p=n,f=0;for(var q=0;q<n;q++){var m=/stylesheet-group="([^"]*)"/.exec(s.cssRules[q].cssText);if(m){var v=+m[1];if(v===g)f=1;else if(v>g){p=q;break}}}if(!f)p+=a(s,'[stylesheet-group="'+g+'"]{}',p);a(s,t,p)}}if(c.parentNode)c.parentNode.removeChild(c)}})();`;

/** The `<script>` wrapping {@link LATE_STYLES_RUNTIME_BODY}. */
const LATE_STYLES_RUNTIME = `<script>${LATE_STYLES_RUNTIME_BODY}</script>`;

/** react-native-web's group marker rule (`[stylesheet-group="2.2"]{}`): the group number. */
const GROUP_MARKER = /^\[stylesheet-group="([^"]*)"\]\{\}$/;

/** One streamed rule: its react-native-web group (null: none) and its text. */
type LateRule = [group: number | null, cssText: string];

/** The rules (one per line, as react-native-web writes its sheet) of `css`. */
function lines(css: string): string[] {
  return css.split("\n").filter((line) => line.trim() !== "");
}

/**
 * The rules of each registered sheet already in `shellPrefix` (its `<style id>` element, as the
 * head carried it).
 */
function sentRules(shellPrefix: string): Map<string, Set<string>> {
  const sent = new Map<string, Set<string>>();
  for (const { id } of readServerStyleSheets()) {
    const set = new Set<string>();
    const open = `<style id="${
      id.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
    }">`;
    const at = shellPrefix.indexOf(open);
    if (at >= 0) {
      const start = at + open.length;
      const end = shellPrefix.indexOf("</style>", start);
      const css = shellPrefix.slice(start, end < 0 ? undefined : end).replace(
        /<\\\/(style)/gi,
        "</$1",
      );
      for (const line of lines(css)) set.add(line);
    }
    sent.set(id, set);
  }
  return sent;
}

/**
 * The rules the registered sheets hold that `sent` lacks (recorded into `sent`), by sheet id; null
 * when there are none.
 */
function takeLateRules(sent: Map<string, Set<string>>): Record<string, LateRule[]> | null {
  let out: Record<string, LateRule[]> | null = null;
  for (const { id, textContent } of readServerStyleSheets()) {
    let seen = sent.get(id);
    if (!seen) sent.set(id, seen = new Set());
    let group: number | null = null;
    for (const line of lines(textContent)) {
      const marker = GROUP_MARKER.exec(line);
      if (marker) {
        group = Number(marker[1]);
        continue;
      }
      if (seen.has(line)) continue;
      seen.add(line);
      ((out ??= {})[id] ??= []).push([group, line]);
    }
  }
  return out;
}

/** A rules block plus the runtime that applies it (`<` escaped so the JSON can't close it). */
function lateRulesMarkup(rules: Record<string, LateRule[]>): string {
  const json = JSON.stringify(rules).replace(/</g, "\\u003c");
  return `<script type="application/json" data-dnx-rules>${json}</script>${LATE_STYLES_RUNTIME}`;
}

/** Where a streamed boundary's content starts in a chunk. */
const HOLE = "<template data-dnx-r=";

/**
 * `stream` (a streamed document whose head and shell are `shellPrefix`) with the rules the
 * registered style sheets gain while its boundaries render written ahead of the boundaries that
 * stream after them (see the module comment). Returns `stream` itself when no sheet is
 * registered.
 *
 * @param stream The streamed document.
 * @param shellPrefix The head + shell it flushes first (what the head's sheets already hold).
 */
export function streamLateStyleSheets(
  stream: ReadableStream<Uint8Array>,
  shellPrefix: string,
): ReadableStream<Uint8Array> {
  if (!hasServerStyleSheets()) return stream;
  const sent = sentRules(shellPrefix);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let text = decoder.decode(chunk, { stream: true });
        const at = text.indexOf(HOLE);
        if (at >= 0) {
          // Read now: every boundary in this chunk has rendered, so its rules are in the sheet.
          const rules = takeLateRules(sent);
          if (rules) text = text.slice(0, at) + lateRulesMarkup(rules) + text.slice(at);
        }
        if (text) controller.enqueue(encoder.encode(text));
      },
      flush(controller) {
        const rest = decoder.decode();
        if (rest) controller.enqueue(encoder.encode(rest));
      },
    }),
  );
}
