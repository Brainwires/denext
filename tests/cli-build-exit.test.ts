// `denext build` / `denext export` end when the build is done, even when an app module holds
// the event loop open at its top level (a database pool that connects eagerly, a Redis client,
// an interval): the build imports the app's server modules, and before the fix the finished
// verb waited on that handle forever.
//
// Local (file://) framework, no network: each verb runs as a real CLI subprocess.

import { assert } from "@std/assert";
import { join } from "@std/path";

const REPO = new URL("../", import.meta.url);
const CLI = new URL("cli.ts", REPO);
const TIMEOUT_MS = 180_000;

/** A native app whose page imports a module that keeps an interval running. */
async function scaffold(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-build-exit-" });
  const at = (p: string) => new URL(p, REPO).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": at("mod.ts"),
        "denext/jsx-runtime": at("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": at("src/jsx/jsx-runtime.ts"),
        "denext/server": at("src/server/mod.ts"),
      },
    }),
  );
  await Deno.mkdir(join(dir, "app"));
  await Deno.mkdir(join(dir, "lib"));
  await Deno.writeTextFile(
    join(dir, "lib", "pool.ts"),
    "// Stands in for a driver pool that opens connections when it is created.\n" +
      "setInterval(() => {}, 60_000);\nexport const pool = { size: 1 };\n",
  );
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    "export default function Root({ children }: { children: unknown }) {\n" +
      "  return <html><body>{children}</body></html>;\n}\n",
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `import { pool } from "../lib/pool.ts";\n` +
      "export default function Home() {\n  return <p>pool of {pool.size}</p>;\n}\n",
  );
  return dir;
}

for (const verb of ["build", "export"]) {
  Deno.test({
    name: `cli: \`denext ${verb}\` exits when an app module holds the event loop open`,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    const dir = await scaffold();
    try {
      const started = Date.now();
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", CLI.href, verb, "."],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).output().catch((e) => e as Error);
      assert(
        !(out instanceof Error),
        `\`denext ${verb}\` was still running after ${Date.now() - started} ms: ${out}`,
      );
      const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
      assert(out.success, `\`denext ${verb}\` failed:\n${text}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
