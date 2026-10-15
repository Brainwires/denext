// Harden the vendored satori SVG serializer in `packages/og/lib/og.bundle.js`
// (GHSA-vcvr-r3jv-pc5j / CVE-2026-94545 — the Next.js `next/og` advisory).
//
// satori turns an inline `<svg>` child into a `data:image/svg+xml` image by concatenating
// its children and attribute values into markup WITHOUT escaping them, so a request value
// placed in an SVG `<title>`, attribute or style breaks out and injects arbitrary SVG into
// the document resvg rasterizes. Next.js fixed it by patching its vendored @vercel/og the
// same way this does: every element / attribute name is checked against the XML `Name`
// production, every attribute value and text node is escaped, the SVG serializer builds
// its elements through the (now escaping) element builder, and `&` joins the characters
// percent-encoded into the data URI.
//
// The bundle is generated (see packages/og/README.md "Vendoring"); run this after every
// regeneration. It is idempotent and fails loudly when an anchor moved, so a refreshed
// upstream can never silently ship unhardened.
//
//   deno run --allow-read --allow-write scripts/og-harden-svg.ts [bundle path]

const MARKER = "/* denext: hardened SVG serialization (GHSA-vcvr-r3jv-pc5j) */";

// The XML 1.0 `Name` production (NameStartChar NameChar*), as Next's patch uses.
const NAME_START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF" +
  "\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
const NAME_CHAR = NAME_START + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";

const HELPERS = `${MARKER}
var __denextXmlNameRe = new RegExp("^[${NAME_START}][${NAME_CHAR}]*$", "u");
var __denextXmlNames = /* @__PURE__ */ new Set();
function __denextXmlName(e, t) {
  if (__denextXmlNames.has(e)) return;
  if (typeof e != "string" || !__denextXmlNameRe.test(e)) throw new Error(\`Invalid XML \${t} name: \${JSON.stringify(e)}\`);
  __denextXmlNames.add(e);
}
function __denextXmlAttr(e) {
  return typeof e == "number" || typeof e == "bigint" || typeof e == "boolean" ? "" + e : (0, import_escape_html.default)(String(e));
}
function __denextXmlText(e) {
  return (0, import_escape_html.default)(String(e));
}
`;

/** One exact-text replacement; the anchor must occur exactly once. */
interface Patch {
  name: string;
  from: string;
  to: string;
}

const PATCHES: Patch[] = [
  {
    name: "element builder: validate names, escape attribute values",
    from: `function M(e, t, n) {
  let r = "";
  for (let [i, o] of Object.entries(t)) typeof o < "u" && (r += \` \${i}="\${o}"\`);
  return n ? \`<\${e}\${r}>\${n}</\${e}>\` : \`<\${e}\${r}/>\`;
}`,
    to: `${HELPERS}function M(e, t, n) {
  __denextXmlName(e, "element");
  let r = "";
  for (let [i, o] of Object.entries(t)) typeof o < "u" && (__denextXmlName(i, "attribute"), r += \` \${i}="\${__denextXmlAttr(o)}"\`);
  return n ? \`<\${e}\${r}>\${n}</\${e}>\` : \`<\${e}\${r}/>\`;
}`,
  },
  {
    name: "data-URI encoding also covers '&'",
    from: "var rd = /[\\r\\n%#()<>?[\\\\\\]^`{|}\"']/g;",
    to: "var rd = /[\\r\\n%#()<>?[\\\\\\]^`{|}\"'&]/g;",
  },
  {
    name: "inline <svg> children: escaped text, elements through the builder",
    from: `  if (typeof e != "object") return String(e);
  let n = e.type;
  if (n === "text") throw new Error("<text> nodes are not currently supported, please convert them to <path>");
  let { children: r, style: i, ...o } = e.props || {}, s = (i == null ? void 0 : i.color) || t, a = \`\${Object.entries(o).map(([f, l2]) => (typeof l2 == "string" && l2.toLowerCase() === "currentcolor" && (l2 = s), (f === "href" || f === "xlinkHref") && n === "image" ? \` \${zi[f] || f}="\${Ot.get(l2)[0]}"\` : \` \${zi[f] || f}="\${l2}"\`)).join("")}\`, u2 = i ? \` style="\${Object.entries(i).map(([f, l2]) => \`\${va(f)}:\${l2}\`).join(";")}"\` : "";
  return n === Ia ? Yn(r, s) : \`<\${n}\${a}\${u2}>\${Yn(r, s)}</\${n}>\`;
}`,
    to: `  if (typeof e != "object") return __denextXmlText(e);
  let n = e.type;
  if (n === "text") throw new Error("<text> nodes are not currently supported, please convert them to <path>");
  let { children: r, style: i, ...o } = e.props || {}, s = (i == null ? void 0 : i.color) || t;
  if (n === Ia) return Yn(r, s);
  if (typeof n != "string") throw new Error("Only intrinsic elements are supported inside <svg>");
  let a = {};
  for (let [f, l2] of Object.entries(o)) {
    typeof l2 == "string" && l2.toLowerCase() === "currentcolor" && (l2 = s);
    (f === "href" || f === "xlinkHref") && n === "image" && (l2 = Ot.get(l2)[0]);
    a[zi[f] || f] = l2;
  }
  i && (a.style = Object.entries(i).map(([f, l2]) => \`\${va(f)}:\${l2}\`).join(";"));
  return M(n, a, Yn(r, s));
}`,
  },
  {
    name: "the <svg> root: attributes through the builder",
    from:
      `  return i = i || h2 && o ? o / h2 : null, o = o || h2 && i ? i * h2 : null, f.width = i, f.height = o, n && (f.viewBox = n), \`data:image/svg+xml;utf8,\${\`<svg \${Object.entries(f).map(([m2, b]) => (typeof b == "string" && b.toLowerCase() === "currentcolor" && (b = l2), \` \${zi[m2] || m2}="\${b}"\`)).join("")}>\${Yn(u2, l2)}</svg>\`.replace(rd, encodeURIComponent)}\`;`,
    to:
      `  i = i || h2 && o ? o / h2 : null, o = o || h2 && i ? i * h2 : null, f.width = i, f.height = o, n && (f.viewBox = n);
  let m2 = {};
  for (let [y, b] of Object.entries(f)) m2[zi[y] || y] = typeof b == "string" && b.toLowerCase() === "currentcolor" ? l2 : b;
  return \`data:image/svg+xml;utf8,\${M("svg", m2, Yn(u2, l2)).replace(rd, encodeURIComponent)}\`;`,
  },
];

/**
 * Apply every patch to `source`. Already-hardened input is returned unchanged.
 *
 * @param source The bundle text.
 * @returns The hardened bundle text.
 * @throws Error when an anchor is missing or ambiguous.
 */
export function hardenOgBundle(source: string): string {
  if (source.includes(MARKER)) return source;
  let out = source;
  for (const patch of PATCHES) {
    const at = out.indexOf(patch.from);
    if (at < 0 || out.indexOf(patch.from, at + 1) >= 0) {
      throw new Error(`og-harden-svg: anchor for "${patch.name}" not found exactly once`);
    }
    out = out.slice(0, at) + patch.to + out.slice(at + patch.from.length);
  }
  return out;
}

if (import.meta.main) {
  const path = Deno.args[0] ??
    new URL("../packages/og/lib/og.bundle.js", import.meta.url).pathname;
  const before = await Deno.readTextFile(path);
  const after = hardenOgBundle(before);
  if (after === before) console.log("og-harden-svg: already hardened");
  else {
    await Deno.writeTextFile(path, after);
    console.log(`og-harden-svg: hardened ${path}`);
  }
}
