// An opt-in, self-contained dev "glass-box" panel. Render it in a layout **during
// development only** (e.g. `{dev && <DevPanel />}`) to see the page cache's
// hit/miss/set counts and recent invalidations (a server-render snapshot from
// `getCacheStats()`), plus the client island-hydration timeline (filled live from
// `window.__denextIslands`). It ships no bundle and needs no dev-server wiring: the
// styles and the tiny timeline script are inlined, so a Server Component render is
// all it takes. Not for production — it exposes internal cache activity.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { getCacheStats } from "./cache.ts";

const CSS = `.dnx-devpanel{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:230px;
font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6e9ef;background:#12151c;
border:1px solid #2a3140;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4);overflow:hidden}
.dnx-devpanel .dnx-dp-title{padding:7px 11px;background:#0c0e14;border-bottom:1px solid #2a3140;
font-weight:600;letter-spacing:.02em;color:#8aa2ff}
.dnx-devpanel .dnx-dp-sec{padding:9px 11px;border-bottom:1px solid #1d2330}
.dnx-devpanel .dnx-dp-sec:last-child{border-bottom:0}
.dnx-devpanel h4{margin:0 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b94a7}
.dnx-devpanel .dnx-dp-stats{display:flex;flex-wrap:wrap;gap:4px 10px}
.dnx-devpanel .dnx-dp-stat b{color:#7ad6a0}
.dnx-devpanel ul{margin:6px 0 0;padding:0;list-style:none;max-height:120px;overflow-y:auto}
.dnx-devpanel li{padding:2px 0;border-top:1px solid #1a202c}
.dnx-devpanel .dnx-dp-kind{color:#f0b45b}
.dnx-devpanel .dnx-dp-strat{color:#8aa2ff}
.dnx-devpanel .dnx-dp-id{color:#8b94a7}
.dnx-devpanel .dnx-dp-at{float:right;color:#8b94a7}
.dnx-devpanel .dnx-dp-empty{color:#5b647a;border-top:0}`;

// Fills #dnx-dp-islands from window.__denextIslands (dev-only; grows as islands
// hydrate). Polls briefly so lazily-hydrated islands appear without a reload.
const CLIENT_JS = `(function(){var el=document.getElementById('dnx-dp-islands');if(!el)return;
function esc(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function render(){var list=(window.__denextIslands)||[];if(!list.length){el.innerHTML=
'<li class="dnx-dp-empty">none hydrated</li>';return;}el.innerHTML=list.map(function(i){return '<li>'+
'<span class="dnx-dp-at">'+Math.round(i.at)+'ms</span>'+
'<span class="dnx-dp-strat">'+esc(i.strategy)+(i.param?'('+esc(i.param)+')':'')+'</span>'+
(i.id?' <span class="dnx-dp-id">#'+esc(i.id)+'</span>':'')+'</li>';}).join('');}
render();var n=0,t=setInterval(function(){render();if(++n>40)clearInterval(t);},500);})();`;

function stat(label: string, n: number): VNode {
  return h("span", { class: "dnx-dp-stat" }, h("b", null, String(n)), " " + label);
}

/**
 * The dev glass-box panel — page-cache observability + the island-hydration
 * timeline. Render it **only in development** (it exposes internal cache activity
 * and adds an inline script). The cache figures are a snapshot taken when this
 * component renders; the island list fills in live on the client.
 */
export function DevPanel(): VNode {
  const s = getCacheStats();
  const recent = s.recentInvalidations.slice(-8).reverse();
  return h(
    "div",
    { class: "dnx-devpanel", role: "complementary", "aria-label": "denext dev panel" },
    h("style", { dangerouslySetInnerHTML: { __html: CSS } }),
    h("div", { class: "dnx-dp-title" }, "denext · glass-box"),
    h(
      "div",
      { class: "dnx-dp-sec" },
      h("h4", null, "Page cache"),
      h(
        "div",
        { class: "dnx-dp-stats" },
        stat("hits", s.pageHits),
        stat("misses", s.pageMisses),
        stat("sets", s.pageSets),
        stat("invalidations", s.invalidations),
      ),
      recent.length > 0
        ? h(
          "ul",
          null,
          recent.map((e, i) =>
            h(
              "li",
              { key: String(i) },
              h("span", { class: "dnx-dp-kind" }, e.kind),
              " " + e.value,
            )
          ),
        )
        : h("div", { class: "dnx-dp-empty" }, "no invalidations"),
    ),
    h(
      "div",
      { class: "dnx-dp-sec" },
      h("h4", null, "Islands"),
      h(
        "ul",
        { id: "dnx-dp-islands" },
        h("li", { class: "dnx-dp-empty" }, "…"),
      ),
    ),
    h("script", { dangerouslySetInnerHTML: { __html: CLIENT_JS } }),
  );
}
