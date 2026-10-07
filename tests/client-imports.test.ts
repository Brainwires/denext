// The client bundles' one resolution path (src/build/client-imports.ts): every `"use server"`
// module is a redirect to its action stub, and every app module that names a redirected module
// through an import-map alias — an alias prefix, an exact `#` key, a re-export, a barrel — is
// copied with that import rewritten, the same rule the platform files resolve by.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { clientImportMap, generateServerStub } from "../src/build/client-imports.ts";
import { actionIdFor } from "../src/runtime/server-action.ts";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_client_imports_" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { "@/": "./", "#actions": "./app/actions.ts" } }),
  );
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

const ACTION = `"use server";\nexport async function act() { return "SECRET"; }\n`;
const url = (dir: string, rel: string) => toFileUrl(join(dir, rel)).href;

Deno.test("clientImportMap: every spelling of an action import reaches its stub", async () => {
  const dir = await project({
    "app/actions.ts": ACTION,
    "components/Alias.tsx": `import { act } from "@/app/actions.ts";\nexport const a = act;\n`,
    "components/Hash.tsx": `import { act } from "#actions";\nexport const a = act;\n`,
    "components/Stem.tsx": `import { act } from "@/app/actions";\nexport const a = act;\n`,
    "components/index.ts": `export { act } from "@/app/actions.ts";\n`,
    "components/ViaBarrel.tsx":
      `import { act } from "@/components/index.ts";\nexport const a = act;\n`,
    "components/Relative.tsx": `import { act } from "../app/actions.ts";\nexport const a = act;\n`,
  });
  const scratch = await Deno.makeTempDir();
  try {
    const { importMap, originals } = await clientImportMap({
      projectDir: dir,
      server: [["mod1", { url: url(dir, "app/actions.ts"), exports: ["act"] }]],
      dir: scratch,
    });
    const stub = importMap[url(dir, "app/actions.ts")];
    assert(stub?.startsWith("file:"), "the action is redirected to a stub file");
    assertEquals(importMap[url(dir, "app/actions")], stub, "and its extensionless spelling");
    const stubText = await Deno.readTextFile(fromFileUrl(stub));
    assertEquals(stubText, generateServerStub("mod1", ["act"]));
    assertStringIncludes(stubText, actionIdFor("mod1", "act"));

    // Each alias importer (and the barrel, and its importer) is a copy importing the stub.
    for (const name of ["Alias.tsx", "Hash.tsx", "Stem.tsx", "index.ts"]) {
      const copy = importMap[url(dir, `components/${name}`)];
      assert(copy && copy !== url(dir, `components/${name}`), `${name} is copied`);
      assertStringIncludes(await Deno.readTextFile(fromFileUrl(copy)), JSON.stringify(stub));
      assertEquals(originals[copy], url(dir, `components/${name}`));
    }
    const viaBarrel = await Deno.readTextFile(
      fromFileUrl(importMap[url(dir, "components/ViaBarrel.tsx")]),
    );
    assertStringIncludes(viaBarrel, JSON.stringify(importMap[url(dir, "components/index.ts")]));
    // A relative import already reaches the file-URL redirect: no copy needed.
    assertEquals(importMap[url(dir, "components/Relative.tsx")], undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test('clientImportMap: a platform redirect onto a "use server" variant goes to its stub', async () => {
  const dir = await project({
    "app/actions.ts": ACTION,
    "app/actions.ios.ts": ACTION,
    "components/Island.tsx": `import { act } from "@/app/actions.ts";\nexport const a = act;\n`,
  });
  const scratch = await Deno.makeTempDir();
  try {
    const variant = url(dir, "app/actions.ios.ts");
    const { importMap } = await clientImportMap({
      projectDir: dir,
      redirects: { [url(dir, "app/actions.ts")]: variant, [url(dir, "app/actions")]: variant },
      server: [["ios1", { url: variant, exports: ["act"] }]],
      dir: scratch,
    });
    const stub = importMap[variant];
    assert(stub && stub !== variant);
    assertEquals(importMap[url(dir, "app/actions.ts")], stub, "the plain file reaches the stub");
    const island = importMap[url(dir, "components/Island.tsx")];
    assertStringIncludes(await Deno.readTextFile(fromFileUrl(island)), JSON.stringify(stub));
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("clientImportMap: a transformed module is copied from its transformed source", async () => {
  const dir = await project({
    "app/actions.ts": ACTION,
    "components/Island.tsx": `import { act } from "@/app/actions.ts";\nexport const a = act;\n`,
    "out/Island.transformed.tsx":
      `import { act } from "@/app/actions.ts";\nexport const a = act; // TRANSFORMED\n`,
  });
  const scratch = await Deno.makeTempDir();
  try {
    const transformed = url(dir, "out/Island.transformed.tsx");
    const { importMap } = await clientImportMap({
      projectDir: dir,
      rewritten: { [url(dir, "components/Island.tsx")]: transformed },
      server: [["mod1", { url: url(dir, "app/actions.ts"), exports: ["act"] }]],
      dir: scratch,
    });
    const copy = importMap[url(dir, "components/Island.tsx")];
    assert(copy !== transformed, "the copy replaces the transform's own redirect");
    const text = await Deno.readTextFile(fromFileUrl(copy));
    assertStringIncludes(text, "TRANSFORMED");
    assertStringIncludes(text, JSON.stringify(importMap[url(dir, "app/actions.ts")]));
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("clientImportMap: no project config resolves by file URL only", async () => {
  const scratch = await Deno.makeTempDir();
  try {
    const action = toFileUrl(join(scratch, "a.ts")).href;
    const { importMap, originals } = await clientImportMap({
      projectDir: null,
      server: [["m", { url: action, exports: ["x"] }]],
      dir: join(scratch, "w"),
    });
    assert(importMap[action]);
    assertEquals(originals, {});
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});
