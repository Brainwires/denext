// Loopy's browser: the user's own Google Chrome (or Chromium), started visible on first use with a
// fresh profile in Loopy's data folder, and driven over the DevTools protocol with
// `@astral/astral`. It is closed when Loopy quits (desktop.ts), when the browser feature is
// switched off, and with the process (a synchronous kill on `unload`).
//
// Guards that live in the browser itself:
// - downloads are denied (`Browser.setDownloadBehavior`), and file choosers are intercepted and
//   never answered, so nothing is downloaded or uploaded;
// - top-level documents pass through the post gate (voice/post-gate.ts): a navigation that posts,
//   started while Loopy acts, is held until the user answers;
// - pop-ups and new windows are blocked (`--block-new-web-contents`), links open in the same tab;
// - JavaScript dialogs are dismissed.
//
// Nothing here runs in the unit tests (they drive the tools with a fake browser); the pure parts
// (finding Chrome, its arguments, the DevTools address, the page script's output) are tested.

import { connect } from "@astral/astral";
import type { Browser, Page } from "@astral/astral";
import type { PageElement, PageSnapshot } from "./browser-safety.ts";
import { MAX_ELEMENTS } from "./browser-safety.ts";
import { type BrowserDriver, BrowserError, type HeldPost } from "./browser-tools.ts";
import { createPostGate, type PausedRequest } from "./post-gate.ts";

/** The OS names Deno reports. */
type Os = "darwin" | "windows" | "linux";

/** Where Chrome or Chromium is installed, per OS (these paths are the app's `run` permission). */
export const CHROME_PATHS: Readonly<Record<Os, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  windows: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/** Whether `path` is a file (no permission, no file: false). */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** The first installed Chrome for `os`, or `null`. */
export function findChrome(
  os: Os = Deno.build.os as Os,
  exists: (path: string) => boolean = isFile,
): string | null {
  return (CHROME_PATHS[os] ?? []).find(exists) ?? null;
}

/** Chrome's command line: visible, its own profile, no first-run prompts, no pop-ups. */
export function chromeArgs(profileDir: string): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-background-networking",
    "--password-store=basic",
    "--use-mock-keychain",
    "--block-new-web-contents",
    "--window-size=1100,820",
    "about:blank",
  ];
}

/** The DevTools WebSocket address in Chrome's stderr, or `null` until it is there. */
export function devtoolsEndpoint(stderr: string): string | null {
  return stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1] ?? null;
}

/** A string field of `raw`, else "". */
const str = (raw: Record<string, unknown>, key: string) =>
  typeof raw[key] === "string" ? raw[key] as string : "";

/** An element from the page script's output, every field checked. */
export function toPageElement(raw: unknown): PageElement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ref !== "number" || typeof r.tag !== "string") return null;
  return {
    ref: r.ref,
    tag: r.tag.toLowerCase(),
    type: str(r, "type").toLowerCase(),
    role: str(r, "role").toLowerCase(),
    text: str(r, "text"),
    name: str(r, "name"),
    id: str(r, "id"),
    autocomplete: str(r, "autocomplete"),
    placeholder: str(r, "placeholder"),
    label: str(r, "label"),
    href: str(r, "href"),
    inForm: r.inForm === true,
    formMethod: str(r, "formMethod").toLowerCase(),
    editable: r.editable === true,
  };
}

/** A page snapshot from the page script's output. */
export function toSnapshot(raw: unknown): PageSnapshot {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const elements = Array.isArray(r.elements) ? r.elements : [];
  return {
    url: str(r, "url"),
    title: str(r, "title"),
    text: str(r, "text"),
    elements: elements.map(toPageElement).filter((e): e is PageElement => e !== null),
  };
}

/**
 * The script the page runs (as a string: it runs in Chrome, not Deno). `snapshot` numbers the
 * visible links, buttons and inputs (a `data-loopy-ref` attribute) and returns the text and their
 * descriptions; `element` describes one; `click` clicks one (a link's target becomes the same
 * tab); `fill` sets a field's value through its native setter and fires `input` / `change`, with no
 * key presses. Field values are never read back.
 */
export const PAGE_SCRIPT = `(mode, arg) => {
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, ' +
    '[role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable]';
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const attr = (el, n) => (el.getAttribute(n) || '').trim().slice(0, 200);
  const text = (el) => {
    const type = attr(el, 'type').toLowerCase();
    const own = el.tagName === 'INPUT'
      ? (['submit', 'button', 'reset'].includes(type) ? el.value : '')
      : el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.innerText;
    return (own || attr(el, 'aria-label') || attr(el, 'alt') || attr(el, 'title') || '')
      .trim().slice(0, 200);
  };
  const describe = (el, ref) => {
    const form = el.form || el.closest('form');
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const method = attr(el, 'formmethod') || (form ? attr(form, 'method') || 'get' : '');
    return {
      ref, tag: el.tagName.toLowerCase(), type: attr(el, 'type'), role: attr(el, 'role'),
      text: text(el), name: attr(el, 'name'), id: (el.id || '').slice(0, 200),
      autocomplete: attr(el, 'autocomplete'), placeholder: attr(el, 'placeholder'),
      label: (label || '').trim().slice(0, 200), href: el.tagName === 'A' ? el.href : '',
      inForm: !!form, formMethod: method, editable: el.isContentEditable === true,
    };
  };
  if (mode === 'snapshot') {
    document.querySelectorAll('[data-loopy-ref]').forEach((e) => e.removeAttribute('data-loopy-ref'));
    const out = [];
    for (const el of document.querySelectorAll(SEL)) {
      if (out.length >= arg) break;
      if (!shown(el)) continue;
      el.setAttribute('data-loopy-ref', String(out.length + 1));
      out.push(describe(el, out.length + 1));
    }
    const body = document.body ? document.body.innerText.slice(0, 20000) : '';
    return { url: location.href, title: document.title, text: body, elements: out };
  }
  if (mode === 'scroll') {
    window.scrollBy(0, (arg === 'up' ? -0.8 : 0.8) * window.innerHeight);
    return true;
  }
  const el = document.querySelector('[data-loopy-ref="' + Number(arg.ref) + '"]');
  if (!el) return null;
  if (mode === 'element') return describe(el, arg.ref);
  el.scrollIntoView({ block: 'center' });
  if (mode === 'click') {
    if (el.tagName === 'A' && el.target) el.target = '_self';
    el.click();
    return true;
  }
  if (mode === 'fill') {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = arg.text;
    } else if (el.tagName === 'SELECT') {
      const o = Array.from(el.options).find((o) => o.text.trim() === arg.text || o.value === arg.text);
      if (o) el.value = o.value;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, arg.text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return null;
}`;

/** The expression that runs {@linkcode PAGE_SCRIPT} with `mode` and `arg`. */
export function pageCall(mode: string, arg: unknown): string {
  return `(${PAGE_SCRIPT})(${JSON.stringify(mode)}, ${JSON.stringify(arg)})`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a page may take to load. */
const LOAD_TIMEOUT_MS = 15_000;

/** A running Chrome: its process and the DevTools connection. */
interface Running {
  readonly child: Deno.ChildProcess;
  readonly browser: Browser;
  page: Page | null;
}

/** Read Chrome's stderr until the DevTools address appears. */
async function readEndpoint(child: Deno.ChildProcess): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  const reader = child.stderr.getReader();
  const timeout = setTimeout(() => reader.cancel().catch(() => {}), LOAD_TIMEOUT_MS);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seen = (seen + decoder.decode(value, { stream: true })).slice(-8_192);
      const endpoint = devtoolsEndpoint(seen);
      if (endpoint) return endpoint;
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  throw new BrowserError("Chrome didn't start.");
}

/** Start Chrome visible on a fresh profile and connect to it. */
async function launch(chromePath: string, profileDir: string): Promise<Running> {
  await Deno.remove(profileDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(profileDir, { recursive: true });
  const child = new Deno.Command(chromePath, {
    args: chromeArgs(profileDir),
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  try {
    const endpoint = await readEndpoint(child);
    // Chrome keeps logging to stderr; drain it so the pipe never fills.
    void child.stderr.pipeTo(new WritableStream()).catch(() => {});
    const browser = await connect({ endpoint });
    await browser.unsafelyGetCelestialBindings().Browser.setDownloadBehavior({ behavior: "deny" });
    return { child, browser, page: null };
  } catch (err) {
    try {
      child.kill("SIGKILL");
    } catch { /* gone */ }
    throw err instanceof BrowserError ? err : new BrowserError("Chrome didn't start.");
  }
}

/** Whether a DevTools connection is closed. */
const closed = (ws: WebSocket) => ws.readyState === WebSocket.CLOSED;

/** Poll until the page has loaded (navigation may destroy the context in between). */
async function settle(page: Page): Promise<void> {
  await sleep(500);
  const until = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < until) {
    const state = await page.evaluate("document.readyState").catch(() => "loading");
    if (state === "complete") return;
    await sleep(250);
  }
}

/** The paused-navigation events Chrome sends (`Fetch.requestPaused`, the fields used). */
interface PausedEvent {
  readonly detail: { readonly requestId: string; readonly request: PausedRequest };
}

/** What {@linkcode createChromeBrowser} needs. */
export interface ChromeOptions {
  /** The profile folder (wiped at each launch). */
  readonly profileDir: string;
  /** Finds Chrome (default {@linkcode findChrome}). */
  readonly find?: () => string | null;
}

/** Loopy's browser: a driver started on first use, and its shutdown. */
export interface ChromeBrowser {
  /** The driver, starting Chrome (or a new tab) when there is none. */
  driver(): Promise<BrowserDriver>;
  /** Close Chrome. */
  close(): Promise<void>;
}

/** Make the page Loopy drives: dialogs dismissed, top-level navigations through the gate. */
async function preparePage(running: Running, held: { current: HeldRequest | null }, gate = GATE) {
  const browserCdp = running.browser.unsafelyGetCelestialBindings();
  const before = await browserCdp.Target.getTargets({}).catch(() => ({ targetInfos: [] }));
  const page = await running.browser.newPage();
  // Chrome's first blank tab goes: Loopy works in the one tab it made (tabs the user opened stay).
  for (const t of before.targetInfos) {
    if (t.type === "page" && t.url === "about:blank") {
      void browserCdp.Target.closeTarget({ targetId: t.targetId }).catch(() => {});
    }
  }
  page.addEventListener("dialog", (e) => void e.detail.dismiss().catch(() => {}));
  const cdp = page.unsafelyGetCelestialBindings();
  cdp.addEventListener("Fetch.requestPaused", (e) => {
    const { requestId, request } = (e as unknown as PausedEvent).detail;
    const decision = gate.decide(request, held.current !== null);
    if (decision === "hold") held.current = { requestId, method: request.method, url: request.url };
    else if (decision === "fail") {
      void cdp.Fetch.failRequest({ requestId, errorReason: "BlockedByClient" }).catch(() => {});
    } else void cdp.Fetch.continueRequest({ requestId }).catch(() => {});
  });
  await cdp.Fetch.enable({ patterns: [{ resourceType: "Document", requestStage: "Request" }] });
  return page;
}

/** A held navigation and its paused request. */
interface HeldRequest extends HeldPost {
  readonly requestId: string;
}

/** The post gate for the browser's page (one browser per process). */
const GATE = createPostGate();

/** The driver over `page`. */
function pageDriver(page: Page, held: { current: HeldRequest | null }): BrowserDriver {
  const cdp = page.unsafelyGetCelestialBindings();
  const run = async (mode: string, arg: unknown): Promise<unknown> => {
    try {
      return await page.evaluate(pageCall(mode, arg));
    } catch {
      throw new BrowserError("The page didn't respond.");
    }
  };
  const release = async (allow: boolean) => {
    const h = held.current;
    held.current = null;
    if (!h) return;
    if (allow) {
      GATE.approve();
      await cdp.Fetch.continueRequest({ requestId: h.requestId }).catch(() => {});
      await settle(page);
    } else {
      await cdp.Fetch.failRequest({ requestId: h.requestId, errorReason: "BlockedByClient" })
        .catch(() => {});
    }
  };
  const act = async <T>(action: () => Promise<T>): Promise<T> => {
    if (held.current) await release(false);
    GATE.begin();
    try {
      return await action();
    } finally {
      GATE.end();
    }
  };
  return {
    open: (url) =>
      act(async () => {
        await page.goto(url, { waitUntil: "load" }).catch(() => {
          throw new BrowserError("The page didn't load.");
        });
      }),
    snapshot: async () => toSnapshot(await run("snapshot", MAX_ELEMENTS)),
    element: async (ref) => toPageElement(await run("element", { ref })),
    click: (ref) =>
      act(async () => {
        if (await run("click", { ref }) !== true) throw new BrowserError("That element is gone.");
        await settle(page);
      }),
    fill: (ref, text) =>
      act(async () => {
        if (await run("fill", { ref, text }) !== true) {
          throw new BrowserError("That field is gone.");
        }
      }),
    scroll: (direction) =>
      act(async () => {
        await run("scroll", direction);
        await sleep(300);
      }),
    back: () =>
      act(async () => {
        await page.goBack({ waitUntil: "load" }).catch(() => {
          throw new BrowserError("There's no page to go back to.");
        });
      }),
    heldPost: () => held.current ? { method: held.current.method, url: held.current.url } : null,
    releasePost: release,
    approved: async (action) => {
      GATE.approve();
      return await act(action);
    },
  };
}

/** Loopy's Chrome. */
export function createChromeBrowser(options: ChromeOptions): ChromeBrowser {
  let running: Running | null = null;
  let starting: Promise<Running> | null = null;
  const held = { current: null as HeldRequest | null };
  const killNow = () => {
    try {
      running?.child.kill("SIGTERM");
    } catch { /* already gone */ }
  };
  globalThis.addEventListener("unload", killNow);

  const ensure = async (): Promise<Running> => {
    if (running && !closed(running.browser.unsafelyGetCelestialBindings().ws)) return running;
    running = null;
    const path = (options.find ?? findChrome)();
    if (!path) throw new BrowserError("Loopy's browser needs Google Chrome or Chromium installed.");
    starting ??= launch(path, options.profileDir).finally(() => (starting = null));
    return running = await starting;
  };

  return {
    async driver() {
      const r = await ensure();
      if (!r.page || closed(r.page.unsafelyGetCelestialBindings().ws)) {
        held.current = null;
        r.page = await preparePage(r, held);
      }
      return pageDriver(r.page, held);
    },
    async close() {
      const r = running;
      running = null;
      held.current = null;
      if (!r) return;
      await r.browser.close().catch(() => {});
      try {
        r.child.kill("SIGTERM");
      } catch { /* exited with the browser */ }
      await r.child.status.catch(() => {});
    },
  };
}
