// The dev server's 500 page: when the app's render fails before anything reached the browser
// (a syntax error in a page, a throwing root layout), show the SAME error the terminal got —
// title, message, stack and codeframe — instead of a bare "Internal Server Error". The dev
// reload script is included so a fix reloads the tab.

import type { DevEvent } from "../dev-events.ts";
import { escapeHtml } from "../../jsx/render-to-string.ts";

/** A styled HTML page for the most recent dev error (null when none was recorded). */
export function devErrorPage(event: DevEvent | undefined, reloadScriptSrc: string): string | null {
  if (!event || event.kind !== "error") return null;
  const e = event as DevEvent & {
    title?: string;
    message?: string;
    stack?: string;
    codeframe?: string;
    frame?: string;
  };
  const section = (label: string, body: string | undefined) =>
    body ? `<h2>${escapeHtml(label)}</h2><pre>${escapeHtml(body)}</pre>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>denext dev — ${
    escapeHtml(e.title ?? "error")
  }</title>
<style>${CSS}</style></head>
<body><main>
<p class="k">denext dev · server error</p>
<h1>${escapeHtml(e.title ?? "Error")}</h1>
<p class="m">${escapeHtml(e.message ?? "")}</p>
${e.frame ? `<p class="f">${escapeHtml(e.frame)}</p>` : ""}
${section("Source", e.codeframe)}
${section("Stack", e.stack)}
<p class="hint">Fix the file and save — this page reloads when the dev server rebuilds.</p>
</main><script src="${escapeHtml(reloadScriptSrc)}"></script></body></html>`;
}

const CSS = `body{margin:0;background:#1a1416;color:#f4ecec;font:15px/1.5 ui-sans-serif,system-ui}
main{max-width:56rem;margin:0 auto;padding:2.5rem 1.5rem}.k{color:#f0a3a3;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:12px}
h1{font-size:1.6rem;margin:.25rem 0 .5rem}.m{font-size:1.05rem;color:#ffd7d7;white-space:pre-wrap}.f{color:#9fc9ff;font-family:ui-monospace,monospace}
h2{font-size:.9rem;color:#c9b6b6;margin:1.5rem 0 .25rem;text-transform:uppercase;letter-spacing:.04em}
pre{background:#0f0c0d;border:1px solid #3a2c2f;border-radius:8px;padding:1rem;overflow:auto;font:13px/1.45 ui-monospace,SFMono-Regular,monospace}
.hint{color:#a89a9a;margin-top:2rem}`;
