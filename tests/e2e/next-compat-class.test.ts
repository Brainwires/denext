// e2e: the class-component build gate. Proves (1) a class renders when
// classComponents is on, (2) the class runtime is DCE'd out when off — the
// zero-cost headline guarantee, and (3) using a class with the flag off throws a
// guided error. Needs esbuild (build-time); CI-excluded like other e2e.

import { assert, assertStringIncludes } from "@std/assert";
import { buildNextCompatPages, renderNextCompatPage } from "../../src/build/next-compat-build.ts";

// A distinctive symbol from the HEAVY, gated runtime (class-component.ts) — reachable
// only via the gated renderClassInstance/renderClassToVNode, so it is DCE'd when off.
// (Not the `isReactComponent` brand: that lives in the tiny always-present detector
// class-detect.ts, which stays in both builds to give a guided error when a class is
// used with the flag off — that path is exercised by the third test.)
const CLASS_RUNTIME_MARKER = "instantiateClass";

async function scaffold(page: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncclass_" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  );
  await Deno.writeTextFile(`${dir}/page.tsx`, page);
  return dir;
}

const FUNCTION_PAGE = `import { createElement as h, useState } from "react";
export default function Page() {
  const [n] = useState(3);
  return h("p", null, "fn:" + n);
}
`;

const CLASS_PAGE = `import { Component, createElement as h } from "react";
class Hello extends Component {
  override render() { return h("h1", null, "Hello from a class"); }
}
export default function Page() { return h(Hello, null); }
`;

Deno.test("class gate: OFF build DCEs the class runtime (zero cost)", async () => {
  const dir = await scaffold(FUNCTION_PAGE);
  try {
    const [page] = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
      // classComponents omitted → off (default)
    });
    const client = await Deno.readTextFile(page.clientBundle);
    const server = await Deno.readTextFile(page.serverBundle);
    assert(
      !client.includes(CLASS_RUNTIME_MARKER),
      "class runtime must be absent from the OFF client bundle",
    );
    assert(
      !server.includes(CLASS_RUNTIME_MARKER),
      "class runtime must be absent from the OFF server bundle",
    );
    // The function page still works.
    const html = await renderNextCompatPage(page, {}, "/c.js");
    assertStringIncludes(html, "fn:3");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("class gate: ON build renders a class + includes the class runtime", async () => {
  const dir = await scaffold(CLASS_PAGE);
  try {
    const [page] = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
      classComponents: true,
    });
    const html = await renderNextCompatPage(page, {}, "/c.js");
    assertStringIncludes(html, "Hello from a class");
    const client = await Deno.readTextFile(page.clientBundle);
    assert(client.includes(CLASS_RUNTIME_MARKER), "class runtime present in the ON build");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("class gate: using a class with the flag OFF throws a guided error", async () => {
  const dir = await scaffold(CLASS_PAGE);
  try {
    const [page] = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
      // off
    });
    let msg = "";
    try {
      await renderNextCompatPage(page, {}, "/c.js");
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "classComponents: true", "guided error names the fix");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
