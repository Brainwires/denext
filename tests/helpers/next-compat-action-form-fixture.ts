// A next-compat Next.js app (no import map, nothing installed) whose Server Component page posts
// a `"use server"` function through `<form action={addItem}>` and an inline `"use server"`
// function through a second form, under a Next-convention root
// layout that renders `<html lang="fr" className="dark">` and `<body className="shell">`. With
// `island: true` the page also renders a `"use client"` counter, so the route renders through
// Flight and the hydrated client submits the form itself; without it the app has no client
// module at all, the case whose action module the compat build once left out of its server
// bundle (the form rendered with no `action`). Shared by the in-process test and the Chromium e2e.

import { join } from "@std/path";

/** The files of the fixture app, keyed by project-relative path. */
function files(island: boolean): Record<string, string> {
  return {
    "deno.json": JSON.stringify({ nodeModulesDir: "manual", imports: {} }),
    "package.json": JSON.stringify({
      name: "next-compat-action-form",
      private: true,
      dependencies: { next: "^16.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
    }),
    "denext.config.ts": "export default { compatibilityMode: true };\n",
    "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <body className="shell">{children}</body>
    </html>
  );
}
`,
    // `next/cache` resolves only through the compat build's aliases: loading this module from
    // source (as the server did when the build left it out) fails outright.
    "app/actions.ts": `"use server";
import { revalidatePath } from "next/cache";

const items: string[] = [];

export async function addItem(formData: FormData) {
  items.push(String(formData.get("title") ?? ""));
  revalidatePath("/");
}

export async function listItems() {
  return [...items];
}
`,
    "app/counter.tsx": `"use client";
import { useState } from "react";

export function Counter() {
  const [n, setN] = useState(0);
  return <button id="count" type="button" onClick={() => setN(n + 1)}>{n}</button>;
}
`,
    "app/page.tsx": `import { addItem, listItems } from "./actions";
${island ? 'import { Counter } from "./counter";\n' : ""}
export const dynamic = "force-dynamic";

export default async function Home() {
  const items = await listItems();
  // An inline Server Action: hoisted to a server reference by the build.
  async function addInline(formData: FormData) {
    "use server";
    formData.set("title", "inline:" + String(formData.get("title") ?? ""));
    await addItem(formData);
  }
  return (
    <main>
      <h1>Items</h1>
      ${island ? "<Counter />" : ""}
      <ul id="items">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
      <form id="exported" action={addItem}>
        <input name="title" />
        <button id="add" type="submit">Add</button>
      </form>
      <form id="inline" action={addInline}>
        <input name="title" />
        <button id="add-inline" type="submit">Add inline</button>
      </form>
    </main>
  );
}
`,
  };
}

/**
 * Write the fixture app into `dir`.
 *
 * @param dir An empty directory.
 * @param island Render a `"use client"` component on the page too.
 */
export async function writeActionFormFixture(dir: string, island: boolean): Promise<void> {
  for (const [rel, text] of Object.entries(files(island))) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}
