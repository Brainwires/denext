// Unit tests for the `denext generate` codegen engine: placement (App Router root
// vs src/app), PascalCase derivation, no-overwrite, and per-kind targets.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { generateArtifact } from "../src/build/generate.ts";

async function project(srcLayout = false): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_gen_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, srcLayout ? "src/app" : "app"), { recursive: true });
  return dir;
}

Deno.test("page/layout/api land under app/ with the right filenames", async () => {
  const dir = await project();
  try {
    assertEquals((await generateArtifact(dir, "page", "blog/[slug]")).written, [
      join(dir, "app/blog/[slug]/page.tsx"),
    ]);
    assertEquals((await generateArtifact(dir, "layout", "blog")).written, [
      join(dir, "app/blog/layout.tsx"),
    ]);
    assertEquals((await generateArtifact(dir, "api", "users")).written, [
      join(dir, "app/users/route.ts"),
    ]);
    const page = await Deno.readTextFile(join(dir, "app/blog/[slug]/page.tsx"));
    // PascalCase derived from the dynamic segment name; denext-native PageProps.
    assert(page.includes("function SlugPage("), page);
    assert(page.includes('from "denext/server"'), page);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("component + action land under the source base", async () => {
  const dir = await project();
  try {
    assertEquals((await generateArtifact(dir, "component", "user-card")).written, [
      join(dir, "components/UserCard.tsx"),
    ]);
    const comp = await Deno.readTextFile(join(dir, "components/UserCard.tsx"));
    assert(comp.includes('"use client"'));
    assert(comp.includes("function UserCard()"));

    assertEquals((await generateArtifact(dir, "action", "createPost")).written, [
      join(dir, "actions/createPost.ts"),
    ]);
    const action = await Deno.readTextFile(join(dir, "actions/createPost.ts"));
    assert(action.includes('"use server"'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("honors the src/app layout", async () => {
  const dir = await project(true);
  try {
    assertEquals((await generateArtifact(dir, "page", "about")).written, [
      join(dir, "src/app/about/page.tsx"),
    ]);
    // Components go under the source base (src/), not the project root.
    assertEquals((await generateArtifact(dir, "component", "Card")).written, [
      join(dir, "src/components/Card.tsx"),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rejects a name with .. path segments (no traversal write)", async () => {
  const dir = await project();
  try {
    let threw = false;
    try {
      await generateArtifact(dir, "page", "../../evil");
    } catch (e) {
      threw = true;
      assert((e as Error).message.includes(".."), (e as Error).message);
    }
    assert(threw, "traversal name should throw");
    // Nothing was written outside the project.
    let leaked = false;
    try {
      await Deno.stat(join(dir, "../evil"));
      leaked = true;
    } catch { /* good — absent */ }
    assert(!leaked, "must not write outside the project");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("never overwrites an existing file", async () => {
  const dir = await project();
  try {
    const first = await generateArtifact(dir, "page", "home");
    assertEquals(first.written.length, 1);
    const second = await generateArtifact(dir, "page", "home");
    assertEquals(second.written.length, 0);
    assertEquals(second.skipped, [join(dir, "app/home/page.tsx")]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
