// A native App Router app (denext imports, no next-compat) whose Server Component page posts an
// inline `"use server"` function through `<form action={addInline}>`. The action lives inside the
// component, so the server render must hoist it to a registered server reference for the form to
// render its endpoint. With `island: true` the page also renders a `"use client"` counter, so the
// route renders through Flight and the hydrated client submits the form itself. With
// `closure: true` a second form's inline action reads a component local (`prefix`) and a third
// posts a `"use server"` module export bound with `.bind(null, "tag-xyz")`. Shared by the in-process
// tests and the Chromium e2e.

import { join } from "@std/path";

/** The framework file `rel` (repo-relative) as a file URL. */
const fw = (rel: string) => new URL(`../../${rel}`, import.meta.url).href;

/** Options for {@linkcode writeNativeActionFormFixture}. */
export interface NativeActionFormFixture {
  /** Render a `"use client"` component on the page too. */
  island?: boolean;
  /** Add the forms whose actions carry bound values (a closure, `.bind`). */
  closure?: boolean;
  /** Leave the page static (exportable) instead of `dynamic = "force-dynamic"`. */
  static?: boolean;
}

/** The files of the fixture app, keyed by project-relative path. */
function files(options: NativeActionFormFixture): Record<string, string> {
  const { island = false, closure = false } = options;
  return {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": fw("mod.ts"),
        "denext/jsx-runtime": fw("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": fw("src/jsx/jsx-runtime.ts"),
        "denext/server": fw("src/server/mod.ts"),
        "denext/client": fw("src/client/mod.ts"),
      },
    }),
    "app/layout.tsx": `export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    // A plain server module (no directive): the page's store.
    "app/store.ts": `const items: string[] = [];
export function add(title: string) {
  items.push(title);
}
export function list() {
  return [...items];
}
`,
    "app/actions.ts": `"use server";
import { revalidatePath } from "denext/server";
import { add } from "./store.ts";

export async function addTagged(tag: string, formData: FormData) {
  add(tag + ":" + String(formData.get("title") ?? ""));
  revalidatePath("/");
}
`,
    "app/counter.tsx": `"use client";
import { useState } from "denext";

export function Counter() {
  const [n, setN] = useState(0);
  return <button id="count" type="button" onClick={() => setN(n + 1)}>{n}</button>;
}
`,
    "app/page.tsx": `import { revalidatePath } from "denext/server";
import { add, list } from "./store.ts";
${closure ? 'import { addTagged } from "./actions.ts";\n' : ""}${
      island ? 'import { Counter } from "./counter.tsx";\n' : ""
    }${options.static ? "" : '\nexport const dynamic = "force-dynamic";'}

export default function Home() {
  const items = list();
  // An inline Server Action: hoisted to a registered server reference by the server render.
  async function addInline(formData: FormData) {
    "use server";
    add("inline:" + String(formData.get("title") ?? ""));
    revalidatePath("/");
  }
${
      closure
        ? `  const prefix = "closed-" + items.length;
  // Reads a component local: the value is bound (encrypted) into the form's action.
  async function addClosure(formData: FormData) {
    "use server";
    add(prefix + ":" + String(formData.get("title") ?? ""));
    revalidatePath("/");
  }
  const addBound = addTagged.bind(null, "tag-xyz");
`
        : ""
    }  return (
    <main>
      <h1>Items</h1>
      ${island ? "<Counter />" : ""}
      <ul id="items">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
      <form id="inline" action={addInline}>
        <input name="title" />
        <button id="add-inline" type="submit">Add inline</button>
      </form>
${
      closure
        ? `      <form id="closure" action={addClosure}>
        <input name="title" />
        <button type="submit">Add closure</button>
      </form>
      <form id="bound" action={addBound}>
        <input name="title" />
        <button type="submit">Add bound</button>
      </form>
`
        : ""
    }    </main>
  );
}
`,
  };
}

/**
 * Write the fixture app into `dir`.
 *
 * @param dir An empty directory.
 * @param options What the page renders besides the inline action's form.
 */
export async function writeNativeActionFormFixture(
  dir: string,
  options: NativeActionFormFixture = {},
): Promise<void> {
  for (const [rel, text] of Object.entries(files(options))) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}
