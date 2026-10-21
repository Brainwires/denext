// The installed `denext` binary, verb by verb, with nothing but the binary: `--version`,
// `migrate --check` and `migrate` on a small Next.js app, `create`, `generate`, `routes`,
// `patch … denext`, `build` and the MCP server. A `deno compile`d CLI carries only the files scripts/compile-cli.ts embeds;
// the 4.5.1 binary embedded no `deno.json`, so `migrate` stopped at "could not read the framework
// version" and the MCP server answered version 0.0.0 with no `denext://guide`, while every test
// that ran the CLI from source passed.
//
// Opt-in and heavy (it compiles the CLI; `build` runs the pinned denext from JSR):
// DENEXT_TEST_COMPILED_CLI=1. `DENEXT_SMOKE_BINARY=<path>` runs it against a binary built
// elsewhere (the release workflow's artifact) instead of compiling this checkout.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { VERSION } from "../../src/version.ts";
import { compiledCli, runCli } from "./_compiled-cli.ts";

const enabled = Deno.env.get("DENEXT_TEST_COMPILED_CLI") === "1" ||
  Deno.env.get("DENEXT_SMOKE_BINARY") !== undefined;

const skipped = enabled ? "" : " (skipped: set DENEXT_TEST_COMPILED_CLI=1)";

/** A run's output, for an assertion message. */
const show = (r: { code: number; out: string; err: string }) =>
  `exit ${r.code}\n--- stdout\n${r.out}\n--- stderr\n${r.err}`;

/** Write `files` (relative path → text) under `dir`. */
async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** The smallest Next.js App Router app `migrate` takes. */
const NEXT_APP = {
  "package.json": JSON.stringify({
    name: "smoke-next",
    dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
  }),
  "app/layout.tsx":
    "export default function Layout({ children }: { children: unknown }) {\n  return <html><body>{children}</body></html>;\n}\n",
  "app/page.tsx": "export default function Page() {\n  return <p>hello</p>;\n}\n",
};

/**
 * The denext version a `build` can fetch from JSR: this one once it is published, else the
 * newest published release (a version bump is tested before its tag publishes it). `build`
 * itself runs the denext the project pins; what the binary contributes is finding the pin and
 * handing the invocation over, the same for either version.
 */
async function publishedDenext(): Promise<string> {
  const res = await fetch("https://jsr.io/@denext/denext/meta.json");
  if (!res.ok) throw new Error(`jsr.io meta.json: ${res.status}`);
  const meta = await res.json() as { latest: string; versions: Record<string, unknown> };
  return VERSION in meta.versions ? VERSION : meta.latest;
}

Deno.test({
  name: `the compiled denext runs its verbs with nothing but the binary${skipped}`,
  ignore: !enabled,
  async fn(t) {
    const bin = await compiledCli();
    const tmp = await Deno.makeTempDir({ prefix: "denext_binary_smoke_" });
    // `create` / `migrate` pin the newest denext Deno's dependency-age hold lets in: this
    // version, or (before its tag publishes it) the newest published one.
    const published = await publishedDenext();
    const pinned = (spec: string) =>
      [VERSION, published].some((v) => spec === `jsr:@denext/denext@^${v}`);
    try {
      await t.step("--version", async () => {
        const r = await runCli(bin, ["--version"], tmp);
        assertEquals(r.code, 0, show(r));
        assertEquals(r.out.trim(), `denext ${VERSION} (binary)`);
      });

      const next = join(tmp, "next-app");
      await writeTree(next, NEXT_APP);
      await t.step("migrate --check on a Next.js app", async () => {
        const r = await runCli(bin, ["migrate", "--check"], next);
        assertEquals(r.code, 0, show(r));
        assert(!`${r.out}${r.err}`.includes("blocked"), show(r));
        assertStringIncludes(r.out, "verdict: ready");
      });

      await t.step("migrate writes the framework's version and subpaths", async () => {
        const r = await runCli(bin, ["migrate", ".", "--yes"], next);
        assertEquals(r.code, 0, show(r));
        const { imports } = JSON.parse(await Deno.readTextFile(join(next, "deno.json"))) as {
          imports: Record<string, string>;
        };
        assert(pinned(imports.denext), imports.denext);
        // The `next/*` aliases come from the framework's own deno.json `exports`.
        assertEquals(imports["next/link"], `${imports.denext}/next/link`);
      });

      await t.step("the MCP server knows its version and serves the guide", async () => {
        const child = new Deno.Command(bin, {
          args: ["mcp"],
          cwd: tmp,
          env: { NO_COLOR: "1" },
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const requests = [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "resources/read",
            params: { uri: "denext://guide" },
          },
        ];
        const writer = child.stdin.getWriter();
        await writer.write(
          new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"),
        );
        await writer.close();
        const { stdout, stderr } = await child.output();
        const lines = new TextDecoder().decode(stdout).split("\n").filter((l) => l.startsWith("{"));
        const byId = new Map(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
        const err = new TextDecoder().decode(stderr);
        assertEquals(byId.get(1)?.result?.serverInfo?.version, VERSION, err);
        const guide = byId.get(2)?.result?.contents?.[0]?.text as string | undefined;
        assert(guide?.startsWith("# Writing denext apps"), JSON.stringify(byId.get(2)) + err);
      });

      const app = join(tmp, "app");
      await t.step("create", async () => {
        const r = await runCli(bin, ["create", "app", "--yes"], tmp);
        assertEquals(r.code, 0, show(r));
        const { imports } = JSON.parse(await Deno.readTextFile(join(app, "deno.json"))) as {
          imports: Record<string, string>;
        };
        assert(pinned(imports.denext), imports.denext);
      });

      await t.step("generate", async () => {
        const r = await runCli(bin, ["generate", "page", "about"], app);
        assertEquals(r.code, 0, show(r));
      });

      await t.step("routes", async () => {
        const r = await runCli(bin, ["routes"], app);
        assertEquals(r.code, 0, show(r));
        assertStringIncludes(r.out, "/about");
      });

      await t.step({
        name: "patch denext targets the published copy the app runs",
        // The pristine file comes from this version on JSR: not there before its tag.
        ignore: published !== VERSION,
        fn: async () => {
          const edit = await runCli(
            bin,
            ["patch", "edit", "denext", "src/server/document.ts"],
            app,
          );
          assertEquals(edit.code, 0, show(edit));
          const work = join(app, "patches/.work/denext/src/server/document.ts");
          await Deno.writeTextFile(work, (await Deno.readTextFile(work)) + "\n// patched\n");
          const create = await runCli(bin, ["patch", "create", "denext"], app);
          assertEquals(create.code, 0, show(create));
          await Deno.stat(join(app, `patches/denext+${VERSION}.patch`));
          const { imports } = JSON.parse(await Deno.readTextFile(join(app, "deno.json"))) as {
            imports: Record<string, string>;
          };
          const key = `https://jsr.io/@denext/denext/${VERSION}/src/server/document.ts`;
          assertEquals(
            imports[key],
            "./patches/denext/src/server/document.ts",
            Object.keys(imports).join("\n"),
          );
          const del = await runCli(bin, ["patch", "delete", "denext"], app);
          assertEquals(del.code, 0, show(del));
        },
      });

      await t.step("build (on the denext the app pins)", async () => {
        if (published !== VERSION) {
          const path = join(app, "deno.json");
          const config = await Deno.readTextFile(path);
          await Deno.writeTextFile(path, config.replaceAll(`@^${VERSION}`, `@^${published}`));
          await Deno.remove(join(app, "deno.lock")).catch(() => {});
        }
        const r = await runCli(bin, ["build"], app);
        assertEquals(r.code, 0, show(r));
        await Deno.stat(join(app, ".denext"));
      });
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});
