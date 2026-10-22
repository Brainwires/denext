// Prepare the "migrated Next" column: copy the UNMODIFIED bench/fixtures/next-hello
// app (plus the package.json every real Next app has), run `denext migrate` on the
// copy, and point the generated deno.json at THIS checkout's denext instead of the
// published jsr release, so the column measures the code under test. The copy lives
// in bench/.migrated/ (git-ignored) and is rebuilt on every run.

import { join } from "@std/path";

const REPO = new URL("../../", import.meta.url).pathname;

async function copyFixture(src: string, dest: string): Promise<void> {
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await Deno.mkdir(dest, { recursive: true });
  for await (const e of Deno.readDir(src)) {
    if (e.name === ".next" || e.name === "node_modules") continue;
    await new Deno.Command("cp", { args: ["-R", join(src, e.name), dest] }).output();
  }
}

async function writePackageJson(dest: string): Promise<void> {
  const bench = JSON.parse(await Deno.readTextFile(join(REPO, "bench/package.json")));
  const v = bench.devDependencies;
  await Deno.writeTextFile(
    join(dest, "package.json"),
    JSON.stringify({
      name: "next-hello",
      private: true,
      dependencies: { next: v.next, react: v.react, "react-dom": v["react-dom"] },
    }),
  );
}

/** The checkout path for a `jsr:@denext/denext@…/sub` import, or null for any other specifier. */
function checkoutPath(spec: string, exp: Record<string, string>): string | null {
  const m = spec.match(/^jsr:@denext\/denext@[^/]+(\/.*)?$/);
  const target = m ? exp["." + (m[1] ?? "")] : undefined;
  return target ? join(REPO, target) : null;
}

/** Point every `jsr:@denext/denext@…/sub` import at this checkout's matching export. */
async function pointImportsAtCheckout(cfgPath: string): Promise<void> {
  const rootCfg = JSON.parse(await Deno.readTextFile(join(REPO, "deno.json")));
  const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
  for (const [k, spec] of Object.entries<string>(cfg.imports)) {
    cfg.imports[k] = checkoutPath(spec, rootCfg.exports) ?? spec;
  }
  await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
}

export async function prepareMigratedNext(): Promise<string> {
  const dest = join(REPO, "bench/.migrated/next-hello");
  await copyFixture(join(REPO, "bench/fixtures/next-hello"), dest);
  await writePackageJson(dest);
  const mig = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(REPO, "cli.ts"), "migrate", dest],
    stdout: "null",
    stderr: "inherit",
  }).output();
  if (!mig.success) throw new Error("denext migrate failed");
  await pointImportsAtCheckout(join(dest, "deno.json"));
  return dest;
}
