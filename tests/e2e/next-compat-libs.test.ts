// e2e (Phase 1 breadth): prove more real npm React libraries run on denext via
// next-compat — react-hook-form (heavy hook usage) + lucide-react (forwardRef
// SVG icons). CI-excluded (needs npm + esbuild).

import { assert, assertStringIncludes } from "@std/assert";
import { renderNextCompatPage } from "../../src/build/next-compat-build.ts";
import { buildCompatIndexPage, cacheNpm, writeCompatProject } from "./harness.ts";

// A form built with react-hook-form + a lucide icon — both real npm packages.
const PAGE_SRC = `import { createElement as h } from "react";
import { useForm } from "react-hook-form";
import { Mail } from "lucide-react";
export default function Page() {
  const { register, handleSubmit } = useForm({ defaultValues: { email: "" } });
  return h("form", { onSubmit: handleSubmit(() => {}) },
    h(Mail, { "aria-label": "mail", size: 16 }),
    h("input", { ...register("email"), placeholder: "you@example.com" }),
    h("button", { type: "submit" }, "Sign up"));
}
`;

Deno.test("next-compat: react-hook-form + lucide-react render on denext", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nclibs_" });
  try {
    await writeCompatProject(dir, { "react-hook-form": "7.54.2", "lucide-react": "0.469.0" });
    await Deno.writeTextFile(`${dir}/page.tsx`, PAGE_SRC);

    const install = await cacheNpm(
      dir,
      ["npm:react-hook-form@7.54.2", "npm:lucide-react@0.469.0"],
      true,
    );
    assert(install.success, "npm install failed");

    const [page] = await buildCompatIndexPage(dir);
    const html = await renderNextCompatPage(page, {}, "/c.js");

    // react-hook-form's register() wired the input; lucide rendered an SVG.
    assertStringIncludes(html, "<form");
    assertStringIncludes(html, "<input");
    assertStringIncludes(html, 'name="email"'); // register("email") applied
    assertStringIncludes(html, "<svg"); // lucide icon rendered
    assertStringIncludes(html, "Sign up");

    const client = await Deno.readTextFile(page.clientBundle);
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
      "client bundle must be single-React",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
