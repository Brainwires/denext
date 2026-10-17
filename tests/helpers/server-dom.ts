// The server render of a component test as testing-DOM nodes (iso-island tests).
import { DomDocument, type DomEl } from "../../src/testing/dom.ts";

/** Build `html` (the server render) as testing-DOM nodes under a container. */
export function serverDom(html: string): { doc: DomDocument; container: DomEl } {
  const doc = new DomDocument();
  const container = doc.createElement("div");
  // A tiny markup reader: the server output here is elements, attributes and text only.
  const stack: DomEl[] = [container];
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.appendChild(doc.createTextNode(m[4].replace(/&amp;/g, "&")) as never);
    } else if (m[1]) stack.pop();
    else {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
      top.appendChild(el as never);
      stack.push(el);
    }
  }
  return { doc, container };
}
