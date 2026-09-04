// SPA mode: the dev live-reload client, served as an external same-origin module so the
// strict CSP allows it (no inline script).

import { CLIENT_PREFIX, RELOAD_PATH } from "./shared.ts";

/**
 * On a `refresh` event it re-imports the cache-busted entry bundle: the dev server has
 * already rebuilt it, so the fresh component refs reconcile onto the live fiber tree
 * (the generated dev entry installed `enableFastRefresh()` and `createRoot` retains its
 * root under refresh) — hook state survives, no page reload. A `reload` event
 * (entry/config edit, or any refresh failure) is a full reload. `css` re-links the
 * stylesheets; `update:<json>` is the per-module HMR frame (unbundled loop).
 */
export const SPA_DEV_RELOAD = `(function(){
  function reload(){ location.reload(); }
  function swapCss(){
    // Re-link every same-origin stylesheet cache-busted (the dev index.css rebuilt
    // with the bundle), so a component edit that changes Tailwind classes restyles
    // without a reload. The old <link> is dropped only once the new one has loaded.
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) (function(l){
      var href = l.getAttribute("href");
      if (!href) return;
      var u; try { u = new URL(href, location.href); } catch (_) { return; }
      if (u.origin !== location.origin) return;
      u.searchParams.set("hmr", String((window.__denextCssHmr = (window.__denextCssHmr || 0) + 1)));
      var n = l.cloneNode(false);
      n.setAttribute("href", u.href);
      n.onload = function(){ try { l.remove(); } catch (_) {} };
      l.parentNode.insertBefore(n, l.nextSibling);
    })(links[i]);
  }
  function refresh(){
    try {
      var s = document.querySelector('script[type=module][src*="${CLIENT_PREFIX}"]');
      if (!s) return reload();
      var u = new URL(s.getAttribute("src"), location.href);
      if (u.origin !== location.origin) return reload();
      u.searchParams.set("hmr", String((window.__denextHmr = (window.__denextHmr || 0) + 1)));
      var n = document.createElement("script");
      n.type = "module";
      n.src = u.href;
      n.onerror = function(){ n.remove(); reload(); };
      n.onload = function(){ n.remove(); swapCss(); };
      document.body.appendChild(n);
    } catch (_) { reload(); }
  }
  function update(json){
    // Per-module HMR (unbundled SPA): re-import ONLY the changed accept-boundary
    // module(s), cache-busted (same-origin guard), then trigger the reconciler's
    // family-current substitution. Any failure falls back to a full reload.
    var urls; try { urls = JSON.parse(json); } catch (_) { return reload(); }
    if (!urls || !urls.length) return reload();
    Promise.all(urls.map(function(u){
      var abs = new URL(u, location.href);
      if (abs.origin !== location.origin) throw new Error("cross-origin module");
      return import(abs.href);
    })).then(function(){
      var r = window.__denextRefresh;
      if (typeof r === "function") r(); else reload();
      swapCss();
    }).catch(reload);
  }
  try {
    var es = new EventSource(${JSON.stringify(RELOAD_PATH)});
    es.onmessage = function(e){
      if (e.data === "refresh") refresh();
      else if (e.data === "reload") reload();
      else if (e.data === "css") swapCss();
      else if (e.data.indexOf("update:") === 0) update(e.data.slice(7));
    };
  } catch (_) {}
})();`;
