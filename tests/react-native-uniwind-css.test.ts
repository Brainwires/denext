// React Native mode's uniwind stylesheet pass (src/build/react-native-uniwind-css.ts): what
// uniwind's lightningcss visitor does to the compiled Tailwind CSS — `pixelRatio()`,
// `fontScale()` and `hairlineWidth()`, theme variables on the theme's class, and theme-variant
// utilities inside `@scope` — over Tailwind 4's nested output and its `--minify` (flattened)
// output, and wired into buildAppCss through `withUniwindCss`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildAppCss, transformCss } from "../src/build/css.ts";
import {
  pixelRatioRules,
  replaceUniwindFunctions,
  splitSelectorList,
  uniwindCss,
} from "../src/build/react-native-uniwind-css.ts";
import { withUniwindCss } from "../src/build/react-native-uniwind.ts";
import type { DenextConfig } from "../src/server/config.ts";

const THEMES = ["light", "dark", "ocean"];

/** Tailwind 4.3's output for the classes below (nested, as without `--minify`). */
const NESTED = `/*! tailwindcss v4.3.0 | MIT License | https://tailwindcss.com */
@layer theme, base, components, utilities;
@layer theme {
  :root, :host {
    --color-surface: unset;
  }
}
@layer utilities {
  .w-\\[pixelRatio\\(2\\)\\] {
    width: pixelRatio(2);
  }
  .border-\\[length\\:hairlineWidth\\(\\)\\] {
    border-width: hairlineWidth();
  }
  .text-\\[length\\:fontScale\\(14\\)\\] {
    font-size: fontScale(14);
  }
  .dark\\:bg-red-500 {
    &:where(.dark, .dark *) {
      background-color: var(--color-red-500);
    }
    @media (prefers-color-scheme: dark) {
      &:not(:where(.light, .light *, .dark, .dark *, .ocean, .ocean *)) {
        background-color: var(--color-red-500);
      }
    }
  }
  .md\\:dark\\:text-white {
    @media (width >= 48rem) {
      &:where(.dark, .dark *) {
        color: var(--color-white);
      }
    }
  }
  .ocean\\:bg-blue-500 {
    &:where(.ocean, .ocean *) {
      background-color: var(--color-blue-500);
    }
  }
}
@layer theme {
  :root {
    &:where(.light, .light *) {
      --color-surface: #fff;
    }
    @media (prefers-color-scheme: dark) {
      &:not(:where(.light, .light *, .dark, .dark *, .ocean, .ocean *)) {
        --color-surface: #000;
      }
    }
    &:where(.dark, .dark *) {
      --color-surface: #000;
    }
    &:where(.ocean, .ocean *) {
      --color-surface: #036;
    }
  }
}
@property --tw-border-style {
  syntax: "*";
  inherits: false;
  initial-value: solid;
}
`;

/** The same stylesheet as `--minify` writes it (nesting flattened). */
const MINIFIED = "@layer theme{:root,:host{--color-surface:unset}}@layer utilities{" +
  ".w-\\[pixelRatio\\(2\\)\\]{width:pixelRatio(2)}" +
  ".border-\\[length\\:hairlineWidth\\(\\)\\]{border-width:hairlineWidth()}" +
  ".text-\\[length\\:fontScale\\(14\\)\\]{font-size:fontScale(14)}" +
  ".dark\\:bg-red-500:where(.dark,.dark *){background-color:var(--color-red-500)}" +
  "@media (prefers-color-scheme:dark){.dark\\:bg-red-500:not(:where(.light,.light *,.dark," +
  ".dark *,.ocean,.ocean *)){background-color:var(--color-red-500)}}" +
  "@media (min-width:48rem){.md\\:dark\\:text-white:where(.dark,.dark *){color:var(--color-white)}}" +
  ".ocean\\:bg-blue-500:where(.ocean,.ocean *){background-color:var(--color-blue-500)}}" +
  "@layer theme{:root:where(.light,.light *){--color-surface:#fff}" +
  "@media (prefers-color-scheme:dark){:root:not(:where(.light,.light *,.dark,.dark *,.ocean," +
  ".ocean *)){--color-surface:#000}}" +
  ":root:where(.dark,.dark *){--color-surface:#000}:root:where(.ocean,.ocean *){--color-surface:#036}}";

/** The CSS with all whitespace removed, to compare structure across both forms. */
const squash = (css: string) => css.replace(/\s+/g, "");

Deno.test("uniwind functions: pixelRatio / fontScale / hairlineWidth become CSS", () => {
  assertEquals(
    replaceUniwindFunctions("width: pixelRatio(2)"),
    "width: calc(2 * var(--denext-pixel-ratio, 1) * 1px)",
  );
  assertEquals(
    replaceUniwindFunctions("height: pixelRatio()"),
    "height: calc(1 * var(--denext-pixel-ratio, 1) * 1px)",
  );
  assertEquals(
    replaceUniwindFunctions("font-size: fontScale(14)"),
    "font-size: calc(14 * 0.0625rem)",
  );
  assertEquals(
    replaceUniwindFunctions("border-width: hairlineWidth()"),
    "border-width: calc(1px / var(--denext-pixel-ratio, 1))",
  );
  assertEquals(
    replaceUniwindFunctions("margin: calc(pixelRatio(fontScale(2)) + 1px)"),
    "margin: calc(calc(calc(2 * 0.0625rem) * var(--denext-pixel-ratio, 1) * 1px) + 1px)",
    "nested calls",
  );
  assertEquals(replaceUniwindFunctions("x: myfontScale(2)"), "x: myfontScale(2)", "not a call");
  assertEquals(replaceUniwindFunctions("x: fontScale(2"), "x: fontScale(2", "unbalanced");
  assertStringIncludes(pixelRatioRules(), "@media (min-resolution: 3dppx)");
});

Deno.test("splitSelectorList: commas inside parentheses and escapes stay", () => {
  assertEquals(splitSelectorList(":root, :host"), [":root", ":host"]);
  assertEquals(splitSelectorList(".a:where(.b, .b *), .c\\,d"), [".a:where(.b, .b *)", ".c\\,d"]);
  assertEquals(splitSelectorList('[title="a,b"], .x'), ['[title="a,b"]', ".x"]);
});

for (const [form, css] of [["nested", NESTED], ["minified", MINIFIED]] as const) {
  Deno.test(`uniwindCss (${form}): theme variables on the theme class, variants in @scope`, () => {
    const out = squash(uniwindCss(css, THEMES));
    // The functions, and the pixel-ratio rules they need.
    assertStringIncludes(out, "width:calc(2*var(--denext-pixel-ratio,1)*1px)");
    assertStringIncludes(out, "border-width:calc(1px/var(--denext-pixel-ratio,1))");
    assertStringIncludes(out, "font-size:calc(14*0.0625rem)");
    assertStringIncludes(out, ":root{--denext-pixel-ratio:1;}");
    // A theme utility applies up to the next other theme class.
    assertStringIncludes(
      out,
      "@scope(.dark)to(.light,.ocean){.dark\\:bg-red-500:where(.dark,.dark*){",
    );
    assertStringIncludes(
      out,
      "@scope(.ocean)to(.light,.dark){.ocean\\:bg-blue-500:where(.ocean,.ocean*){",
    );
    assertStringIncludes(out, "@scope(.dark)to(.light,.ocean){.md\\:dark\\:text-white:where(");
    // The system-preference fallback (no theme class anywhere) is not scoped.
    assertStringIncludes(
      out,
      "@media(prefers-color-scheme:dark){.dark\\:bg-red-500:not(:where(.light,.light*,",
    );
    // Theme variables: on the theme's class, so a ScopedTheme subtree gets them.
    assertStringIncludes(out, ".light{--color-surface:#fff;}");
    assertStringIncludes(out, ".dark{--color-surface:#000;}");
    assertStringIncludes(out, ".ocean{--color-surface:#036;}");
    assert(!out.includes(":root:where(.dark"), "no root-only theme rule is left");
    assertStringIncludes(out, ":root:not(:where(.light,.light*,", "the fallback stays on :root");
  });
}

Deno.test("uniwindCss: Tailwind's banner, statements and @property survive; lightningcss reads it", async () => {
  const out = uniwindCss(NESTED, THEMES);
  assert(out.startsWith("/*! tailwindcss v4.3.0"), out.slice(0, 80));
  assertStringIncludes(out, "@layer theme, base, components, utilities;");
  assertStringIncludes(squash(out), '@property--tw-border-style{syntax:"*";');
  const { css } = await transformCss(out, "global.gen.css", { minify: true });
  assertStringIncludes(css, "@scope(.dark) to (.light,.ocean)");
});

Deno.test("uniwindCss: without uniwind's functions no pixel-ratio rules; a lone theme scopes without `to`", () => {
  const out = uniwindCss(".dark\\:x{&:where(.dark, .dark *){color:red}}", ["dark"]);
  assert(!out.includes("--denext-pixel-ratio"));
  assertStringIncludes(squash(out), "@scope(.dark){.dark\\:x:where(.dark,.dark*){color:red;}}");
  assertEquals(squash(uniwindCss("a{color:red}", [])), "a{color:red;}");
});

Deno.test("withUniwindCss: only with React Native mode's uniwind support on", () => {
  const paths = { input: "/a/global.css", output: "/a/global.gen.css" };
  const rn: DenextConfig = { mode: "spa", reactNative: true };
  assert(withUniwindCss(paths, rn, "/a")?.postprocess);
  assertEquals(withUniwindCss(paths, { mode: "spa" }, "/a"), paths);
  assertEquals(withUniwindCss(paths, { ...rn, reactNative: { uniwind: false } }, "/a"), paths);
  assertEquals(withUniwindCss(undefined, rn, "/a"), undefined);
});

// A stub Tailwind binary writing NESTED, so buildAppCss's compile → postprocess → walk runs
// without a real download. POSIX only.
Deno.test({
  name: "buildAppCss runs the uniwind pass over the compiled output when uniwind is installed",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_uniwind_css_" });
    const prevBin = Deno.env.get("TAILWIND_BIN");
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
      await Deno.writeTextFile(join(dir, "global.css"), '@import "tailwindcss";\n');
      await Deno.writeTextFile(join(dir, "compiled.css"), NESTED);
      const stub = join(dir, "tw-stub.sh");
      await Deno.writeTextFile(
        stub,
        `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) OUT="$2"; shift 2;;\n` +
          `    *) shift;;\n  esac\ndone\ncat "${join(dir, "compiled.css")}" > "$OUT"\n`,
      );
      await Deno.chmod(stub, 0o755);
      Deno.env.set("TAILWIND_BIN", stub);
      const config: DenextConfig = {
        mode: "spa",
        reactNative: { uniwind: { extraThemes: ["ocean"] } },
      };
      const tailwind = { input: join(dir, "global.css"), output: join(dir, "global.gen.css") };
      const build = () =>
        buildAppCss({
          projectDir: dir,
          configPath: join(dir, "deno.json"),
          outDir: join(dir, ".denext"),
          tailwind: withUniwindCss(tailwind, config, dir),
        });
      await build();
      assertStringIncludes(await Deno.readTextFile(tailwind.output), "width: pixelRatio(2)");
      await Deno.mkdir(join(dir, "node_modules", "uniwind"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "node_modules", "uniwind", "package.json"),
        '{"name":"uniwind"}',
      );
      await build();
      const out = await Deno.readTextFile(tailwind.output);
      assertStringIncludes(out, "@scope (.dark) to (.light, .ocean)");
      assertStringIncludes(out, "--denext-pixel-ratio");
    } finally {
      if (prevBin === undefined) Deno.env.delete("TAILWIND_BIN");
      else Deno.env.set("TAILWIND_BIN", prevBin);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
