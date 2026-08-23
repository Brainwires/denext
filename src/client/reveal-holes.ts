// Ordering-safety sweep for streamed Suspense/PPR holes.
//
// The inline swap runtime (src/server/swap-runtime.ts) reveals each streamed
// `<template data-dnx-r="id">` into its `[data-dnx-b="id"]` placeholder via a
// MutationObserver + a final DOMContentLoaded scan. A route bundle's hydration
// runs from a deferred `<script type="module">`, which executes just BEFORE
// DOMContentLoaded — so, defensively, any template not yet swapped by the observer
// is swapped synchronously here before `hydrateRoot` reads the DOM. Without this a
// still-pending hole would hydrate against its fallback and mismatch.
//
// This mirrors the inline runtime's swap exactly and is idempotent with it: it
// removes each template as it swaps, and the observer's `isConnected` guard skips
// any template this sweep already removed — so a late observer callback can never
// re-clear a placeholder whose content has since been hydrated.

/**
 * Synchronously swap every remaining `<template data-dnx-r>` into its placeholder.
 * Safe to call more than once and safe to interleave with the inline swap runtime.
 */
export function revealStreamedHoles(): void {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return;
  }
  const templates = document.querySelectorAll("template[data-dnx-r]");
  for (const t of templates) {
    const tpl = t as HTMLTemplateElement;
    const id = tpl.getAttribute("data-dnx-r");
    if (!id) continue;
    const placeholder = document.querySelector(`[data-dnx-b="${id}"]`);
    if (placeholder) {
      placeholder.innerHTML = "";
      placeholder.appendChild(tpl.content.cloneNode(true));
    }
    tpl.remove();
  }
}
