// The tutorial's island chapter (step 8) adds files that examples/notes deliberately does
// not ship — the example is the zero-JavaScript app. So those blocks cannot be pinned to a
// source file the way `docs-tutorial.test.ts` pins the rest; instead this test takes the
// blocks FROM the tutorial, drops them into a copy of examples/notes, and proves the chapter
// is true: they type-check against the framework, the route still works with JavaScript
// disabled (both forms render Server Action endpoints and post natively), and hydrated, the
// islands do what the prose says — the note hides optimistically, the button reads pending.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { act, createTestApp, createTestClient, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

const REPO = new URL("../", import.meta.url);
const DOC = "apps/web/app/docs/tutorial/content.md";
const EXAMPLE = "examples/notes";

/** A step-8 block: `// app/notes/x.tsx (… not in examples/notes)` on its first line. */
interface IslandBlock {
  path: string;
  code: string;
}

/** Every fenced block whose marker says it is an addition to (not an excerpt of) the example. */
function islandBlocks(markdown: string): IslandBlock[] {
  const lines = markdown.split("\n");
  const blocks: IslandBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("```")) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].startsWith("```")) end++;
    const body = lines.slice(start, end);
    i = end;
    const marker = body[0]?.match(/^\/\/ (app\/[\w./-]+\.tsx) \([^)]*not in examples\/notes\)$/);
    if (marker) blocks.push({ path: marker[1], code: body.slice(1).join("\n") + "\n" });
  }
  return blocks;
}

/** Copy examples/notes (minus its database) and write the chapter's files over it. */
async function stageApp(blocks: IslandBlock[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_tutorial_islands_" });
  const src = new URL(`${EXAMPLE}/`, REPO).pathname;
  for await (const e of Deno.readDir(src)) {
    if (e.name === "notes.db" || e.name === ".denext") continue;
    await copy(join(src, e.name), join(dir, e.name));
  }
  for (const b of blocks) {
    await Deno.mkdir(join(dir, b.path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, b.path), b.code);
  }
  // The example's deno.json points at `../../mod.ts`; from a temp dir that is nowhere, so
  // give `deno check` an import map that resolves to this checkout.
  const repo = REPO.pathname;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "deno.unstable", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": join(repo, "mod.ts"),
        "denext/jsx-runtime": join(repo, "src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": join(repo, "src/jsx/jsx-runtime.ts"),
        "denext/server": join(repo, "src/server/mod.ts"),
        "denext/client": join(repo, "src/client/mod.ts"),
        "denext/testing": join(repo, "src/testing/mod.ts"),
      },
    }),
  );
  return dir;
}

async function copy(from: string, to: string): Promise<void> {
  const st = await Deno.stat(from);
  if (st.isDirectory) {
    await Deno.mkdir(to, { recursive: true });
    for await (const e of Deno.readDir(from)) await copy(join(from, e.name), join(to, e.name));
  } else {
    await Deno.copyFile(from, to);
  }
}

Deno.test("docs: the tutorial's island chapter type-checks, keeps the no-JS path, and hydrates as described", async (t) => {
  const blocks = islandBlocks(await Deno.readTextFile(new URL(DOC, REPO)));
  assertEquals(
    blocks.map((b) => b.path).sort(),
    ["app/notes/note-form.tsx", "app/notes/note-list.tsx", "app/notes/page.tsx"],
    "the chapter's three files",
  );
  // The chapter's whole point: the page stays a Server Component, the islands carry the hooks.
  const page = blocks.find((b) => b.path === "app/notes/page.tsx")!.code;
  assert(!page.includes("use client") && !/\buse[A-Z]\w*\(/.test(page));
  for (const island of ["app/notes/note-form.tsx", "app/notes/note-list.tsx"]) {
    assert(blocks.find((b) => b.path === island)!.code.startsWith('"use client";'), island);
  }

  const dir = await stageApp(blocks);
  const prevDb = Deno.env.get("NOTES_DB");
  const prevSecret = Deno.env.get("SESSION_SECRET");
  Deno.env.set("NOTES_DB", ":memory:");
  Deno.env.set("SESSION_SECRET", "tutorial-islands-test-secret-0123456789");
  try {
    await t.step("the snippets type-check against the framework", async () => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "check",
          "--config",
          join(dir, "deno.json"),
          ...blocks.map((b) => join(dir, b.path)),
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    });

    const client = createTestClient(await createTestApp(dir));
    await t.step(
      "with JavaScript off, both islands' forms post to Server Action endpoints",
      async () => {
        const login = await client.get("/login");
        assertEquals((await client.submit(client.form(login.text))).status, 303);
        const notes = await client.get("/notes");
        assertEquals(notes.status, 200);
        // The Server Action references crossed the boundary as references: the create form and
        // one delete form per note render the generated endpoint, not a dropped `action`.
        const actions = notes.text.match(/<form[^>]*action="\/_denext\/action\/[^"]+"/g) ?? [];
        assert(actions.length >= 3, `expected create + delete endpoints, got:\n${notes.text}`);
        assertStringIncludes(notes.text, "Add note"); // SSR: not pending

        const created = await client.submit(client.form(notes.text, { has: "title" }), {
          title: "From the island",
          body: "posted natively",
        });
        assertEquals(created.status, 303);
        const after = await client.get("/notes");
        assertStringIncludes(after.text, "From the island");
        // The newest note is listed first, so the first delete form is its own.
        assertEquals((await client.submit(client.form(after.text, { has: "id" }))).status, 303);
        assert(!(await client.get("/notes")).text.includes("From the island"), "deleted");
      },
    );

    await t.step("hydrated, the list hides a note optimistically while `remove` runs", async () => {
      const { NoteList } = await import(toFileUrl(join(dir, "app/notes/note-list.tsx")).href);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const calls: FormData[] = [];
      const remove = async (fd: FormData) => {
        calls.push(fd);
        await gate;
      };
      const note = (id: number, title: string) => ({
        id,
        user_id: 1,
        author: "demo@denext.dev",
        title,
        body: "",
        visibility: "private",
        updated_at: "now",
      });
      const screen = await render(
        h(NoteList, { notes: [note(1, "Keep me"), note(2, "Delete me")], remove }),
      );
      assertStringIncludes(screen.container.innerHTML, "Delete me");
      await screen.fireEvent.submit(screen.getAllByRole("form")[1]);
      await act(() => {});
      assert(!screen.container.innerHTML.includes("Delete me"), "hidden before the action settles");
      assertStringIncludes(screen.container.innerHTML, "Keep me");
      assertEquals(calls.length, 1, "the Server Action was still called");
      release();
    });

    await t.step("hydrated, the form's button reads pending from useFormStatus", async () => {
      const { NoteForm } = await import(toFileUrl(join(dir, "app/notes/note-form.tsx")).href);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const screen = await render(h(NoteForm, { action: () => gate }));
      assertStringIncludes(screen.container.innerHTML, "Add note");
      await screen.fireEvent.submit(screen.getByRole("form"));
      await act(() => {});
      assertStringIncludes(screen.container.innerHTML, "Adding…");
      assertStringIncludes(screen.container.innerHTML, "disabled");
      release();
      await new Promise((r) => setTimeout(r, 5));
      await act(() => {});
      assertStringIncludes(screen.container.innerHTML, "Add note");
    });
  } finally {
    if (prevDb === undefined) Deno.env.delete("NOTES_DB");
    else Deno.env.set("NOTES_DB", prevDb);
    if (prevSecret === undefined) Deno.env.delete("SESSION_SECRET");
    else Deno.env.set("SESSION_SECRET", prevSecret);
    await Deno.remove(dir, { recursive: true });
  }
});
