// DevTools names for npm packages' custom hooks (src/build/npm-hook-meta.ts): the unbundled dev
// loop's npm dependency bundle appends a `__dnxMeta` footer to each package ES module that
// declares or re-exports a `use*` hook, and points `npm:<specifier>#*` at the module the
// specifier resolves to, so a hook the app imports by a bare specifier expands into its cells
// in the inspector instead of staying opaque.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { npmHookMetaPlugin, npmMetaKey, packageMetaFooter } from "../src/build/npm-hook-meta.ts";
import { collectComponentMeta } from "../src/build/devtools-meta.ts";
import { parseModule } from "../src/build/swc-ast.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useEffect, useState } from "../src/runtime/hooks.ts";
import { getInspectorTree } from "../src/client/devtools-inspect.ts";
import {
  clearComponentMeta,
  type ComponentDevMeta,
  registerComponentMeta,
} from "../src/client/devtools-meta.ts";
import { registerFamily } from "../src/client/refresh-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

Deno.test("npmMetaKey: bare package specifiers only", () => {
  assertEquals(npmMetaKey("swr"), "npm:swr");
  assertEquals(npmMetaKey("swr/infinite"), "npm:swr/infinite");
  assertEquals(npmMetaKey("@tanstack/react-query"), "npm:@tanstack/react-query");
  for (
    const spec of [
      "./a.ts",
      "../a",
      "/abs/a.js",
      "@/hooks/auth.ts",
      "~/x",
      "#internal",
      "node:fs",
      "npm:swr@2",
      "jsr:@std/path",
      "https://esm.sh/swr",
      "react",
      "react-dom/client",
      "denext/client",
      "next/navigation",
    ]
  ) assertEquals(npmMetaKey(spec), undefined, spec);
});

Deno.test("collectComponentMeta: an app module's package hook records npm:<specifier>", async () => {
  const src = [
    `import { useQuery } from "@tanstack/react-query";`,
    `export function List() {`,
    `  const result = useQuery({});`,
    `  return result;`,
    `}`,
  ].join("\n");
  const metas = collectComponentMeta((await parseModule(src))!, "file:///app/list.tsx", npmMetaKey);
  assertEquals(metas.List.hooks, [{
    hook: "useQuery",
    name: "result",
    line: 3,
    from: "npm:@tanstack/react-query",
  }]);
});

const PKG = "file:///p/node_modules/pkg/dist/";

Deno.test("packageMetaFooter: a package ES module's hooks, re-exports and package imports", async () => {
  const src = [
    `import { useState, useEffect } from "react";`,
    `import { useShared } from "other-pkg";`,
    `export { useAlias } from "./alias.js";`,
    `export * from "./more.js";`,
    `export function useCounter() {`,
    `  const [count] = useState(0);`,
    `  useEffect(() => {}, []);`,
    `  const shared = useShared();`,
    `  return count + shared;`,
    `}`,
    `export function Widget() { const [x] = useState(1); return x; }`,
  ].join("\n");
  const resolved: string[] = [];
  const footer = await packageMetaFooter(src, `${PKG}index.js`, (spec) => {
    resolved.push(spec);
    return Promise.resolve(spec === "other-pkg" ? "/p/node_modules/other-pkg/index.js" : undefined);
  }, ["npm:pkg"]);
  assertStringIncludes(footer, `from "denext/client-runtime"`);
  assertStringIncludes(footer, `__dnxMeta("npm:pkg#*"`);
  assertStringIncludes(footer, `"reExportsAll":["${PKG}index.js"]`);
  assertStringIncludes(footer, `__dnxMeta("${PKG}index.js#useCounter"`);
  assertStringIncludes(footer, `"from":"npm:other-pkg"`);
  assertStringIncludes(footer, `__dnxMeta("${PKG}index.js#useAlias"`);
  assertStringIncludes(footer, `"aliasOf":"${PKG}alias.js#useAlias"`);
  assertStringIncludes(footer, `__dnxMeta("${PKG}index.js#*"`);
  // The package specifier a hook came from points at the module it resolves to.
  assertEquals(resolved, ["other-pkg"]);
  assertStringIncludes(
    footer,
    `__dnxMeta("npm:other-pkg#*", {"name":"*","line":0,"column":0,"hooks":[],` +
      `"reExportsAll":["file:///p/node_modules/other-pkg/index.js"]});`,
  );
  // A package's components are not recorded: no family is ever registered for them.
  assert(!footer.includes("#Widget"));
});

Deno.test("packageMetaFooter: CommonJS, hook-free and unparsable modules are left as written", async () => {
  const none = () => Promise.resolve(undefined);
  const cjs = `const { useState } = require("react");\n` +
    `exports.useCounter = function useCounter() { return useState(0); };\n`;
  assertEquals(await packageMetaFooter(cjs, `${PKG}cjs.js`, none, ["npm:pkg"]), "");
  assertEquals(await packageMetaFooter(`export const x = 1;\n`, `${PKG}x.js`, none), "");
  assertEquals(await packageMetaFooter(`export function useX( {\n`, `${PKG}bad.js`, none), "");
  // A hook-free ES entry point still records its specifier (its `export *` lines lead on).
  const entry = await packageMetaFooter(`export * from "./hooks.js";\n`, `${PKG}e.js`, none, [
    "npm:pkg",
  ]);
  assertStringIncludes(entry, `__dnxMeta("npm:pkg#*"`);
});

Deno.test("npmHookMetaPlugin: the dependency bundle carries the package's hook records", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_npm_hooks_" }));
  try {
    const pkg = join(dir, "node_modules", "hooks-pkg");
    await Deno.mkdir(join(pkg, "dist"), { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "hooks-pkg", type: "module", exports: "./dist/index.js" }),
    );
    await Deno.writeTextFile(
      join(pkg, "dist", "index.js"),
      `export { useToggle } from "./toggle.js";\n`,
    );
    await Deno.writeTextFile(
      join(pkg, "dist", "toggle.js"),
      `import { useState } from "react";\n` +
        `export function useToggle() {\n  const [on, setOn] = useState(false);\n` +
        `  return [on, () => setOn(!on)];\n}\n`,
    );
    const out = await esbuild.build({
      entryPoints: { hooks_pkg: "hooks-pkg" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      absWorkingDir: dir,
      logLevel: "silent",
      external: ["react", "denext/*"],
      plugins: [npmHookMetaPlugin(["hooks-pkg"], dir)],
    });
    const code = new TextDecoder().decode(out.outputFiles[0].contents);
    const index = toFileUrl(join(pkg, "dist", "index.js")).href;
    const toggle = toFileUrl(join(pkg, "dist", "toggle.js")).href;
    assertStringIncludes(code, `"npm:hooks-pkg#*"`);
    assertStringIncludes(code, JSON.stringify(index));
    assertStringIncludes(code, `${index}#useToggle`);
    assertStringIncludes(code, `${toggle}#useToggle`);
    assertStringIncludes(code.replaceAll(" ", ""), `"name":"on"`);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- The inspector: a package hook expands into its cells -------------------------------

const g = globalThis as { __denextDev?: boolean };

function Toggler(): VNode {
  const [on] = useToggleLike();
  const [label] = useState("x");
  return h("p", null, `${on}${label}`);
}
/** Stands in for `useToggle` from `hooks-pkg`: a state and an effect. */
function useToggleLike(): [boolean] {
  const [on] = useState(false);
  useEffect(() => {}, []);
  return [on];
}

Deno.test("named hooks: a package's custom hook expands through npm:<specifier>, entry and barrel", () => {
  const prev = g.__denextDev;
  g.__denextDev = true;
  try {
    const app = "file:///app/toggler.tsx";
    const entry = "file:///app/node_modules/hooks-pkg/dist/index.js";
    const decl = "file:///app/node_modules/hooks-pkg/dist/toggle.js";
    const rec = (m: Partial<ComponentDevMeta> & { name: string }): ComponentDevMeta => ({
      line: 0,
      column: 0,
      hooks: [],
      ...m,
    });
    registerComponentMeta(
      `${app}#Toggler`,
      rec({
        name: "Toggler",
        hooks: [
          { hook: "useToggle", name: "on", line: 2, from: "npm:hooks-pkg" },
          { hook: "useState", name: "label", line: 3 },
        ],
      }),
    );
    // What the npm bundle registers: the specifier → the entry, whose barrel aliases the hook,
    // through two more barrels (the package's own hops are not spent on the specifier).
    registerComponentMeta("npm:hooks-pkg#*", rec({ name: "*", reExportsAll: [entry] }));
    const hop = (n: number) => `file:///app/node_modules/hooks-pkg/dist/hop${n}.js`;
    registerComponentMeta(
      `${entry}#useToggle`,
      rec({ name: "useToggle", aliasOf: `${hop(1)}#useToggle` }),
    );
    registerComponentMeta(
      `${hop(1)}#useToggle`,
      rec({ name: "useToggle", aliasOf: `${hop(2)}#useToggle` }),
    );
    registerComponentMeta(
      `${hop(2)}#useToggle`,
      rec({ name: "useToggle", aliasOf: `${decl}#useToggle` }),
    );
    registerComponentMeta(
      `${decl}#useToggle`,
      rec({
        name: "useToggle",
        hooks: [
          { hook: "useState", name: "on", line: 2 },
          { hook: "useEffect", name: "", line: 3 },
        ],
      }),
    );
    registerFamily(Toggler, `${app}#Toggler`);
    const { doc, container } = makeDom();
    setDocument(asAny(doc));
    createRoot(asAny(container)).render(h(Toggler, null));
    flushSync();
    const node = getInspectorTree().find((n) => n.name === "Toggler")!;
    assertEquals(node.hooksNamed, true);
    assertEquals(node.hooks.map((hk) => hk.hook), [
      "useToggle › useState",
      "useToggle › useEffect",
      "useState",
    ]);
    assertEquals(node.hooks.map((hk) => hk.name), ["useToggle › on", undefined, "label"]);
  } finally {
    g.__denextDev = prev;
    clearComponentMeta();
  }
});
