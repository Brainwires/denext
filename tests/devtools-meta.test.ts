// DevTools dev metadata — the AST pipeline (build) and its runtime registry (client).
//
// The dev transforms already parse every first-party module to emit Fast Refresh family
// registrations; this pass keeps the spans they used to discard. What is asserted here is
// mostly *exactness*: swc reports UTF-8 byte offsets, the inspector and every editor link
// want 1-based lines and 1-based UTF-16 columns, and the two only agree on pure ASCII —
// so the fixtures carry multi-byte identifiers, an emoji and a CRLF variant on purpose.
//
// The other half is containment: metadata is emitted ONLY by the two dev transforms (so a
// production bundle has no reference to `registerComponentMeta` at all), it is capped, and
// it can be switched off entirely with `DENEXT_DEV_META=0`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type * as esbuild from "esbuild";
import { join, toFileUrl } from "@std/path";
import {
  collectComponentMeta,
  MAX_HOOKS,
  MAX_META_BYTES,
  META_IMPORT,
  metaFooter,
} from "../src/build/devtools-meta.ts";
import { generateRouteEntry } from "../src/build/bundle.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { ComponentDevMeta } from "../src/client/devtools-meta.ts";
import {
  collectComponents,
  refreshFooter,
  spaRefreshPlugin,
} from "../src/build/spa-refresh-plugin.ts";
import { spaSourceTransformPlugin } from "../src/build/spa-compiler-plugin.ts";
import type { ProjectPaths } from "../src/build/paths.ts";
import { encoder, lineIndex, parseModule, positionAt } from "../src/build/swc-ast.ts";
import { registerFamily } from "../src/client/refresh-runtime.ts";
import { createUnbundledState } from "../src/build/dev-unbundled/state.ts";
import { transform } from "../src/build/dev-unbundled/transform.ts";
import {
  clearComponentMeta,
  componentMetaById,
  componentMetaOf,
  registerComponentMeta,
} from "../src/client/devtools-meta.ts";

/** The metadata of a source string (the fixture must parse), as if it lived at `url`. */
async function metaOf(src: string, url?: string): Promise<Record<string, ComponentDevMeta>> {
  const parsed = await parseModule(src);
  assert(parsed, "fixture must parse");
  return collectComponentMeta(parsed, url);
}

// ---- positions --------------------------------------------------------------

Deno.test("positionAt: 1-based line, 1-based UTF-16 column, CRLF-safe", () => {
  const bytes = encoder.encode('const 名前 = "🎉";\r\nconst x = 1;\n');
  const idx = lineIndex(bytes);
  assertEquals(positionAt(bytes, idx, 0), { line: 1, column: 1 });
  // `名前` is 3 bytes per char but ONE UTF-16 unit each: the `=` sits at byte 13, column 10.
  assertEquals(bytes[13], 0x3d, "the fixture's `=` is at byte 13");
  assertEquals(positionAt(bytes, idx, 13), { line: 1, column: 10 });
  // Line 2 starts after the \n (the \r belongs to line 1, so it never shifts a column).
  assertEquals(positionAt(bytes, idx, idx[1]), { line: 2, column: 1 });
  assertEquals(positionAt(bytes, idx, idx[1] + 6), { line: 2, column: 7 });
  // Out-of-range offsets clamp instead of throwing.
  assertEquals(positionAt(bytes, idx, -5).line, 1);
  assertEquals(positionAt(bytes, idx, 10_000).line, idx.length);
});

/** Line 1 is a comment with multi-byte text; line 7 mixes an emoji literal with a component. */
const MULTIBYTE = [
  `// 🎉 license header — © 2026 デネクスト`,
  `const 名前 = 1;`,
  ``,
  `export function Counter() {`,
  `  const [count, setCount] = useState(名前);`,
  `}`,
  `const Tag = "🎉", Card = () => null;`,
  ``,
].join("\n");

Deno.test("collectComponentMeta: exact line/column past multi-byte text and an emoji", async () => {
  const metas = await metaOf(MULTIBYTE);
  assertEquals(Object.keys(metas).sort(), ["Card", "Counter"]);
  // `export function ` is 16 chars → the identifier starts at column 17 of line 4.
  assertEquals(metas.Counter.line, 4);
  assertEquals(metas.Counter.column, 17);
  assertEquals(metas.Counter.hooks, [{ hook: "useState", name: "count", line: 5 }]);
  // `const Tag = "🎉", ` — the emoji is ONE code point (two UTF-16 units) but FOUR bytes,
  // so a byte-based column would say 21 here. The UTF-16 column is 19.
  assertEquals(metas.Card.line, 7);
  assertEquals(metas.Card.column, 19);
});

Deno.test("collectComponentMeta: a CRLF module reports the same positions", async () => {
  const metas = await metaOf(MULTIBYTE.replace(/\n/g, "\r\n"));
  assertEquals(metas.Counter, {
    name: "Counter",
    line: 4,
    column: 17,
    hooks: [{ hook: "useState", name: "count", line: 5 }],
  });
  assertEquals({ line: metas.Card.line, column: metas.Card.column }, { line: 7, column: 19 });
});

Deno.test("collectComponentMeta: a license comment + directive prologue keep offsets exact", async () => {
  const src = [
    `// Copyright (c) 2026 — the license header the Module span would swallow.`,
    `/* a block comment */`,
    `"use client";`,
    `import { useState } from "denext";`,
    ``,
    `export function Panel() {`,
    `  const [open] = useState(false);`,
    `  return null;`,
    `}`,
  ].join("\n");
  const metas = await metaOf(src);
  assertEquals(metas.Panel.line, 6);
  assertEquals(metas.Panel.column, 17);
  assertEquals(metas.Panel.hooks, [{ hook: "useState", name: "open", line: 7 }]);
});

// ---- hook naming ------------------------------------------------------------

Deno.test("collectComponentMeta: every binding-pattern shape gets its label", async () => {
  const src = [
    `export function Rows() {`,
    `  const [count, setCount] = useState(0);`, // array → first element
    `  const [, setOnly] = useState(1);`, // array with a hole → first NON-hole
    `  const ref = useRef(null);`, // identifier
    `  const { data } = useApi("/a");`, // object shorthand → the property
    `  const { data: d } = useApi("/b");`, // object rename → the LOCAL name
    `  useEffect(() => {});`, // unbound → ""
    `  const memo = React.useMemo(() => 1, []);`, // member callee → the property name
    `  const notAHook = compute(useRef);`, // a hook passed as a value is not a call
    `  return null;`,
    `}`,
  ].join("\n");
  const metas = await metaOf(src);
  assertEquals(metas.Rows.hooks, [
    { hook: "useState", name: "count", line: 2 },
    { hook: "useState", name: "setOnly", line: 3 },
    { hook: "useRef", name: "ref", line: 4 },
    { hook: "useApi", name: "data", line: 5 },
    { hook: "useApi", name: "d", line: 6 },
    { hook: "useEffect", name: "", line: 7 },
    { hook: "useMemo", name: "memo", line: 8 },
  ]);
});

Deno.test("collectComponentMeta: same-module custom hooks are recorded for breadcrumb joins", async () => {
  const src = [
    `export function Profile() {`,
    `  const user = useAuth();`,
    `  return null;`,
    `}`,
    `export function useAuth() {`,
    `  const [count] = useState(0);`,
    `  return count;`,
    `}`,
  ].join("\n");
  const metas = await metaOf(src);
  // The call site keeps the hook's OWN name; the runtime expands it by looking up
  // `<fileUrl>#useAuth`, whose metadata is emitted right here.
  assertEquals(metas.Profile.hooks, [{ hook: "useAuth", name: "user", line: 2 }]);
  assertEquals(metas.useAuth.hooks, [{ hook: "useState", name: "count", line: 6 }]);
  // …but only the component is a Fast Refresh family.
  const parsed = await parseModule(src);
  assertEquals(collectComponents(parsed!).names, ["Profile"]);
});

Deno.test("collectComponentMeta: at most MAX_HOOKS hooks are recorded per component", async () => {
  const calls = Array.from({ length: MAX_HOOKS + 6 }, (_, i) => `  const v${i} = useState(${i});`);
  const metas = await metaOf([`export function Big() {`, ...calls, `}`].join("\n"));
  assertEquals(metas.Big.hooks.length, MAX_HOOKS);
  assertEquals(metas.Big.hooks[0].name, "v0");
});

// ---- custom hooks across a module boundary (`from`) -------------------------

const PROFILE_URL = "file:///app/ui/Profile.tsx";

/** A component calling three imported hooks — named, aliased and default — then a primitive. */
const IMPORTING = [
  `import { useAuth } from "./auth.ts";`,
  `import { useA as useAlias } from "../lib/hooks.tsx";`,
  `import useSession from "./session.ts";`,
  `export function Profile() {`,
  `  const user = useAuth();`,
  `  const { data } = useAlias();`,
  `  const s = useSession();`,
  `  const [n] = useState(0);`,
  `  return null;`,
  `}`,
].join("\n");

Deno.test("collectComponentMeta: a relative named import records `from` and the imported name", async () => {
  const metas = await metaOf(IMPORTING, PROFILE_URL);
  assertEquals(metas.Profile.hooks[0], {
    hook: "useAuth",
    name: "user",
    line: 5,
    from: "file:///app/ui/auth.ts",
  });
  // The primitive and every non-imported call keep the pre-2.5 shape (no `from` key at all).
  assertEquals(metas.Profile.hooks[3], { hook: "useState", name: "n", line: 8 });
  // Without the module's URL there is nothing to resolve against: no call records `from`.
  const blind = await metaOf(IMPORTING);
  assert(blind.Profile.hooks.every((hk) => !("from" in hk)), JSON.stringify(blind.Profile));
});

Deno.test("collectComponentMeta: an aliased import records the IMPORTED name", async () => {
  const metas = await metaOf(IMPORTING, PROFILE_URL);
  // `useAlias()` is `useA` in `../lib/hooks.tsx` — the importee's registry key is `#useA`.
  assertEquals(metas.Profile.hooks[1], {
    hook: "useA",
    name: "data",
    line: 6,
    from: "file:///app/lib/hooks.tsx",
  });
});

Deno.test("collectComponentMeta: a default import records `default`, which the importee aliases", async () => {
  const metas = await metaOf(IMPORTING, PROFILE_URL);
  assertEquals(metas.Profile.hooks[2], {
    hook: "default",
    name: "s",
    line: 7,
    from: "file:///app/ui/session.ts",
  });
  // The declaring side: each default-export form of a `use*` hook is ALSO keyed `default`.
  const body = `{ const [s] = useState(null); return s; }`;
  for (
    const src of [
      `export default function useSession() ${body}`,
      `function useSession() ${body}\nexport default useSession;`,
      `function useSession() ${body}\nexport { useSession as default };`,
    ]
  ) {
    const own = await metaOf(src, "file:///app/ui/session.ts");
    assertEquals(Object.keys(own).sort(), ["default", "useSession"], src);
    assertEquals(own.default, own.useSession, "the alias carries the declared name");
    assertStringIncludes(
      metaFooter(URL_A, own),
      `__dnxMeta("${URL_A}#default", {"name":"useSession"`,
    );
  }
  // A default-exported COMPONENT is never joined as a hook, so it is not aliased.
  const page = await metaOf(`export default function Page() { return null; }`, URL_A);
  assertEquals(Object.keys(page), ["Page"]);
});

Deno.test("collectComponentMeta: a bare / npm: / jsr: / URL specifier records no `from`", async () => {
  const src = [
    `import { useQuery } from "@tanstack/react-query";`,
    `import { useNpm } from "npm:some-hooks";`,
    `import { useJsr } from "jsr:@scope/hooks";`,
    `import { useUrl } from "https://esm.sh/hooks";`,
    `import { useState } from "denext";`,
    `export function List() {`,
    `  const q = useQuery(); const a = useNpm(); const b = useJsr(); const c = useUrl();`,
    `  const [n] = useState(0);`,
    `  return null;`,
    `}`,
  ].join("\n");
  const metas = await metaOf(src, PROFILE_URL);
  assertEquals(metas.List.hooks.map((hk) => hk.hook), [
    "useQuery",
    "useNpm",
    "useJsr",
    "useUrl",
    "useState",
  ]);
  assert(metas.List.hooks.every((hk) => !("from" in hk)), "naming stops at a package hook");
});

Deno.test("collectComponentMeta: a namespace import stays opaque (no `from`)", async () => {
  const src = [
    `import * as auth from "./auth.ts";`,
    `import type { useTyped } from "./typed.ts";`,
    `export function Profile() {`,
    `  const user = auth.useAuth();`,
    `  return null;`,
    `}`,
  ].join("\n");
  const metas = await metaOf(src, PROFILE_URL);
  assertEquals(metas.Profile.hooks, [{ hook: "useAuth", name: "user", line: 4 }]);
});

// ---- the emitted footer -----------------------------------------------------

const URL_A = "file:///app/Counter.tsx";

Deno.test("metaFooter: one __dnxMeta per declaration, nothing for an empty module", () => {
  const metas: Record<string, ComponentDevMeta> = {
    Counter: { name: "Counter", line: 4, column: 17, hooks: [] },
    useAuth: { name: "useAuth", line: 9, column: 17, hooks: [] },
  };
  const footer = metaFooter(URL_A, metas);
  assertStringIncludes(
    footer,
    `import { registerComponentMeta as __dnxMeta } from "denext/client-runtime";`,
  );
  assertEquals(footer.match(/__dnxMeta\(/g)?.length, 2);
  assertStringIncludes(footer, `__dnxMeta("file:///app/Counter.tsx#Counter",`);
  assertStringIncludes(footer, `__dnxMeta("file:///app/Counter.tsx#useAuth",`);
  assertEquals(metaFooter(URL_A, {}), "", "nothing declared → no import, no calls");
});

Deno.test("metaFooter: a module over the size cap emits no metadata at all", () => {
  const metas: Record<string, ComponentDevMeta> = {};
  for (let i = 0; i < 400; i++) {
    metas[`ComponentWithARatherLongName${i}`] = {
      name: `ComponentWithARatherLongName${i}`,
      line: i + 1,
      column: 17,
      hooks: [{ hook: "useState", name: `someRatherLongBindingName${i}`, line: i + 2 }],
    };
  }
  assert(JSON.stringify(metas).length > MAX_META_BYTES, "the fixture must exceed the cap");
  assertEquals(metaFooter(URL_A, metas), "");
});

Deno.test("metaFooter: the 16 KB cap counts UTF-8 BYTES, not UTF-16 code units", () => {
  // A module of CJK component names measures ~3× larger on the wire than in code units.
  // Counting `.length` let such a module blow past the cap it is supposed to enforce.
  const metas: Record<string, ComponentDevMeta> = {};
  for (let i = 0; i < 30; i++) {
    const name = `名${"前".repeat(200)}${i}`;
    metas[name] = { name, line: i + 1, column: 1, hooks: [] };
  }
  const body = Object.entries(metas)
    .map(([name, meta]) =>
      `__dnxMeta(${JSON.stringify(`${URL_A}#${name}`)}, ${JSON.stringify(meta)});`
    )
    .join("\n");
  assert(body.length < MAX_META_BYTES, `under the cap in code units (${body.length})`);
  assert(
    encoder.encode(body).length > MAX_META_BYTES,
    `but over it in UTF-8 bytes (${encoder.encode(body).length})`,
  );
  assertEquals(metaFooter(URL_A, metas), "");
});

Deno.test("metaFooter: `from` URLs count toward the 16 KB cap", () => {
  const deep = `file:///app/${"nested/".repeat(40)}auth.ts`;
  const hooks = Array.from({ length: MAX_HOOKS }, (_, i) => ({
    hook: "useAuth",
    name: `v${i}`,
    line: i + 2,
  }));
  const plain = { Big: { name: "Big", line: 1, column: 1, hooks } };
  assert(metaFooter(URL_A, plain) !== "", "the same module without `from` is under the cap");
  const imported = { Big: { ...plain.Big, hooks: hooks.map((hk) => ({ ...hk, from: deep })) } };
  assertEquals(metaFooter(URL_A, imported), "");
});

Deno.test("metaFooter: DENEXT_DEV_META=0 is a kill switch (registrations are untouched)", () => {
  const metas: Record<string, ComponentDevMeta> = {
    Counter: { name: "Counter", line: 1, column: 1, hooks: [] },
  };
  const prev = Deno.env.get("DENEXT_DEV_META");
  try {
    Deno.env.set("DENEXT_DEV_META", "0");
    assertEquals(metaFooter(URL_A, metas), "");
    const footer = refreshFooter(URL_A, ["Counter"], metas);
    assertStringIncludes(footer, `__dnxRegisterFamily(Counter,`);
    assert(!footer.includes("__dnxMeta"), "the kill switch drops only the metadata sidecar");
  } finally {
    if (prev === undefined) Deno.env.delete("DENEXT_DEV_META");
    else Deno.env.set("DENEXT_DEV_META", prev);
  }
});

Deno.test("refreshFooter: the metadata sidecar rides next to registerFamily", async () => {
  const parsed = await parseModule(MULTIBYTE);
  const { names, metas } = collectComponents(parsed!);
  const footer = refreshFooter(URL_A, names, metas);
  // `registerFamily` keeps its frozen 2.0 two-argument shape — the metadata is a sidecar call.
  assertStringIncludes(footer, `__dnxRegisterFamily(Counter, "file:///app/Counter.tsx#Counter");`);
  assertStringIncludes(footer, `__dnxMeta("file:///app/Counter.tsx#Counter", {"name":"Counter"`);
  assert(
    footer.indexOf("__dnxRegisterFamily(") < footer.indexOf("__dnxMeta("),
    "families register before their metadata",
  );
  // Without metadata the footer is byte-for-byte the pre-2.5 one.
  assert(!refreshFooter(URL_A, names).includes("__dnxMeta"));
});

Deno.test("refreshFooter: a hooks-only module carries the metadata sidecar alone", async () => {
  const src = `export function useAuth() { const [u] = useState(0); return u; }`;
  const { names, metas } = collectComponents((await parseModule(src))!, URL_A);
  assertEquals(names, []);
  const footer = refreshFooter(URL_A, names, metas);
  assertStringIncludes(footer, `__dnxMeta("${URL_A}#useAuth",`);
  assert(!footer.includes("registerFamily"), "no component ⇒ no family registration");
  assertEquals(refreshFooter(URL_A, [], {}), "", "nothing declared ⇒ no footer at all");
});

// ---- the dev transform, and the production guard ----------------------------

type LoadArgs = { path: string };
type LoadResult = { contents: string } | null | undefined;

/** Drive an esbuild plugin's `onLoad` directly (the plugins under test register only one). */
function onLoadOf(plugin: esbuild.Plugin): (args: LoadArgs) => Promise<LoadResult> {
  let fn: ((args: LoadArgs) => Promise<LoadResult>) | undefined;
  plugin.setup(
    {
      onLoad: (_filter: unknown, cb: (args: LoadArgs) => Promise<LoadResult>) => {
        fn = cb;
      },
      onResolve: () => {},
    } as unknown as esbuild.PluginBuild,
  );
  assert(fn, "the plugin registered no onLoad");
  return fn;
}

Deno.test("spaRefreshPlugin: instruments a component module, leaves an unparseable one alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-devtools-meta-" });
  try {
    const good = join(dir, "Counter.tsx");
    const bad = join(dir, "Broken.tsx");
    await Deno.writeTextFile(good, MULTIBYTE);
    await Deno.writeTextFile(bad, `export function Oops( { const = ; <<<`);
    const load = onLoadOf(spaRefreshPlugin(dir));

    const out = (await load({ path: good }))!.contents;
    assertStringIncludes(
      out,
      `__dnxRegisterFamily(Counter, ${
        JSON.stringify(
          `${toFileUrl(good).href}#Counter`,
        )
      });`,
    );
    assertStringIncludes(out, `__dnxMeta(${JSON.stringify(`${toFileUrl(good).href}#Counter`)},`);

    const broken = await load({ path: bad });
    assertEquals(
      broken!.contents,
      `export function Oops( { const = ; <<<`,
      "an unparseable module is served exactly as written",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The `__dnxMeta` family ids a transformed module registers (either transform's output). */
function registeredIds(code: string): string[] {
  return [...code.matchAll(/(?:__dnxMeta|registerComponentMeta)\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** The `from` URLs a transformed module's metadata records. */
function recordedFroms(code: string): string[] {
  return [...code.matchAll(/"from":\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** A hooks-only module (with a space and non-ASCII in its path) and a component importing it. */
async function crossModuleFixture(dir: string): Promise<{ hooks: string; comp: string }> {
  await Deno.mkdir(join(dir, "my hooks"));
  const hooks = join(dir, "my hooks", "認証.tsx");
  const comp = join(dir, "Profile.tsx");
  await Deno.writeTextFile(
    hooks,
    `import { useState } from "denext";\nexport function useAuth() { const [u] = useState(0); return u; }\n`,
  );
  await Deno.writeTextFile(
    comp,
    `import { useAuth } from "./my hooks/認証.tsx";\nexport function Profile() { const user = useAuth(); return null; }\n`,
  );
  return { hooks, comp };
}

Deno.test("spaRefreshPlugin: an import's `from` is exactly the importee's family-id prefix", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-devtools-from-" });
  try {
    const { hooks, comp } = await crossModuleFixture(dir);
    const load = onLoadOf(spaRefreshPlugin(dir));
    const [from] = recordedFroms((await load({ path: comp }))!.contents);
    const hooksOut = (await load({ path: hooks }))!.contents;
    assertEquals(from, toFileUrl(hooks).href);
    assertEquals(registeredIds(hooksOut), [`${from}#useAuth`]);
    assert(!hooksOut.includes("__dnxRegisterFamily("), "a hooks-only module registers no family");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unbundled transform: an import's `from` is exactly the importee's family-id prefix", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-devtools-from-" }));
  try {
    const { hooks, comp } = await crossModuleFixture(dir);
    const st = createUnbundledState({
      projectDir: dir,
      appDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, "out"),
    });
    const compOut = await transform(st, comp);
    const hooksOut = await transform(st, hooks);
    const [from] = recordedFroms(compOut.code);
    assertEquals(from, toFileUrl(hooks).href);
    assertEquals(registeredIds(hooksOut.code), [`${from}#useAuth`]);
    // The sidecar never makes a hooks-only module an HMR boundary: edits still propagate.
    assertEquals(compOut.selfAccepting, true);
    assertEquals(hooksOut.selfAccepting, false);
    assert(!st.accepting.has(hooks));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Symbols no production module may contain (each is counted, and the count must be 0). */
const DEVTOOLS_SYMBOLS = [
  "__dnxMeta",
  "registerComponentMeta",
  "__dnxRegisterFamily",
  "installDevtools",
  "devtools-panel",
];

/** How many times `symbol` occurs in `code`. */
const occurrences = (code: string, symbol: string): number => code.split(symbol).length - 1;

Deno.test("production SPA transforms emit no DevTools metadata (DCE guard)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-devtools-prod-" });
  try {
    const file = join(dir, "Counter.tsx");
    await Deno.writeTextFile(file, MULTIBYTE);
    // The prod SPA plugin set is the source-transform plugin ONLY (spa/bundle.ts adds
    // spaRefreshPlugin exclusively on the dev branch) — it must emit neither symbol.
    const plugin = spaSourceTransformPlugin(
      dir,
      {
        experimental: { features: { SOMETHING: true } },
      } as ProjectPaths["config"],
    );
    assert(plugin, "the feature fold is enabled for this fixture config");
    const out = (await onLoadOf(plugin)({ path: file }))!.contents;
    for (const symbol of DEVTOOLS_SYMBOLS) {
      assertEquals(occurrences(out, symbol), 0, `${symbol} must never reach a production module`);
    }
    // And the wiring itself: the refresh (hence metadata) plugin is dev-gated at its one call site.
    const bundleSrc = await Deno.readTextFile(
      new URL("../src/build/spa/bundle.ts", import.meta.url),
    );
    assertStringIncludes(bundleSrc, "if (dev) return [spaRefreshPlugin(projectDir)];");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("production App Router route entries emit no DevTools metadata (DCE guard)", async () => {
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: "/app/page.tsx",
    layoutChain: ["/app/layout.tsx"],
    templateChain: [],
    loading: "/app/loading.tsx",
    error: "/app/error.tsx",
    notFound: null,
    forbidden: null,
    unauthorized: null,
  };
  // Even when a footer is (wrongly) handed to a production entry, it must not be emitted.
  const devMetaFooter = `${META_IMPORT}__dnxMeta("file:///app/page.tsx#default", {});\n`;
  const entries = [
    generateRouteEntry(route, { devMetaFooter }),
    generateRouteEntry(route, {
      devMetaFooter,
      classRuntime: "eager",
      usesActivity: true,
      usesViewTransition: true,
      instrumentationClient: "/app/instrumentation-client.ts",
    }),
  ];
  for (const entry of entries) {
    for (const symbol of DEVTOOLS_SYMBOLS) {
      assertEquals(occurrences(entry, symbol), 0, `${symbol} in a production route entry`);
    }
  }
  // And the wiring: only the dev server's bundled route path computes the footer — the
  // production build/export call sites never reference it.
  for (
    const rel of [
      "build-pipeline/routes.ts",
      "build-pipeline/compat.ts",
      "export-pipeline/assets.ts",
    ]
  ) {
    const src = await Deno.readTextFile(new URL(`../src/build/${rel}`, import.meta.url));
    assertEquals(occurrences(src, "devMetaFooter") + occurrences(src, "routeDevMeta"), 0, rel);
  }
});

// ---- the runtime registry ---------------------------------------------------

Deno.test("registry: metadata joins a live component type through its family id", () => {
  clearComponentMeta();
  try {
    const Counter = () => null;
    const meta: ComponentDevMeta = {
      name: "Counter",
      line: 4,
      column: 17,
      hooks: [{ hook: "useState", name: "count", line: 5 }],
    };
    const id = `${URL_A}#Counter`;
    assertEquals(componentMetaOf(Counter), undefined, "unregistered → undefined");

    registerFamily(Counter, id);
    registerComponentMeta(id, meta);
    assertEquals(componentMetaOf(Counter), meta);
    assertEquals(componentMetaById(id), meta);
    assertEquals(componentMetaById(`${URL_A}#Nope`), undefined);
    assertEquals(componentMetaOf(undefined), undefined, "a non-component type never throws");

    // A re-imported edit re-registers both: the newest position wins for the new ref.
    const CounterV2 = () => null;
    const edited: ComponentDevMeta = { ...meta, line: 9 };
    registerFamily(CounterV2, id);
    registerComponentMeta(id, edited);
    assertEquals(componentMetaOf(CounterV2), edited);
    assertEquals(componentMetaOf(Counter), edited, "both refs share the family's metadata");
  } finally {
    clearComponentMeta();
  }
});

Deno.test("collectComponentMeta: an import-map alias records `from` through the resolver", async () => {
  const src = [
    `import { useAuth } from "@/hooks/auth.ts";`,
    `export function Profile() {`,
    `  const user = useAuth();`,
    `  return null;`,
    `}`,
  ].join("\n");
  const resolve = (spec: string) =>
    spec === "@/hooks/auth.ts" ? "file:///app/src/hooks/auth.ts" : undefined;
  const metas = collectComponentMeta((await parseModule(src))!, PROFILE_URL, resolve);
  assertEquals(metas.Profile.hooks[0], {
    hook: "useAuth",
    name: "user",
    line: 3,
    from: "file:///app/src/hooks/auth.ts",
  });
});

Deno.test("collectComponentMeta: a barrel's named hook re-exports become aliases (not components, not export *)", async () => {
  const src = [
    `export { useAuth } from "./use-auth.ts";`,
    `export { useA as useAlias } from "./a.ts";`,
    `export { Button } from "./button.tsx";`,
    `export * from "./star.ts";`,
  ].join("\n");
  const metas = collectComponentMeta((await parseModule(src))!, "file:///app/hooks/index.ts");
  assertEquals(metas, {
    useAuth: {
      name: "useAuth",
      line: 0,
      column: 0,
      hooks: [],
      aliasOf: "file:///app/hooks/use-auth.ts#useAuth",
    },
    useAlias: {
      name: "useAlias",
      line: 0,
      column: 0,
      hooks: [],
      aliasOf: "file:///app/hooks/a.ts#useA",
    },
  });
});

Deno.test("unbundled transform: a hook imported through an import-map alias records the aliased module", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-devtools-alias-" }));
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "@/": "./src/" } }),
    );
    const hooks = join(dir, "src", "auth.ts");
    await Deno.writeTextFile(
      hooks,
      `import { useState } from "denext";\nexport function useAuth() {\n  const [user] = useState(null);\n  return user;\n}\n`,
    );
    const comp = join(dir, "profile.tsx");
    await Deno.writeTextFile(
      comp,
      `import { useAuth } from "@/auth.ts";\nexport function Profile() {\n  const user = useAuth();\n  return <p>{String(user)}</p>;\n}\n`,
    );
    const st = createUnbundledState({
      projectDir: dir,
      appDir: dir,
      configPath: join(dir, "deno.json"),
      outDir: join(dir, "out"),
    });
    const compOut = await transform(st, comp);
    assertEquals(recordedFroms(compOut.code), [toFileUrl(hooks).href]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
