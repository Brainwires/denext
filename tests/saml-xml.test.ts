// The strict XML parser and Exclusive XML Canonicalization behind the SAML SP primitives.
// c14n is checked against the W3C exc-c14n spec's own examples and against libxml2
// (`xmllint --exc-c14n`, output committed in tests/fixtures/saml/c14n-exc.txt).

import { assertEquals, assertThrows } from "@std/assert";
import { compareCodePoints, excC14n } from "../src/server/auth/saml/c14n.ts";
import { SamlError } from "../src/server/auth/saml/errors.ts";
import {
  isNcName,
  lookupNamespace,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  parseXml,
  type XmlElement,
} from "../src/server/auth/saml/xml.ts";

function code(fn: () => unknown): string {
  const err = assertThrows(fn, SamlError);
  return err.code;
}

function child(el: XmlElement, local: string): XmlElement {
  const found = el.children.find((c): c is XmlElement => c.type === "element" && c.local === local);
  if (!found) throw new Error(`no <${local}>`);
  return found;
}

Deno.test("xml: parses namespaces, attributes, text, CDATA, comments and PIs", () => {
  const doc = parseXml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- c --><?p d?>\n` +
      `<a:r xmlns:a="urn:a" xmlns="urn:d" a:x="1" y='2'>t1<![CDATA[<c>]]>t2<!--k--><?pi  data ?><e/></a:r>\n<!-- after -->`,
  );
  const r = doc.root;
  assertEquals([r.prefix, r.local, r.ns], ["a", "r", "urn:a"]);
  assertEquals(r.attrs.map((a) => [a.qname, a.ns, a.value]), [["a:x", "urn:a", "1"], [
    "y",
    "",
    "2",
  ]]);
  assertEquals(r.children[0], { type: "text", value: "t1<c>t2" });
  assertEquals(r.children[1], { type: "comment", value: "k" });
  assertEquals(r.children[2], { type: "pi", target: "pi", data: "data " });
  const e = child(r, "e");
  assertEquals([e.ns, e.parent], ["urn:d", r]);
  assertEquals(doc.elements.length, 2);
  assertEquals(lookupNamespace(e, "a"), "urn:a");
  assertEquals(lookupNamespace(e, "zz"), undefined);
  assertEquals(lookupNamespace(e, "xml"), "http://www.w3.org/XML/1998/namespace");
});

Deno.test("xml: normalizes line endings, attribute whitespace and references", () => {
  const doc = parseXml(
    `<a b="x\ty\r\nz&#10;w&#x9;">l1\r\nl2\rl3&lt;&gt;&amp;&quot;&apos;&#x1D504;</a>`,
  );
  assertEquals(doc.root.attrs[0].value, "x y z\nw\t");
  assertEquals(doc.root.children[0], { type: "text", value: "l1\nl2\nl3<>&\"'𝔄" });
});

Deno.test("xml: accepts a BOM, bytes, and a redundant xml prefix declaration", () => {
  const bytes = new TextEncoder().encode(
    `\uFEFF<a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en"/>`,
  );
  const doc = parseXml(bytes);
  assertEquals(doc.root.nsDecls, []);
  assertEquals(doc.root.attrs[0].ns, "http://www.w3.org/XML/1998/namespace");
});

Deno.test("xml: refuses DOCTYPE, entity declarations, XXE and billion laughs", () => {
  const cases = [
    `<!DOCTYPE a><a/>`,
    `<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`,
    `<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>`,
    `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`,
    `<a><!DOCTYPE a></a>`,
    `<a><!ENTITY x "y"></a>`,
    `<!doctype a><a/>`,
  ];
  for (const xml of cases) assertEquals(code(() => parseXml(xml)), "doctype_forbidden", xml);
});

Deno.test("xml: refuses malformed documents", () => {
  const cases = [
    ``,
    `text`,
    `<a>`,
    `<a></b>`,
    `<a/><b/>`,
    `<a/>text`,
    `<a b="1" b="2"/>`,
    `<a xmlns:p="urn:x" xmlns:q="urn:x" p:b="1" q:b="2"/>`,
    `<p:a/>`,
    `<a p:b="1"/>`,
    `<a b=1/>`,
    `<a b="1"c="2"/>`,
    `<a b="<"/>`,
    `<a b/>`,
    `<a>&undefined;</a>`,
    `<a>&constructor;</a>`,
    `<a b="&toString;"/>`,
    `<a>& </a>`,
    `<a>&amp</a>`,
    `<a>&#0;</a>`,
    `<a>&#xD800;</a>`,
    `<a>]]></a>`,
    `<a>\u0001</a>`,
    `<a><!-- a -- b --></a>`,
    `<a><!-- a ---></a>`,
    `<a><!-- open</a>`,
    `<a><![CDATA[open</a>`,
    `<a><?xml version="1.0"?></a>`,
    `<a><?p:q?></a>`,
    `<a><?p</a>`,
    `<a><?pdata?></a>`.replace("pdata", "p\u0001"),
    `<a><!ELEMENTS></a>`.replace("ELEMENTS", "FOO"),
    `<a xmlns:p=""/>`,
    `<a xmlns:xml="urn:other"/>`,
    `<a xmlns:xmlns="urn:x"/>`,
    `<a xmlns:p="http://www.w3.org/2000/xmlns/"/>`,
    `<a xmlns="http://www.w3.org/XML/1998/namespace"/>`,
    `<:a/>`,
    `<a:/>`,
    `<a:b:c xmlns:a="urn:a"/>`,
    `<?xml version="1.1"?><a/>`,
    `<?xml version="1.0" encoding="ISO-8859-1"?><a/>`,
    `<?xml version="1.0"<a/>`,
    `<a / >`,
    `<a></a >x`,
    `<a></a`,
    `<a b="1"`,
    `<a b="1`,
    `<a b`,
    `<a =`,
    `<1/>`,
  ];
  for (const xml of cases) assertEquals(code(() => parseXml(xml)), "malformed_xml", xml);
  assertEquals(
    code(() => parseXml(new Uint8Array([0x3c, 0x61, 0xff, 0x2f, 0x3e]))),
    "malformed_xml",
  );
});

Deno.test("xml: caps size and depth", () => {
  const big = `<a>${"x".repeat(MAX_XML_BYTES)}</a>`;
  assertEquals(code(() => parseXml(big)), "malformed_xml");
  assertEquals(code(() => parseXml(new TextEncoder().encode(big))), "malformed_xml");
  // Under the UTF-16 length cap but over the UTF-8 byte cap.
  assertEquals(
    code(() => parseXml(`<a>${"é".repeat(MAX_XML_BYTES / 2 + 10)}</a>`)),
    "malformed_xml",
  );
  const nest = (n: number) => "<a>".repeat(n) + "</a>".repeat(n);
  parseXml(nest(MAX_XML_DEPTH));
  assertEquals(code(() => parseXml(nest(MAX_XML_DEPTH + 1))), "malformed_xml");
});

Deno.test("xml: isNcName is the xs:ID lexical space", () => {
  assertEquals(isNcName("_abc-1.2"), true);
  assertEquals(isNcName("1abc"), false);
  assertEquals(isNcName("a:b"), false);
  assertEquals(isNcName(""), false);
});

// --- exclusive c14n ------------------------------------------------------------------------

const W3C_1 = `<n0:local xmlns:n0="foo:bar" xmlns:n3="ftp://example.org">
  <n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
    <n3:stuff xmlns:n3="ftp://example.org"/>
  </n1:elem2>
</n0:local>`;
const W3C_2 =
  `<n2:pdu xmlns:n1="http://example.com" xmlns:n2="http://foo.example" xml:lang="fr" xml:space="retain">
  <n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
    <n3:stuff xmlns:n3="ftp://example.org"/>
  </n1:elem2>
</n2:pdu>`;
const ELEM2 = `<n1:elem2 xmlns:n1="http://example.net" xml:lang="en">
    <n3:stuff xmlns:n3="ftp://example.org"></n3:stuff>
  </n1:elem2>`;

Deno.test("c14n: the W3C exc-c14n §2.2 example canonicalizes identically in both contexts", () => {
  assertEquals(excC14n(child(parseXml(W3C_1).root, "elem2")), ELEM2);
  assertEquals(excC14n(child(parseXml(W3C_2).root, "elem2")), ELEM2);
});

Deno.test("c14n: InclusiveNamespaces PrefixList renders listed in-scope prefixes at the apex", () => {
  const elem2 = child(parseXml(W3C_2).root, "elem2");
  assertEquals(
    excC14n(elem2, { inclusivePrefixes: ["n2", "absent"] }),
    ELEM2.replace(
      `xmlns:n1="http://example.net"`,
      `xmlns:n1="http://example.net" xmlns:n2="http://foo.example"`,
    ),
  );
  const doc = parseXml(`<a xmlns="urn:x" xmlns:p="urn:p"><p:b><p:c/></p:b></a>`);
  assertEquals(
    excC14n(child(doc.root, "b"), { inclusivePrefixes: ["#default"] }),
    `<p:b xmlns="urn:x" xmlns:p="urn:p"><p:c></p:c></p:b>`,
  );
  // An inclusive default that is empty renders nothing.
  const bare = parseXml(`<a xmlns:p="urn:p"><p:b/></a>`);
  assertEquals(
    excC14n(child(bare.root, "b"), { inclusivePrefixes: ["#default"] }),
    `<p:b xmlns:p="urn:p"></p:b>`,
  );
});

Deno.test("c14n: default namespace undeclaration and redundant declarations", () => {
  const doc = parseXml(`<a xmlns="urn:x"><b xmlns=""><c/></b><d xmlns="urn:x"/></a>`);
  assertEquals(excC14n(doc.root), `<a xmlns="urn:x"><b xmlns=""><c></c></b><d></d></a>`);
  assertEquals(excC14n(child(doc.root, "b")), `<b><c></c></b>`);
});

Deno.test("c14n: attribute order, escaping, comments, PIs and exclusion", () => {
  const doc = parseXml(
    `<r xmlns:b="urn:b" xmlns:a="urn:a" z="1" b:y="2" a:y="3" a:x="4" q='"&lt;&#9;&#10;&#13;&amp;'>` +
      `&#13;&gt;<!--c--><?t?><?t d?><s>skip</s><k/></r>`,
  );
  const s = child(doc.root, "s");
  assertEquals(
    excC14n(doc.root, { exclude: s }),
    `<r xmlns:a="urn:a" xmlns:b="urn:b" q="&quot;&lt;&#x9;&#xA;&#xD;&amp;" z="1" a:x="4" a:y="3" b:y="2">` +
      `&#xD;&gt;<?t?><?t d?><k></k></r>`,
  );
  assertEquals(excC14n(doc.root, { withComments: true }).includes("<!--c-->"), true);
});

Deno.test("c14n: matches libxml2's xmllint --exc-c14n on a mixed document", async () => {
  const dir = new URL("./fixtures/saml/", import.meta.url);
  const input = await Deno.readTextFile(new URL("c14n-in.xml", dir));
  const oracle = await Deno.readTextFile(new URL("c14n-exc.txt", dir));
  const start = oracle.indexOf("<a:root");
  const end = oracle.indexOf("</a:root>") + "</a:root>".length;
  // xmllint keeps comments.
  assertEquals(excC14n(parseXml(input).root, { withComments: true }), oracle.slice(start, end));
});

Deno.test("c14n: code-point ordering, not UTF-16 unit ordering", () => {
  assertEquals(compareCodePoints("a", "a"), 0);
  assertEquals(compareCodePoints("a", "ab") < 0, true);
  assertEquals(compareCodePoints("ab", "a") > 0, true);
  // U+FF61 sorts before U+1D504 by code point (UTF-16 units would say the opposite).
  assertEquals(compareCodePoints("\uFF61", "\u{1D504}") < 0, true);
});
