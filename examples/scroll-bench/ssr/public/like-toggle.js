// The delegated like handler, shared by the LikeDelegate island (static-cv-delegated) and the
// plain script (static-cv-script): a click on any row's `button[data-like]` flips its
// `aria-pressed`, the row's only state.

/** @param {Event} e */
export function toggleLike(e) {
  const button = /** @type {Element} */ (e.target).closest("button[data-like]");
  if (!button) return;
  const on = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(on));
  button.textContent = on ? "♥" : "♡";
}
