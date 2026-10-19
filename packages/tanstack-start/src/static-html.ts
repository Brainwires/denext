// A prerendered page as a static file: its streamed Suspense boundaries resolved in place.
//
// denext's streaming render writes a Suspense boundary that finished in the shell pass inline,
// as React does. One that suspended past it (a deferred loader's `<Await>`) is sent as a
// placeholder (`<div data-dnx-b="id">fallback</div>`) and, once it resolves, its content as a
// `<template data-dnx-r="id">…</template>` that a small script moves into the placeholder. A live
// response needs that; a static file does not, and with JavaScript off the content would never
// show. The export writes each page as the browser's DOM ends up after the script ran: the
// template's content in its placeholder (in place of the fallback), the template gone. The
// placeholder element stays, so the page hydrates against the same DOM as a streamed one (the
// client unwraps it as it hydrates).

/** One tag the scanner tracks: an opening or closing `div` / `template`, or a `script`. */
const TAG = /<(\/?)(div|template|script)\b[^>]*>/gi;

/**
 * The index just past the tag closing the element whose content starts at `from`: the matching
 * `</name>`, counting nested `name` elements and skipping `<script>` bodies.
 */
function closeOf(html: string, name: "div" | "template", from: number): number {
  TAG.lastIndex = from;
  let depth = 1;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const tag = m[2].toLowerCase();
    if (tag === "script") {
      if (m[1]) continue;
      const end = html.toLowerCase().indexOf("</script", TAG.lastIndex);
      if (end < 0) return -1;
      TAG.lastIndex = end;
      continue;
    }
    if (tag !== name) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return TAG.lastIndex;
  }
  return -1;
}

/** A resolved boundary: its template's span and content. */
interface Resolved {
  start: number;
  end: number;
  content: string;
}

/** The first `<template data-dnx-r>` whose placeholder is in `html`, if any. */
function nextResolved(html: string, after: number): Resolved & { id: string } | null {
  const opener = /<template data-dnx-r="([^"]+)"[^>]*>/g;
  opener.lastIndex = after;
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const contentStart = opener.lastIndex;
    const end = closeOf(html, "template", contentStart);
    if (end < 0) return null;
    const content = html.slice(contentStart, end - "</template>".length);
    return { id: m[1], start: m.index, end, content };
  }
  return null;
}

/**
 * The page with each streamed Suspense boundary's content moved into its placeholder, as denext's
 * swap script does in the browser; a boundary whose placeholder is missing keeps its template.
 *
 * @param html The page as the server streamed it.
 * @returns The page as a static file.
 */
export function inlineStreamedBoundaries(html: string): string {
  let out = html;
  let from = 0;
  // A boundary's content may hold a nested boundary's placeholder, so each splice can enable a
  // later one; templates come in resolution order, after the placeholders they fill.
  for (let next = nextResolved(out, from); next; next = nextResolved(out, from)) {
    const marker = `<div data-dnx-b="${next.id}">`;
    const at = out.indexOf(marker);
    if (at < 0 || at > next.start) {
      from = next.end; // no placeholder before it: leave the template
      continue;
    }
    const inner = at + marker.length;
    const close = closeOf(out, "div", inner);
    if (close < 0) {
      from = next.end;
      continue;
    }
    // Drop the template first (it is after the placeholder), then replace the fallback.
    out = out.slice(0, next.start) + out.slice(next.end);
    out = out.slice(0, inner) + next.content + out.slice(close - "</div>".length);
    from = 0;
  }
  return out;
}
