// Static-route detection: does a page route need a client hydration bundle, or
// can it ship as pure server-rendered HTML with zero JavaScript? The crawler and
// file reader are injected so these run without spawning `deno info`.

import { assert, assertEquals } from "@std/assert";
import { routeNeedsHydration } from "../src/build/hydration.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

function route(filePath: string, extra: Partial<PageRoute> = {}): PageRoute {
  return {
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/x",
    filePath,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    ...extra,
  } as PageRoute;
}

/** A checker with a fixed source per file basename and no extra crawled modules. */
function withSources(sources: Record<string, string>, crawled: string[] = []) {
  return {
    crawl: () => Promise.resolve(crawled),
    readFile: (p: string) => Promise.resolve(sources[p.split("/").pop() ?? p] ?? sources[p] ?? ""),
  };
}

Deno.test("static: a plain page with no interactivity ships no JS", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({ "page.tsx": `export default () => <main><h1>About</h1><p>hello</p></main>;` }),
  );
  assertEquals(need, false);
});

Deno.test("static: a <Link>-only page stays static (anchor works without JS)", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `import { Link } from "denext";
        export default () => <nav><Link href="/">Home</Link></nav>;`,
    }),
  );
  assertEquals(need, false);
});

Deno.test("static: pure hooks (useMemo/useCallback/useId) do not force hydration", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `import { useMemo, useId } from "denext";
        export default () => { const id = useId(); const v = useMemo(() => 1, []); return <p id={id}>{v}</p>; };`,
    }),
  );
  assertEquals(need, false);
});

Deno.test("static: interactivity tokens inside a code sample (string/comment) don't force hydration", async () => {
  // A docs page rendering `"use client"` / `onClick=` / `useState(` inside a
  // <Code> template literal (and a comment) must still ship zero JS.
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `import { Code } from "./ui.tsx";
        // Example: onClick={() => useState(0)} — this comment is not real code.
        export default () => (
          <Code>{\`"use client";
            export function B() { const [n] = useState(0); return <button onClick={() => n}>x</button>; }\`}</Code>
        );`,
    }),
  );
  assertEquals(need, false, "tokens only inside strings/comments are not interactivity");
});

Deno.test("interactive: real interactivity beside a code sample still forces hydration", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `import { Code } from "./ui.tsx";
        export default () => (
          <div onClick={() => 1}><Code>{\`const x = "onClick=nope";\`}</Code></div>
        );`,
    }),
  );
  assertEquals(need, true, "the real onClick outside the string still counts");
});

Deno.test("static: interactivity tokens inside a regex literal don't force hydration", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `export default function P({ s }: { s: string }) {
        const clean = s.replace(/onClick=|useState\\(/g, "");
        return <p>{clean}</p>;
      }`,
    }),
  );
  assertEquals(need, false, "tokens only inside a regex literal are not interactivity");
});

Deno.test("interactive: a real handler after a quote-containing regex is still detected", async () => {
  // The regex contains a quote. Before regex-literal lexing, that quote opened a
  // spurious "string" that blanked the real onInput below → false static → a page
  // shipped with a dead handler. The lexer must blank only the regex.
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `export default function Field() {
        const strip = (s: string) => s.replace(/['"]/g, "");
        return <input onInput={(e) => strip(e.currentTarget.value)} />;
      }`,
    }),
  );
  assertEquals(need, true, "the onInput handler after the quote-containing regex must be seen");
});

Deno.test("interactive: divisions before a handler are not misread as a regex", async () => {
  // `a / b / c` is division; if the first `/` were treated as a regex it would scan
  // to the `/` in `</button>`, blanking the onClick → false static.
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `export default function P({ a, b, c }: { a: number; b: number; c: number }) {
        const r = a / b / c;
        return <button onClick={() => r}>{r}</button>;
      }`,
    }),
  );
  assertEquals(need, true, "a / b / c is division, not a regex that would blank the handler");
});

Deno.test("static: JSX close/self-close slashes and {a}/{b} stay static", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx": `export default function P({ a, b }: { a: number; b: number }) {
        return <div><br />{a}/{b}<span>{a / b}</span></div>;
      }`,
    }),
  );
  assertEquals(need, false, "JSX slashes and division are not regex literals");
});

Deno.test("interactive: hooks, event handlers, and dynamic() each force hydration", async () => {
  const cases = [
    `import { useState } from "denext"; export default () => { const [n]=useState(0); return <p>{n}</p>; };`,
    `export default () => <button onClick={() => alert(1)}>x</button>;`,
    `import { useEffect } from "denext"; export default () => { useEffect(() => {}, []); return <p/>; };`,
    `import { dynamic } from "denext"; const L = dynamic(() => import("./i.tsx"), { ssr: false }); export default L;`,
  ];
  for (const src of cases) {
    const need = await routeNeedsHydration(route("page.tsx"), withSources({ "page.tsx": src }));
    assert(need, `expected hydration for: ${src.slice(0, 40)}…`);
  }
});

Deno.test("interactive: a signal in a transitively-imported component is caught", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx"),
    withSources({
      "page.tsx":
        `import Counter from "./counter.tsx"; export default () => <section><Counter/></section>;`,
      "counter.tsx":
        `import { useState } from "denext"; export default () => { const [n,s]=useState(0); return <button onClick={()=>s(n+1)}>{n}</button>; };`,
    }, ["counter.tsx"]),
  );
  assertEquals(need, true);
});

Deno.test("interactive: an interactive layout/error in the tree forces hydration", async () => {
  const need = await routeNeedsHydration(
    route("page.tsx", { error: "error.tsx" }),
    withSources({
      "page.tsx": `export default () => <h1>Static</h1>;`,
      "error.tsx": `export default ({ reset }) => <button onClick={reset}>Retry</button>;`,
    }),
  );
  assertEquals(need, true, "an interactive error boundary in the tree requires hydration");
});

Deno.test("fail-safe: hydrate when the graph can't be crawled or a module can't be read", async () => {
  const crawlFailed = await routeNeedsHydration(route("page.tsx"), {
    crawl: () => Promise.reject(new Error("deno info failed")),
    readFile: () => Promise.resolve(""),
  });
  assertEquals(crawlFailed, true);

  const readFailed = await routeNeedsHydration(route("page.tsx"), {
    crawl: () => Promise.resolve([]),
    readFile: () => Promise.reject(new Error("unreadable")),
  });
  assertEquals(readFailed, true);
});
