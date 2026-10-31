// checkoutFile (src/build/checkout-file.ts): a module reads a sibling package by path only from a
// denext checkout; a published, vendored or npm-compat copy imports the published package.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { checkoutFile } from "../src/build/checkout-file.ts";

const CORPUS = "../../packages/docs-corpus/mod.ts";

/** A temp dir with `files` written in it (relative paths), removed after `fn`. */
async function inLayout(files: string[], fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_checkout_file_" });
  try {
    for (const file of files) {
      const path = join(dir, ...file.split("/"));
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, "export {};\n");
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const url = (dir: string, file: string) => toFileUrl(join(dir, ...file.split("/"))).href;

Deno.test("checkoutFile: a checkout's module gets the sibling package's file", async () => {
  await inLayout(["src/build/x.ts", "packages/docs-corpus/mod.ts"], (dir) => {
    assertEquals(
      checkoutFile(CORPUS, url(dir, "src/build/x.ts")),
      url(dir, "packages/docs-corpus/mod.ts"),
    );
  });
});

Deno.test("checkoutFile: published, vendored, npm-compat and incomplete copies import the package", async () => {
  assertEquals(
    checkoutFile(CORPUS, "https://jsr.io/@denext/denext/9.9.9/src/build/x.ts"),
    undefined,
  );
  const vendored = "vendor/jsr.io/@denext/denext/9.9.9";
  const npm = "node_modules/@jsr/denext__denext";
  // Even with a packages/ folder beside it, a vendored or npm copy is not a checkout.
  const files = [vendored, npm].flatMap((
    p,
  ) => [`${p}/src/build/x.ts`, `${p}/packages/docs-corpus/mod.ts`]);
  await inLayout(files, (dir) => {
    assertEquals(checkoutFile(CORPUS, url(dir, `${vendored}/src/build/x.ts`)), undefined);
    assertEquals(checkoutFile(CORPUS, url(dir, `${npm}/src/build/x.ts`)), undefined);
  });
  // A `file:` module with no packages/ beside it (a copy of src/ alone).
  await inLayout(["src/build/x.ts"], (dir) => {
    assertEquals(checkoutFile(CORPUS, url(dir, "src/build/x.ts")), undefined);
  });
});

Deno.test("checkoutFile: when the disk cannot tell, the location decides", async () => {
  // A stat that fails for another reason than "not found" (a file where a folder should be).
  await inLayout(["src/build/x.ts", "packages"], (dir) => {
    assertEquals(
      checkoutFile(CORPUS, url(dir, "src/build/x.ts")),
      url(dir, "packages/docs-corpus/mod.ts"),
    );
  });
  // No read permission: never a stat (which would prompt), the checkout path all the same.
  await inLayout(["src/build/x.ts"], async (dir) => {
    const module = new URL("../src/build/checkout-file.ts", import.meta.url).href;
    const probe = `const { checkoutFile } = await import(${JSON.stringify(module)});\n` +
      `console.log(JSON.stringify([checkoutFile(${JSON.stringify(CORPUS)}, ${
        JSON.stringify(url(dir, "src/build/x.ts"))
      }), checkoutFile(${JSON.stringify(CORPUS)}, ${
        JSON.stringify(url(dir, "vendor/jsr.io/@denext/denext/1.0.0/src/build/x.ts"))
      })]));\n`;
    // `deno run` (not `eval`, which grants everything), reading the probe and the module alone.
    const script = join(dir, "probe.ts");
    await Deno.writeTextFile(script, probe);
    const readable = [script, fromFileUrl(module)].join(",");
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-prompt", "--no-lock", "--no-config", `--allow-read=${readable}`, script],
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const decoder = new TextDecoder();
    assertEquals(out.code, 0, decoder.decode(out.stderr));
    assertEquals(JSON.parse(decoder.decode(out.stdout)), [
      url(dir, "packages/docs-corpus/mod.ts"),
      null,
    ]);
  });
});
