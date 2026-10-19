/**
 * Document-wide CSS rules for React Native mode's own shims (the `TextInput` placeholder and
 * selection rules, the lists' hidden scrollbar): pseudo-element rules an inline style cannot
 * express. They go into a constructed style sheet adopted by the document (CSSOM, which a
 * Content-Security-Policy's `style-src` does not govern), so a strict CSP with no
 * `'unsafe-inline'` keeps them; a browser without `adoptedStyleSheets` gets a `<style>` element.
 * Internal.
 *
 * @module
 */

/** The ids added per document. */
const added = new WeakMap<object, Set<string>>();

/** A document as this module uses it (`adoptedStyleSheets` is absent in older browsers). */
type StyledDocument = Document & { adoptedStyleSheets?: CSSStyleSheet[] };

/** Adopt `rules` as a constructed sheet; false when the document can't adopt one. */
function adopt(doc: StyledDocument, rules: readonly string[]): boolean {
  const Sheet = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
  if (!Array.isArray(doc.adoptedStyleSheets) || typeof Sheet !== "function") return false;
  try {
    const sheet = new Sheet();
    for (const rule of rules) {
      try {
        sheet.insertRule(rule, sheet.cssRules.length);
      } catch { /* a selector this browser doesn't know: skip that rule */ }
    }
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    return true;
  } catch {
    return false; // constructed sheets unsupported after all → a <style> element
  }
}

/**
 * Add `rules` to the current document once per `id` (no-op without a document).
 *
 * @param id A stable id for the rule set (also the fallback `<style>` element's id).
 * @param rules Whole CSS rules, one per entry.
 */
export function addDocumentRules(id: string, rules: readonly string[]): void {
  const doc = (globalThis as { document?: StyledDocument }).document;
  if (!doc?.head || typeof doc.createElement !== "function") return;
  let ids = added.get(doc);
  if (!ids) added.set(doc, ids = new Set());
  if (ids.has(id)) return;
  ids.add(id);
  if (doc.getElementById?.(id) || adopt(doc, rules)) return;
  const el = doc.createElement("style");
  el.id = id;
  el.textContent = rules.join("");
  doc.head.appendChild(el);
}
