// The UI's single client module, exported as a string and served from the same origin at
// `/_ui/ui.js` — the `DEV_RELOAD_SCRIPT` idiom, so the strict `script-src 'self'` CSP holds
// with no inline script and no bundler.
//
// It is *progressive enhancement only*: every panel is a real `<form method="post">` that works
// with JavaScript disabled. This module upgrades those submits to `fetch(..., { headers: {
// Accept: "text/html-fragment" } })` and swaps the returned `<section id="panel">` in place, so
// the server keeps exactly one rendering path. Untrusted text is never assigned to `innerHTML`:
// the fragment the server rendered is parsed with `DOMParser` and adopted as nodes.

import { UI_CRON_PREVIEW_PATH, UI_EVENTS_PATH, UI_TITLE_HEADER } from "./html.ts";
import { UI_CSRF_FIELD, UI_CSRF_HEADER } from "./security.ts";

/** The client module served at `/_ui/ui.js`. */
export const UI_JS = `// denext ui — progressive enhancement (served same-origin; no inline script).
const CSRF_HEADER = ${JSON.stringify(UI_CSRF_HEADER)};
const CSRF_FIELD = ${JSON.stringify(UI_CSRF_FIELD)};
const EVENTS = ${JSON.stringify(UI_EVENTS_PATH)};
const TITLE_HEADER = ${JSON.stringify(UI_TITLE_HEADER)};
const CRON_PREVIEW = ${JSON.stringify(UI_CRON_PREVIEW_PATH)};
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
  trackAll();
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

/**
 * Dirty tracking for a form that asked for it (\`data-dirty-track\`): Save is inert until
 * something actually changes, and a Discard button appears beside it to put the form back.
 * With JavaScript off none of this runs and Save simply works, which is why the server never
 * renders it disabled. A button the server disabled (--read-only) is never touched.
 */
function saveOf(form) {
  return form.querySelector('button[type="submit"]:not([name])');
}

/** Take a pristine snapshot of one form: Save off until an edit. */
function track(form) {
  if (form.dataset.tracking === "1") return;
  const save = saveOf(form);
  if (!save || save.disabled) return;
  form.dataset.tracking = "1";
  save.dataset.pristine = "1";
  save.disabled = true;
}

/** Put a form back the way the server rendered it. */
function discard(form) {
  form.reset();
  delete form.dataset.dirty;
  const save = saveOf(form);
  if (save && save.dataset.pristine === "1") save.disabled = true;
  form.querySelector("[data-discard]")?.remove();
}

/** The first edit in a tracked form: Save wakes up, and Discard appears next to it. */
function markDirty(target) {
  const form = target?.closest?.("form[data-dirty-track]");
  if (!form || form.dataset.tracking !== "1" || form.dataset.dirty === "1") return;
  form.dataset.dirty = "1";
  const save = saveOf(form);
  if (save && save.dataset.pristine === "1") save.disabled = false;
  if (!save || form.querySelector("[data-discard]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.setAttribute("data-discard", "1");
  button.title = "Put this section back the way it was";
  button.textContent = "Discard";
  save.after(document.createTextNode(" "), button);
}

/** Snapshot every tracked form on the page (again after each panel swap). */
function trackAll() {
  for (const form of document.querySelectorAll("form[data-dirty-track]")) track(form);
}

/** The newest preview asked for, so a slow answer can never land on top of a newer one. */
let previewSeq = 0;
let previewTimer = null;

/**
 * Ask the server what the expression in \`field\` means, and put its answer beside the field.
 * The reading is the server's: this module never parses a cron expression, so the live preview
 * and the saved page cannot disagree.
 */
function previewCron(field) {
  const row = field.closest(".field");
  const block = row && row.querySelector("[data-cron-preview]");
  if (!block) return;
  const seq = ++previewSeq;
  fetch(CRON_PREVIEW + "?expr=" + encodeURIComponent(field.value), {
    headers: { accept: "text/html-fragment" },
  })
    .then((response) => (response.ok ? response.text() : null))
    .then((markup) => {
      if (markup === null || seq !== previewSeq) return;
      const next = new DOMParser().parseFromString(markup, "text/html")
        .querySelector("[data-cron-preview]");
      const current = row.querySelector("[data-cron-preview]");
      if (next && current) current.replaceWith(document.adoptNode(next));
    })
    .catch(() => {/* the block the server already rendered stays as it is */});
}

document.addEventListener("input", (event) => {
  const field = event.target;
  if (!field || field.name !== "cron") return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => previewCron(field), 250);
});

document.addEventListener("input", (event) => markDirty(event.target));
document.addEventListener("change", (event) => markDirty(event.target));
document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-discard]");
  const form = button?.closest("form");
  if (!form) return;
  event.preventDefault();
  discard(form);
});

/** Submit one enhanced form; the submitter carries a list row's op field, so it is included. */
async function submit(form, submitter) {
  const body = new FormData(form, submitter instanceof HTMLElement ? submitter : undefined);
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

/**
 * Whether this click is one the enhancement may take over. Anything a browser would do
 * specially — a new tab, a download, a cross-origin address, a modified click — is left alone,
 * so the link keeps behaving like a link.
 */
function enhanceable(link, event) {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (!link || !link.getAttribute("href")) return false;
  if (link.target || link.hasAttribute("download")) return false;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return false;
  // A jump within this same page is the browser's job, not ours.
  if (url.pathname === location.pathname && url.search === location.search && url.hash) {
    return false;
  }
  return true;
}

/** Move aria-current to the sidebar link for whatever path is on screen now. */
function markCurrent() {
  for (const link of document.querySelectorAll(".sidebar nav a")) {
    if (new URL(link.href).pathname === location.pathname) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

/**
 * Put a same-origin panel on screen without a navigation. Anything unexpected — a failed
 * request, a response that is not a panel — hands the address back to the browser, so the
 * enhancement can never strand someone on a page that will not move.
 */
async function show(href, push) {
  let response;
  try {
    response = await fetch(href, { headers: { accept: "text/html-fragment" } });
  } catch {
    location.href = href;
    return;
  }
  const type = response.headers.get("content-type") || "";
  if (!response.ok || type.indexOf("text/html") === -1) {
    location.href = href;
    return;
  }
  const title = response.headers.get(TITLE_HEADER);
  swapPanel(await response.text());
  if (push) history.pushState(null, "", href);
  markCurrent();
  if (title) document.title = decodeURIComponent(title);
  if (push) globalThis.scrollTo(0, 0);
}

document.addEventListener("click", (event) => {
  const link = event.target?.closest?.("a[href]");
  if (!enhanceable(link, event)) return;
  event.preventDefault();
  show(link.href, true).catch((error) => console.error("denext ui:", error));
});

// Back and forward: the browser has already changed the address, so only the panel is behind.
globalThis.addEventListener("popstate", () => {
  show(location.href, false).catch((error) => console.error("denext ui:", error));
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if ((form.method || "get").toLowerCase() !== "post") return;
  event.preventDefault();
  submit(form, event.submitter).catch((error) => console.error("denext ui:", error));
});

// Server-pushed events: progress broadcast to every open page, the wizard's dev-server run,
// and the --ui-dev reload. Each frame is one JSON object with a "type"; anything unknown is
// ignored, so a newer server never breaks an older page.

/** Re-fetch the panel this page is showing, so a change made elsewhere lands here too. */
async function refresh() {
  const response = await fetch(location.pathname + location.search, {
    headers: { accept: "text/html-fragment" },
  });
  if (response.ok) swapPanel(await response.text());
}

/** Append one line to the panel's output block, if it is showing one. */
function appendOut(line) {
  const sink = document.querySelector("#panel pre.out");
  if (!sink) return;
  sink.append(document.createTextNode(line + "\\n"));
  sink.scrollTop = sink.scrollHeight;
}

/** The dev server came up: put its address in the panel, once. */
function devReady(url) {
  const panel = document.querySelector("#panel");
  if (!panel || panel.querySelector("[data-dev-url]")) return;
  const note = document.createElement("p");
  note.className = "note";
  note.setAttribute("data-dev-url", url);
  note.append(document.createTextNode("Dev server running at "));
  const link = document.createElement("a");
  link.href = url;
  link.textContent = url;
  note.append(link);
  panel.prepend(note);
}

const FRAMES = {
  reload: () => location.reload(),
  "plugins-changed": () => refresh(),
  "command-done": () => refresh(),
  "task-done": () => refresh(),
  "dev-output": (payload) => appendOut(payload.line ?? ""),
  "dev-exit": (payload) => {
    appendOut("\u2014 exited " + payload.code);
    refresh();
  },
  "dev-ready": (payload) => devReady(payload.url ?? ""),
  "dev-stopped": () => refresh(),
};

trackAll();

const events = new EventSource(EVENTS);
events.addEventListener("message", (event) => {
  let payload = null;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!payload || !Object.hasOwn(FRAMES, payload.type)) return;
  Promise.resolve(FRAMES[payload.type](payload))
    .catch((error) => console.error("denext ui:", error));
});
`;
