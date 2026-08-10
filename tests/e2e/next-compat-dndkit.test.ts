// e2e (Phase 1 breadth): prove dnd-kit — the last of pdq's core UI libs — runs on
// denext via next-compat. dnd-kit is heavy hook/context usage (DndContext +
// useDraggable). CI-excluded (needs npm + esbuild).

import { assert, assertStringIncludes } from "@std/assert";
import { buildNextCompatPages, renderNextCompatPage } from "../../src/build/next-compat-build.ts";

Deno.test("next-compat: @dnd-kit/core (DndContext + useDraggable) renders on denext", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncdnd_" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    );
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify({ dependencies: { "@dnd-kit/core": "6.3.1" } }),
    );
    await Deno.writeTextFile(
      `${dir}/page.tsx`,
      `import { createElement as h } from "react";
import { DndContext, useDraggable } from "@dnd-kit/core";
function Item() {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: "item-1" });
  return h("button", { ref: setNodeRef, ...attributes, ...listeners }, "Drag me");
}
export default function Page() {
  return h(DndContext, null, h("section", null, h(Item, null)));
}
`,
    );

    const install = await new Deno.Command(Deno.execPath(), {
      args: [
        "cache",
        "--no-lock",
        "--allow-scripts",
        "--config",
        `${dir}/deno.json`,
        "npm:@dnd-kit/core@6.3.1",
      ],
      cwd: dir,
    }).output();
    assert(install.success, "npm install failed");

    const [page] = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
    });
    const html = await renderNextCompatPage(page, {}, "/c.js");

    // DndContext (heavy context) + useDraggable (hooks) rendered the draggable —
    // dnd-kit sets aria/role attributes on draggables.
    assertStringIncludes(html, "<button");
    assertStringIncludes(html, "Drag me");
    assertStringIncludes(html, 'role="button"'); // dnd-kit draggable attribute
    assertStringIncludes(html, "aria-");

    const client = await Deno.readTextFile(page.clientBundle);
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
      "client bundle must be single-React",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
