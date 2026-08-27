import { assert, assertStringIncludes } from "@std/assert";
import { compileMdxSource } from "../src/build/next-compat.ts";

// A remark plugin is `() => (tree) => void` operating on the mdast. This one rewrites
// every inline-code node's value, so its effect is unmistakable in the compiled output.
// (mdast nodes are walked as `any` — unified types aren't needed for this minimal test.)
function remarkShout() {
  // deno-lint-ignore no-explicit-any
  return (tree: any) => {
    // deno-lint-ignore no-explicit-any
    const visit = (node: any) => {
      if (node.type === "inlineCode") node.value = "SHOUTED:" + node.value;
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(tree);
  };
}

Deno.test("compileMdxSource baseline: plain MDX compiles to a JS module (denext jsx runtime)", async () => {
  const js = await compileMdxSource("x.mdx", "# Hi\n\nSome `code` here.\n");
  // Automatic runtime pointed at react (aliased to denext downstream).
  assertStringIncludes(js, "react/jsx-runtime");
  // The heading text survives into the compiled component.
  assertStringIncludes(js, "Hi");
  // Baseline: no plugin transform ran, so the raw code text is intact.
  assertStringIncludes(js, "code");
  assert(!js.includes("SHOUTED:"), "no plugin configured → no transform");
});

Deno.test("compileMdxSource threads a configured remark plugin into MDX compile", async () => {
  const js = await compileMdxSource("x.mdx", "Some `code` here.\n", {
    remarkPlugins: [remarkShout],
  });
  // The plugin ran during compilation — its rewrite is baked into the output.
  assertStringIncludes(js, "SHOUTED:code");
});

Deno.test("compileMdxSource accepts a [plugin, options] tuple", async () => {
  // A parameterized plugin: the tuple form `[plugin, options]` must be forwarded intact.
  // deno-lint-ignore no-explicit-any
  const remarkPrefix = (opts: { prefix: string }) => (tree: any) => {
    // deno-lint-ignore no-explicit-any
    const visit = (node: any) => {
      if (node.type === "inlineCode") node.value = opts.prefix + node.value;
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(tree);
  };
  const js = await compileMdxSource("x.mdx", "Some `code`.\n", {
    remarkPlugins: [[remarkPrefix, { prefix: "P>" }]],
  });
  assertStringIncludes(js, "P>code");
});

Deno.test("compileMdxSource ignores empty plugin arrays (baseline path)", async () => {
  // An empty list must not be forwarded as a non-undefined `[]` (harmless, but the
  // pluggable() guard normalizes it away) — output matches the no-opts baseline.
  const js = await compileMdxSource("x.mdx", "Some `code`.\n", {
    remarkPlugins: [],
    rehypePlugins: [],
    recmaPlugins: [],
  });
  assertStringIncludes(js, "code");
  assert(!js.includes("SHOUTED:"));
});
