// The single inline runtime that reveals streamed Suspense/PPR holes.
//
// Streaming SSR and PPR flush a shell whose still-pending regions show a fallback
// inside a `<div data-dnx-b="id">` placeholder; each region's real content then
// streams in later as a `<template data-dnx-r="id">…</template>`. This runtime,
// emitted ONCE right after the shell, swaps every such template into its matching
// placeholder — via a `MutationObserver` for templates that arrive after it runs,
// plus an immediate sweep for any already parsed, plus a final sweep at
// `DOMContentLoaded` before the deferred hydration module runs.
//
// Why one constant instead of a per-hole `<script>__dnxSwap('id')</script>`: the
// per-hole script *varied* (the id), so it could never be a stable CSP hash and
// forced streamed responses to drop the hash-based CSP entirely. This body is a
// framework CONSTANT — its `'sha256-…'` ({@linkcode swapRuntimeHash}) is fixed, so
// a streamed document can carry the same strict CSP as a buffered one. Hashing a
// constant (never output) preserves the CSP invariant: an injected `<script>` still
// cannot self-authorize.

/**
 * The JS body of {@link SWAP_RUNTIME} (the text a CSP `'sha256-…'` is computed
 * over — the `<script>`'s text content, without the tags). Kept minimal and
 * dependency-free so its hash is a stable constant.
 *
 * A `window.__denextDev`-gated tail records a real-time reveal timeline for the DevTools
 * per-boundary waterfall: a `performance.mark('dnx-reveal:<id>')`, a push of
 * `{ id, revealAt, serverMs }` (server resolve time read from the template's optional
 * `data-dnx-ms`) onto `window.__denextBoundaries`, and a `denext:reveal` event. It reads
 * per-hole values at RUNTIME (not baked into this text), so the body stays a fixed
 * constant and its CSP hash remains stable; production skips the whole branch.
 */
export const SWAP_RUNTIME_BODY =
  `(function(){function s(t){if(!t.isConnected)return;var i=t.getAttribute('data-dnx-r');if(!i)return;var m=t.getAttribute('data-dnx-ms');var p=document.querySelector('[data-dnx-b="'+i+'"]');if(p){p.innerHTML='';p.appendChild(t.content.cloneNode(true));}t.remove();if(window.__denextDev){try{performance.mark('dnx-reveal:'+i);}catch(e){}(window.__denextBoundaries||(window.__denextBoundaries=[])).push({id:i,revealAt:(window.performance&&performance.now?performance.now():0),serverMs:m?parseFloat(m):null});try{document.dispatchEvent(new CustomEvent('denext:reveal',{detail:i}));}catch(e){}}}function scan(){var l=document.querySelectorAll('template[data-dnx-r]');for(var j=0;j<l.length;j++)s(l[j]);}var o=new MutationObserver(function(m){for(var k=0;k<m.length;k++){var a=m[k].addedNodes;for(var q=0;q<a.length;q++){var n=a[q];if(n.nodeType===1&&n.tagName==='TEMPLATE'&&n.hasAttribute('data-dnx-r'))s(n);}}});o.observe(document.body||document.documentElement,{childList:true,subtree:true});scan();if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',function(){scan();o.disconnect();});}else{o.disconnect();}})();`;

/** The full inline `<script>` element wrapping {@link SWAP_RUNTIME_BODY}. */
export const SWAP_RUNTIME = `<script>${SWAP_RUNTIME_BODY}</script>`;

/** SHA-256 of `text` as base64 (the form a CSP `'sha256-…'` source expects). */
async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

let cachedHash: string | undefined;

/**
 * The CSP `script-src` source for the swap runtime: `'sha256-…'` of
 * {@link SWAP_RUNTIME_BODY}. Memoized — the body is a constant, so the hash is
 * computed once. Included in {@linkcode resolveStreamingCsp} so a streamed
 * response can authorize this one inline script under a strict, hash-based CSP.
 */
export async function swapRuntimeHash(): Promise<string> {
  if (cachedHash === undefined) {
    cachedHash = `'sha256-${await sha256Base64(SWAP_RUNTIME_BODY)}'`;
  }
  return cachedHash;
}
