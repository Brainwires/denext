/**
 * Exclusive XML Canonicalization 1.0 (https://www.w3.org/TR/xml-exc-c14n/) of an element
 * subtree, with and without comments and with the `InclusiveNamespaces PrefixList`.
 *
 * The input node-set is the subtree rooted at an element (the apex), optionally minus one
 * descendant element and everything under it (the enveloped-signature transform). Namespace
 * declarations in scope from ancestors OUTSIDE the subtree are taken into account, as the
 * spec requires, but only those the output visibly utilizes (or the PrefixList names) are
 * rendered. `xml:*` attributes are never inherited from ancestors (exclusive c14n §3).
 *
 * @module
 */

import { lookupNamespace, type XmlAttr, type XmlElement, type XmlNode } from "./xml.ts";

/** Options for {@link excC14n}. */
export interface ExcC14nOptions {
  /** Keep comment nodes (the `#WithComments` variant). Default `false`. */
  withComments?: boolean;
  /** The InclusiveNamespaces PrefixList, as tokens (`#default` = the default namespace). */
  inclusivePrefixes?: readonly string[];
  /** An element to leave out with its whole subtree (the enveloped Signature). */
  exclude?: XmlElement;
}

/** Compare two strings by Unicode code point, as C14N requires (not by UTF-16 unit). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

function escapeText(s: string): string {
  return s.replace(
    /[&<>\r]/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#xD;",
  );
}

function escapeAttr(s: string): string {
  return s.replace(/[&<"\t\n\r]/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case '"':
        return "&quot;";
      case "\t":
        return "&#x9;";
      case "\n":
        return "&#xA;";
      default:
        return "&#xD;";
    }
  });
}

/** Every prefix declared on `el` or an ancestor (the in-scope set, by prefix). */
function inScopePrefixes(el: XmlElement): Set<string> {
  const out = new Set<string>();
  for (let e: XmlElement | null = el; e; e = e.parent) {
    for (const [p] of e.nsDecls) out.add(p);
  }
  return out;
}

class Canonicalizer {
  private readonly out: string[] = [];
  private readonly inclusive: Set<string>;

  constructor(private readonly options: ExcC14nOptions) {
    this.inclusive = new Set(
      (options.inclusivePrefixes ?? []).map((p) => (p === "#default" ? "" : p)),
    );
  }

  run(apex: XmlElement): string {
    this.element(apex, new Map());
    return this.out.join("");
  }

  /** The prefixes `el` visibly utilizes, plus the PrefixList ones in scope at `el`. */
  private candidates(el: XmlElement): Set<string> {
    const out = new Set<string>([el.prefix]);
    for (const a of el.attrs) if (a.prefix) out.add(a.prefix);
    if (this.inclusive.size) {
      const scope = inScopePrefixes(el);
      for (const p of this.inclusive) if (p === "" || scope.has(p)) out.add(p);
    }
    out.delete("xml"); // never declared, never rendered
    return out;
  }

  /** The namespace declarations `el` renders, sorted, given what ancestors rendered. */
  private namespaces(el: XmlElement, rendered: Map<string, string>): [string, string][] {
    const decls: [string, string][] = [];
    for (const p of this.candidates(el)) {
      // Every candidate is bound: visibly used prefixes were checked by the parser, and
      // PrefixList prefixes were filtered to the in-scope set.
      const uri = lookupNamespace(el, p)!;
      const prior = rendered.get(p) ?? (p === "" ? "" : undefined);
      if (prior !== uri) decls.push([p, uri]);
    }
    return decls.sort((a, b) => compareCodePoints(a[0], b[0]));
  }

  private element(el: XmlElement, rendered: Map<string, string>): void {
    const decls = this.namespaces(el, rendered);
    const out = this.out;
    out.push("<", el.qname);
    let scope = rendered;
    if (decls.length) {
      scope = new Map(rendered);
      for (const [p, uri] of decls) {
        out.push(p ? ` xmlns:${p}="` : ` xmlns="`, escapeAttr(uri), '"');
        scope.set(p, uri);
      }
    }
    const attrs = [...el.attrs].sort((a: XmlAttr, b: XmlAttr) =>
      compareCodePoints(a.ns, b.ns) || compareCodePoints(a.local, b.local)
    );
    for (const a of attrs) out.push(" ", a.qname, '="', escapeAttr(a.value), '"');
    out.push(">");
    for (const child of el.children) this.node(child, scope);
    out.push("</", el.qname, ">");
  }

  private node(node: XmlNode, rendered: Map<string, string>): void {
    switch (node.type) {
      case "element":
        if (node !== this.options.exclude) this.element(node, rendered);
        return;
      case "text":
        this.out.push(escapeText(node.value));
        return;
      case "comment":
        if (this.options.withComments) this.out.push("<!--", node.value, "-->");
        return;
      case "pi":
        this.out.push("<?", node.target, node.data ? ` ${node.data}` : "", "?>");
        return;
    }
  }
}

/**
 * Canonicalize the subtree rooted at `apex` with Exclusive XML Canonicalization 1.0.
 *
 * @param apex The element whose subtree is the input node-set.
 * @param options Comments, the InclusiveNamespaces PrefixList, an excluded subtree.
 * @returns The canonical form, as a string (encode it as UTF-8 to digest or sign it).
 */
export function excC14n(apex: XmlElement, options: ExcC14nOptions = {}): string {
  return new Canonicalizer(options).run(apex);
}
