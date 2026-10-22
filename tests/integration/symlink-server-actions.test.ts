// A Server Action app built through a symlinked directory (macOS `/var` → `/private/var` puts
// every `$TMPDIR` project behind one; a symlinked home or workspace folder too) builds as its
// real path does: the island's action is stubbed, its secret never ships, and a real server-only
// leak reached through the link still fails the build.

import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { build } from "../../src/build/build.ts";

const REPO = fromFileUrl(new URL("../..", import.meta.url));

const ACTIONS = `"use server";
const SECRET = "ACTION_SECRET_7f3a";
export async function save(_prev: string, form: FormData): Promise<string> {
  return SECRET.length + String(form.get("name") ?? "");
}
`;

const FORM = `"use client";
import { useActionState } from "denext";
import { save } from "./actions.ts";
LEAK_IMPORT
export default function Form() {
  const [state, action] = useActionState(save, "");
  return <form action={action}><input name="name" /><p>{state}</p></form>;
}
`;

const PAGE = `import Form from "./form.tsx";
export default function Page() {
  return <main><Form /></main>;
}
`;

const LAYOUT = `export default function Layout({ children }: { children: unknown }) {
  return <div>{children}</div>;
}
`;

/**
 * A Server Action app in a fresh real temp dir, reached through a symlink `link` in a second
 * one; `null` (with the reason logged) on a host that can't create one. On Windows the link is a
 * junction (a symlink needs Developer Mode or a privilege). `leak` makes the island import a
 * module that reads `node:fs`.
 */
async function linkedApp(
  leak: boolean,
): Promise<{ link: string; cleanup: () => Promise<void> } | null> {
  const real = await Deno.makeTempDir({ prefix: "denext-symlink-actions-" });
  const hold = await Deno.makeTempDir({ prefix: "denext-symlink-actions-link-" });
  const cleanup = async () => {
    await Deno.remove(hold, { recursive: true });
    await Deno.remove(real, { recursive: true });
  };
  const link = join(hold, "link");
  try {
    await Deno.symlink(real, link, { type: "junction" });
  } catch (err) {
    await cleanup();
    console.warn(`skipped: this host can't create a directory symlink (${err})`);
    return null;
  }
  const config = JSON.parse(await Deno.readTextFile(join(REPO, "examples/actions/deno.json")));
  delete config.lint;
  delete config.tasks;
  for (const [k, v] of Object.entries(config.imports as Record<string, string>)) {
    // A URL, as an import map takes it (a Windows `C:\\…` path is not one).
    config.imports[k] = toFileUrl(join(REPO, v.replace(/^\.\.\/\.\.\//, ""))).href;
  }
  await Deno.mkdir(join(real, "app"));
  const files: Record<string, string> = {
    "deno.json": JSON.stringify(config),
    "app/layout.tsx": LAYOUT,
    "app/page.tsx": PAGE,
    "app/actions.ts": ACTIONS,
    "app/form.tsx": FORM.replace(
      "LEAK_IMPORT",
      leak ? `import { read } from "./disk.ts";\nconsole.log(read);` : "",
    ),
    "app/disk.ts": `import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    await Deno.writeTextFile(join(real, name), text);
  }
  return { link, cleanup };
}

/** Every emitted client file's text, concatenated. */
async function clientText(outDir: string): Promise<string> {
  let text = "";
  for await (const e of Deno.readDir(join(outDir, "client"))) {
    if (e.isFile && e.name.endsWith(".js")) {
      text += await Deno.readTextFile(join(outDir, "client", e.name));
    }
  }
  return text;
}

Deno.test({
  name: "symlinked project: a Server Action island builds with its action stubbed",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const made = await linkedApp(false);
  if (!made) return;
  try {
    const result = await build(made.link);
    const text = await clientText(result.outDir);
    assert(text.length > 0, "the island shipped a client bundle");
    assert(!text.includes("ACTION_SECRET_7f3a"), "the action's source never ships");
  } finally {
    await made.cleanup();
  }
});

Deno.test({
  name: "symlinked project: a server-only module an island imports still fails the build",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const made = await linkedApp(true);
  if (!made) return;
  try {
    const err = await assertRejects(() => build(made.link));
    assertStringIncludes(String(err), "server-only code would ship to the browser");
    assertStringIncludes(String(err), "disk.ts");
  } finally {
    await made.cleanup();
  }
});
