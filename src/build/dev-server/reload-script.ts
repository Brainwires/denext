// The dev runtime script injected into every dev page (live reload / Fast Refresh over
// SSE, the `__denextDev` marker, the dev error overlay). Served as an external
// same-origin module at DEV_RELOAD_JS_PATH so the strict dev CSP allows it.

import { DEV_LOG_PATH, OPEN_IN_EDITOR_PATH, RELOAD_PATH } from "./state.ts";

/**
 * Inline script injected into every dev page. It enables live reload and marks
 * the page as a dev build (`__denextDev`) so the client reconciler can emit
 * hydration-mismatch warnings — production pages never carry this script. It is
 * a plain (non-module) script placed before `</body>`, so it runs during parse,
 * ahead of the deferred hydration module.
 */
/**
 * Inline dev script injected into every dev page: live reload / Fast Refresh over
 * SSE, the `__denextDev` marker, and the dev error overlay (runtime errors,
 * unhandled rejections, and server-pushed build errors). Exported for tests;
 * never emitted into a production build.
 */
export const DEV_RELOAD_SCRIPT = `
(function () {
  window.__denextDev = true;
  // --- Dev log capture (browser -> server ring buffer, read via MCP) ---------
  // Ship console.error/warn + uncaught errors/rejections back to the dev server so the
  // running app's browser signal is readable out-of-process (GET /_denext/dev-state).
  // Best-effort and same-origin (the dev page's own origin); never breaks the app.
  var DEV_LOG = ${JSON.stringify(DEV_LOG_PATH)};
  function report(level, message, stack) {
    try {
      fetch(DEV_LOG, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          level: level,
          message: String(message == null ? "" : message).slice(0, 2000),
          stack: stack ? String(stack).slice(0, 4000) : "",
          url: location.pathname,
        }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }
  ["error", "warn"].forEach(function (lvl) {
    var orig = console[lvl];
    console[lvl] = function () {
      try { report(lvl, Array.prototype.join.call(arguments, " "), ""); } catch (_) {}
      return orig.apply(this, arguments);
    };
  });
  // --- Dev error overlay -----------------------------------------------------
  var overlay = null;
  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }
  function openInEditor(frame) {
    // Ask the dev server to open the file (it validates the path is in-project and
    // launches $EDITOR). Best-effort — a failure is silently ignored.
    var q = "?file=" + encodeURIComponent(frame.file) +
      "&line=" + (frame.line || 1) + "&column=" + (frame.column || 1);
    try { fetch(${JSON.stringify(OPEN_IN_EDITOR_PATH)} + q).catch(function () {}); } catch (_) {}
  }
  // extra (optional): { frame: {file, display, line, column}, codeframe } — enriches a
  // server/build error with a clickable in-project frame + a source snippet.
  function showOverlay(title, message, stack, extra) {
    hideOverlay();
    overlay = el("div",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(20,10,10,.96);" +
      "color:#e6e6e6;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "padding:24px 28px;overflow:auto;");
    var close = el("button",
      "position:absolute;top:14px;right:18px;background:none;border:none;color:#999;" +
      "font-size:26px;cursor:pointer;line-height:1;", "×");
    close.onclick = hideOverlay;
    overlay.appendChild(close);
    overlay.appendChild(el("div",
      "color:#ff6b6b;font-weight:700;font-size:15px;margin-bottom:6px;", "denext — " + title));
    if (extra && extra.frame) {
      var f = extra.frame;
      var loc = el("button",
        "display:block;background:none;border:none;padding:0;margin:0 0 10px;color:#8ab4f8;" +
        "font:inherit;text-decoration:underline;cursor:pointer;",
        (f.display || f.file) + ":" + (f.line || 1) + " — open in editor");
      loc.onclick = function () { openInEditor(f); };
      overlay.appendChild(loc);
    }
    overlay.appendChild(el("div",
      "color:#ffd7d7;white-space:pre-wrap;margin-bottom:14px;font-size:14px;", message || ""));
    if (extra && extra.codeframe) {
      overlay.appendChild(el("pre",
        "white-space:pre;overflow:auto;color:#e6e6e6;background:rgba(0,0,0,.35);" +
        "padding:12px 14px;border-radius:6px;margin:0 0 14px;", extra.codeframe));
    }
    overlay.appendChild(el("pre", "white-space:pre-wrap;color:#b9b9b9;margin:0;", stack || ""));
    (document.body || document.documentElement).appendChild(overlay);
  }
  window.__denextOverlay = showOverlay;
  window.addEventListener("error", function (e) {
    if (e && e.error) {
      showOverlay("Runtime error", e.error.message, e.error.stack);
      report("error", e.error.message, e.error.stack);
    }
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    if (r) {
      showOverlay("Unhandled rejection", r.message || String(r), r.stack);
      report("error", r.message || String(r), r.stack);
    }
  });

  function swapCss() {
    // CSS hot-swap: re-fetch every same-origin stylesheet with a fresh cache-buster
    // (the dev CSS endpoint is no-store and rebuilt per generation), swapping each
    // <link> for a clone so styles update with no page reload and no flash. The old
    // link is removed only once the new one has loaded.
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      (function (l) {
        var href = l.getAttribute("href");
        if (!href) return;
        var u;
        try { u = new URL(href, location.href); } catch (_) { return; }
        if (u.origin !== location.origin) return;
        u.searchParams.set("hmr", String((window.__denextCssHmr = (window.__denextCssHmr || 0) + 1)));
        var n = l.cloneNode(false);
        n.setAttribute("href", u.href);
        n.onload = function () { try { l.remove(); } catch (_) {} };
        n.onerror = function () { try { n.remove(); } catch (_) {} location.reload(); };
        l.parentNode.insertBefore(n, l.nextSibling);
      })(links[i]);
    }
  }
  function refresh() {
    // Fast Refresh: re-import the route entry (cache-busted) so it re-runs
    // startClient -> retainedRoot.render(), reconciling edits in place and
    // preserving hook state. The entry falls back to a full reload if the
    // refresh is unsafe (hook-shape change) or hydration throws.
    try {
      var s = document.querySelector('script[type=module][src*="/_denext/"]');
      if (!s) { location.reload(); return; }
      var u = new URL(s.getAttribute("src"), location.href);
      // Defense-in-depth: the [src*="/_denext/"] selector matches on a substring,
      // so a cross-origin script (e.g. https://evil.example/_denext/x.js) could be
      // picked up. Only ever re-import from our own origin; otherwise hard-reload.
      if (u.origin !== location.origin) { location.reload(); return; }
      u.searchParams.set("hmr", String((window.__denextHmr = (window.__denextHmr || 0) + 1)));
      window.__denextRefreshing = true;
      var n = document.createElement("script");
      n.type = "module";
      n.src = u.href;
      n.onload = function () { n.remove(); };
      n.onerror = function () { n.remove(); location.reload(); };
      document.body.appendChild(n);
    } catch (_) { location.reload(); }
  }
  function update(json) {
    // Per-module HMR (unbundled dev server): re-import ONLY the changed accept-boundary
    // module(s), cache-busted, then trigger the reconciler's in-place re-render — the
    // family-current substitution swaps the new code onto the live fibers, hook state
    // intact. Any failure (or a cross-origin URL, defense-in-depth) falls back to a full
    // reload, so an edit is never silently half-applied.
    var urls;
    try { urls = JSON.parse(json); } catch (_) { location.reload(); return; }
    if (!urls || !urls.length) { location.reload(); return; }
    Promise.all(urls.map(function (u) {
      var abs = new URL(u, location.href);
      if (abs.origin !== location.origin) throw new Error("cross-origin module");
      return import(abs.href);
    })).then(function () {
      var r = window.__denextRefresh;
      if (typeof r === "function") r();
      else location.reload();
    }).catch(function () { location.reload(); });
  }
  try {
    var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
    es.onmessage = function (e) {
      if (e.data === "refresh") { hideOverlay(); refresh(); }
      else if (e.data === "css") { hideOverlay(); swapCss(); }
      else if (e.data === "reload") location.reload();
      else if (e.data.indexOf("update:") === 0) { hideOverlay(); update(e.data.slice(7)); }
      else if (e.data.indexOf("error:") === 0) {
        try {
          var p = JSON.parse(e.data.slice(6));
          showOverlay(p.title || "Build error", p.message, p.stack,
            { frame: p.frame, codeframe: p.codeframe });
        } catch (_) {}
      }
    };
    es.onerror = function () { /* reconnect handled by browser */ };
  } catch (_) {}
})();
`;
