// The packaging steps read the project config as `denext export` does: the first of
// `denext.config.ts` / `.mts` / `.js` / `.mjs`. They used to import `denext.config.ts` only, and
// three of four readers took ANY failure for "no config": a project configured in
// `denext.config.mts` packaged without its capabilities' permissions, extensions and installers,
// and a config that threw at import packaged with the defaults.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { desktopIncludeArgs, desktopPackageFlags } from "../src/build/desktop-capabilities.ts";
import { desktopInstallerPlan } from "../src/build/desktop-installers.ts";
import { loadConfigBeside } from "../src/build/desktop-config-beside.ts";
import { inChild } from "./helpers/isolated.ts";

/** A project with `scripts/` and the given config files; returns a package script's URL. */
async function project(files: Record<string, string>): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_config_beside_" });
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  for (const [name, text] of Object.entries(files)) await Deno.writeTextFile(join(dir, name), text);
  return { dir, entry: toFileUrl(join(dir, "scripts", "package-linux.ts")).href };
}

const CLIPBOARD = "export default { desktop: { capabilities: { clipboard: true } } };\n";

Deno.test("package flags read a denext.config.mts like denext export does", async () => {
  const { dir, entry } = await project({ "denext.config.mts": CLIPBOARD });
  try {
    const flags = await desktopPackageFlags(entry, "linux", false);
    assert(flags.includes("--allow-sys"), flags.join(" "));
    assertEquals(
      (await loadConfigBeside(entry) as { desktop: unknown }).desktop,
      { capabilities: { clipboard: true } },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a config that fails to load fails the packaging step, never the defaults", async () => {
  const { dir, entry } = await project({
    "denext.config.ts": 'throw new Error("config exploded");\n',
  });
  try {
    await assertRejects(() => desktopPackageFlags(entry, "linux", false), Error, "config exploded");
    await assertRejects(() => desktopIncludeArgs(entry, "linux"), Error, "config exploded");
    await assertRejects(() => desktopInstallerPlan(entry, "linux"), Error, "config exploded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("no config at all is still the defaults", async () => {
  const { dir, entry } = await project({});
  try {
    assertEquals(await loadConfigBeside(entry), undefined);
    const flags = await desktopPackageFlags(entry, "linux", false);
    assertEquals(flags, ["--allow-net=127.0.0.1,localhost", "--allow-read", "--allow-env"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a script served over http: a missing config is the defaults, a broken one fails", async () => {
  // Off `file:` there is no directory to stat: the config is imported, and only a missing module
  // (Deno's "Module not found", a 404) reads as "no config". In a child with `--no-lock`, so the
  // loopback server's random-port URLs never reach the checkout's deno.lock.
  const { value } = await inChild<[unknown, unknown, string]>({
    lock: false,
    imports: `import { loadConfigBeside } from "@repo/src/build/desktop-config-beside.ts";`,
    body: `
      const configs = {
        "/broken/denext.config.ts": 'throw new Error("remote config exploded");\\n',
        "/configured/denext.config.ts": ${JSON.stringify(CLIPBOARD)},
      };
      const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
        const text = configs[new URL(req.url).pathname];
        return text === undefined
          ? new Response("not found", { status: 404 })
          : new Response(text, { headers: { "content-type": "application/typescript" } });
      });
      const base = "http://127.0.0.1:" + server.addr.port;
      try {
        const missing = await loadConfigBeside(base + "/missing/scripts/package-linux.ts");
        const configured = await loadConfigBeside(base + "/configured/scripts/package-linux.ts");
        const broken = await loadConfigBeside(base + "/broken/scripts/package-linux.ts")
          .then(() => "resolved", (err) => String(err));
        return [missing ?? "undefined", configured.desktop, broken];
      } finally {
        await server.shutdown();
      }
    `,
  });
  assertEquals(value[0], "undefined");
  assertEquals(value[1], { capabilities: { clipboard: true } });
  assertStringIncludes(value[2], "remote config exploded");
});
