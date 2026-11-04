// The runtime reference (`/docs/runtime-reference`): one page listing what denext's Deno adds to
// stock Deno. It must be reachable (nav, page wrapper), say how to tell the runtime apart, and name
// the runtime version denext actually pins, so a pin move that forgets the page fails here.

import { assert, assertStringIncludes } from "@std/assert";
import { NAV } from "../site/components/ui.tsx";
import pin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

const DIR = new URL("../site/app/docs/runtime-reference/", import.meta.url);
const page = () => Deno.readTextFile(new URL("content.md", DIR));

Deno.test("runtime reference: the page is in the docs nav and has its wrapper", async () => {
  assert(NAV.some((g) => g.items.some((i) => i.slug === "runtime-reference")), "in the docs nav");
  assertStringIncludes(await Deno.readTextFile(new URL("page.tsx", DIR)), "./content.md");
  assertStringIncludes(await page(), "slug: runtime-reference");
});

Deno.test("runtime reference: says how to tell the runtime apart, and names the pinned build", async () => {
  const md = await page();
  assertStringIncludes(md, "Deno.build.denext");
  assertStringIncludes(md, "denext <version> (Brainwires)");
  assertStringIncludes(md, `denext 4.x pins \`${pin.version}\``);
  assert(!/\bitems? \d/i.test(md), "public text describes changes, not the fork's item numbers");
});

Deno.test("runtime reference: every area has its section", async () => {
  const md = await page();
  for (
    const heading of [
      "## Which runtime am I on?",
      "## JavaScript and TypeScript APIs",
      "## Command-line flags",
      "## Type checking and the editor",
      "## `deno test`: Vitest and Jest",
      "## Node.js and npm projects",
      "## npm supply chain",
      "## Permissions and network behavior",
      "## Caches, bundling and compiled programs",
      "## Environment variables",
      "## Deno Desktop APIs",
    ]
  ) assertStringIncludes(md, heading);
});

Deno.test("toolchain docs: rc.6-only jail features are labelled with their runtime", async () => {
  const md = await Deno.readTextFile(
    new URL("../site/app/docs/toolchain/content.md", import.meta.url),
  );
  assertStringIncludes(md, "## Supply chain: install gates");
  // `#versions` / `#identity` are linked from other pages; the renderer escapes a raw `<a id>`, so
  // they must be headings.
  assertStringIncludes(md, "\n### Versions\n");
  assertStringIncludes(md, "\n### Identity\n");
  assert(!md.includes("<a id="), "no raw anchors: the renderer escapes them");
  assertStringIncludes(md, "**What a host list holds (runtime `3.0.0-rc.6`).**");
  assertStringIncludes(md, "From runtime `3.0.0-rc.6` `net` also takes the hosts");
  assert(
    !md.includes("such as `curl`, can still reach any host"),
    "rc.6's proxy holds every program; the page must not say curl gets around a host list",
  );
});
