// The literal/comment stripper behind the hydration scan and the server-only signals: it
// blanks the interior of strings, template text, regex literals, comments and JSX text, and
// keeps real code — so a token quoted in a docs sample or written in prose never reads as
// code, and a real hook after that prose is never hidden.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  serverOnlySignals,
  sourceMayContainJsx,
  stripLiteralsAndComments,
} from "../src/build/server-only-scan.ts";

/** Strip, and assert the result keeps the source's length and line structure. */
function strip(src: string, jsx = true): string {
  const out = stripLiteralsAndComments(src, { jsx });
  assertEquals(out.length, src.length, "offsets into the result index the source");
  assertEquals(out.split("\n").length, src.split("\n").length, "newlines survive");
  return out;
}

Deno.test("strip: apostrophes and quotes in JSX text are prose, not string delimiters", () => {
  const out = strip(
    `export default () => <p>It's ready, don't "wait"</p>;\nconst a = useState(0);`,
  );
  assertFalse(out.includes("It"), "JSX text is blanked");
  assert(out.includes("<p>") && out.includes("</p>"), "the tags stay as code");
  assert(out.includes("const a = useState(0);"), "code after the prose is still code");
});

Deno.test("strip: JSX attribute strings are blanked; attribute names and {…} values are code", () => {
  const out = strip(
    `const a = <div title="it's useState" data-q='say "onClick="' onClick={() => go("x")} />;`,
  );
  assertFalse(out.includes("useState"), "an attribute string's interior is blanked");
  assertEquals(out.match(/onClick=/g)?.length, 1, "only the real handler prop survives");
  assert(out.includes(`go(" ")`), "the {…} value is code; its own string is blanked");
});

Deno.test("strip: nested {} in JSX re-enters code and returns to JSX text", () => {
  const src = `const v = <ul>{items.map((i) => { return <li key={i}>{i}'s row</li>; })}` +
    `<li>Don't {"}"} stop</li></ul>; useRef();`;
  const out = strip(src);
  assert(out.includes("items.map((i) => { return <li key={i}>{i}"), "child expressions are code");
  assertFalse(out.includes("row") || out.includes("Don") || out.includes("stop"), "text blanked");
  assert(out.endsWith("useRef();"), "the element closes; what follows is code");
});

Deno.test("strip: template literals with ${} nesting, including JSX inside an interpolation", () => {
  const src = "const t = `<p>It's useState</p> ${n ? `in ${'`'} ${<b>x's</b>}` : ''} tail`;" +
    " useEffect();";
  const out = strip(src);
  assertFalse(out.includes("useState"), "template text is blanked, even when it looks like JSX");
  assert(out.includes("${n ? `"), "the ${…} expression is code");
  assert(out.includes("<b>") && !out.includes("x's"), "JSX in an interpolation is JSX");
  assert(out.endsWith("useEffect();"), "the outer template closes in step");
  const escaped = strip("const s = `a \\${useState} \\` b`; useRef();");
  assertFalse(escaped.includes("useState"), "an escaped \\${ is template text");
  assert(escaped.endsWith("useRef();"));
});

Deno.test("strip: regex literals containing quotes are blanked; division is not a regex", () => {
  const out = strip(`const r = /["'\`]/g; const q = a / b / c; useRef();`);
  assertFalse(out.includes(`"'`), "the regex body is blanked");
  assert(out.includes("a / b / c"), "division stays code");
  assert(out.endsWith("useRef();"), "the regex's quotes opened no string");
  const arrow = strip(`const f = (s) => /it's/.test(s); useRef();`);
  assert(arrow.endsWith("useRef();"), "a regex right after => is a regex");
});

Deno.test("strip: comments containing quotes are blanked, in code and in JSX", () => {
  const out = strip(`// it's "here\n/* don't ' */ const a = <p>{/* it's */}x</p>; useRef();`);
  assertFalse(out.includes("it") || out.includes("don"), "comment text is blanked");
  assert(out.endsWith("useRef();"));
  const url = strip(`const a = <a href="/x">https://example.com</a>; useRef();`);
  assert(url.endsWith("useRef();"), "a // in JSX text is prose, not a line comment");
});

Deno.test("strip: TSX generic arrows and comparisons are not JSX", () => {
  assert(strip(`const f = <T,>(x: T) => x; useRef();`).endsWith("useRef();"));
  assert(strip(`const f = <T extends object>(x: T) => x; useRef();`).endsWith("useRef();"));
  assert(strip(`if (a < b && c > d) useRef();`).endsWith("useRef();"));
  assert(strip(`const s = useState<string>(""); x;`).includes("useState<string>"));
});

Deno.test("strip: jsx:false reads a .ts type assertion as code, not an element", () => {
  const src = `const db = <Database>open("x"); Deno.env.get("K");`;
  assert(strip(src, false).includes(`open(" "); Deno.env.get(" ");`));
  assertEquals(serverOnlySignals(src, { jsx: false }), ["deno-global"]);
  assert(sourceMayContainJsx("app/page.tsx") && sourceMayContainJsx("a.jsx"));
  assert(sourceMayContainJsx("a.js"));
  assertFalse(sourceMayContainJsx("lib/db.ts") || sourceMayContainJsx("x.mts"));
});

Deno.test("strip: an unterminated literal blanks to the end (never fabricates a signal)", () => {
  assertFalse(strip(`const a = "useState(`).includes("useState"));
  assertFalse(strip("const a = `onClick=").includes("onClick"));
});
