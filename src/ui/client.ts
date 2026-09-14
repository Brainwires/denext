// The UI's single client module, exported as a string and served from the same origin at
// `/_ui/ui.js` — the `DEV_RELOAD_SCRIPT` idiom, so the strict `script-src 'self'` CSP holds
// with no inline script and no bundler.
//
// It is *progressive enhancement only*: every panel is a real `<form method="post">` that works
// with JavaScript disabled. This module upgrades those submits to `fetch(..., { headers: {
// Accept: "text/html-fragment" } })` and swaps the returned `<section id="panel">` in place, so
// the server keeps exactly one rendering path. Untrusted text is never assigned to `innerHTML`:
// the fragment the server rendered is parsed with `DOMParser` and adopted as nodes.

import { UI_EVENTS_PATH } from "./html.ts";
import { UI_CSRF_FIELD, UI_CSRF_HEADER } from "./security.ts";

/** The client module served at `/_ui/ui.js`. */
export const UI_JS = `// denext ui — progressive enhancement (served same-origin; no inline script).
const CSRF_HEADER = ${JSON.stringify(UI_CSRF_HEADER)};
const CSRF_FIELD = ${JSON.stringify(UI_CSRF_FIELD)};
const EVENTS = ${JSON.stringify(UI_EVENTS_PATH)};
const csrf = document.querySelector('meta[name="denext-csrf"]')?.content ?? "";

/** Replace the current panel with a server-rendered fragment (parsed, never innerHTML'd). */
function swapPanel(markup) {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const next = parsed.querySelector("#panel");
  const current = document.querySelector("#panel");
  if (!next || !current) {
    location.reload();
    return;
  }
  current.replaceWith(document.adoptNode(next));
}

/** Stream a task's output into the panel's <pre class="out"> as it arrives. */
async function streamInto(response, sink) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\\n\\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\\n")) {
        if (!line.startsWith("data: ")) continue;
        sink.append(document.createTextNode(line.slice(6) + "\\n"));
        sink.scrollTop = sink.scrollHeight;
      }
    }
  }
}

/** Submit one enhanced form; returns false when the browser should submit it itself. */
async function submit(form) {
  const body = new FormData(form);
  body.set(CSRF_FIELD, csrf);
  const response = await fetch(form.action, {
    method: "POST",
    body,
    headers: { accept: "text/html-fragment", [CSRF_HEADER]: csrf },
  });
  const type = response.headers.get("content-type") ?? "";
  const sink = form.closest("#panel")?.querySelector("pre.out");
  if (type.includes("text/event-stream") && sink) {
    sink.replaceChildren();
    await streamInto(response, sink);
    return;
  }
  if (type.includes("text/html")) {
    swapPanel(await response.text());
    return;
  }
  const payload = await response.json().catch(() => null);
  if (payload && payload.ok === false) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "denext ui: " + (payload.reason ?? "request refused");
    form.closest("#panel")?.prepend(note);
  }
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if ((form.method || "get").toLowerCase() !== "post") return;
  event.preventDefault();
  submit(form).catch((error) => console.error("denext ui:", error));
});

// Server-pushed events: task progress broadcast to every open page, and the --ui-dev reload.
const events = new EventSource(EVENTS);
events.addEventListener("message", (event) => {
  let payload = null;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }
  if (payload && payload.type === "reload") location.reload();
});
`;
