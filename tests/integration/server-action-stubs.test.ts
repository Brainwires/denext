// A `"use server"` module never reaches the browser, however a client module spells its import.
//
// `deno bundle` resolves an app module's alias imports (`@/app/actions.ts`, `#actions`) with the
// app's own `deno.json`, so a stub keyed by the action's file URL was reached only by a relative
// import: through an alias, a re-export, a barrel or a platform file's rewritten copy, the
// action's source — secrets included — shipped in a public client chunk (3.1.0 and earlier).
// Each case here builds a real app through the CLI (the app's own config, as `denext` runs it)
// and checks EVERY client asset for the secret, then calls the action through the stub's id to
// prove the stub still reaches the server: `denext build` + `start`, `denext export` (web and
// `--platform ios`), the dev server (its unbundled modules), and SPA mode, which has no server
// to call and so refuses the bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, relative, toFileUrl } from "@std/path";
import { walk } from "@std/fs";
import { actionEndpoint, actionIdFor, encodeActionArgs } from "../../src/runtime/server-action.ts";
import { serverModuleIdFor } from "../../src/build/boundary-ids.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const SECRET = "SERVER_SECRET_123";
/** What the action returns for `"hi"`: the secret's length, so the result never carries it. */
const RESULT = `${SECRET.length}:hi`;

/** How the island imports the action. */
type Spelling = "alias" | "hash" | "barrel" | "platform";

const ACTION = `"use server";
const SECRET = "${SECRET}";
export async function act(x: string) { return SECRET.length + ":" + x; }
`;

/**
 * The island's import of `act`, and any extra files that spelling needs. `platform`: the action
 * imports a module with `.web` / `.ios` variants through the alias, so the platform resolution
 * copies the action and every module that reaches it through one.
 */
function spellingFiles(spelling: Spelling): { spec: string; files: Record<string, string> } {
  switch (spelling) {
    case "alias":
      return { spec: "@/app/actions.ts", files: {} };
    case "hash":
      return { spec: "#actions", files: {} };
    case "barrel":
      return {
        spec: "@/components/index.ts",
        files: { "components/index.ts": `export { act } from "@/app/actions.ts";\n` },
      };
    case "platform":
      return {
        spec: "@/app/actions.ts",
        files: {
          "app/actions.ts": ACTION.replace(
            `const SECRET`,
            `import { label } from "@/lib/label.ts";\nexport const where = () => label;\nconst SECRET`,
          ),
          "lib/label.ts": `export const label = "plain";\n`,
          "lib/label.web.ts": `export const label = "web";\n`,
          "lib/label.ios.ts": `export const label = "ios";\n`,
        },
      };
  }
}

/** A throwaway app whose island imports the action by `spelling`; `spa` makes it a SPA. */
async function app(spelling: Spelling, spa = false): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_action_stub_" }));
  const { spec, files } = spellingFiles(spelling);
  const island = `"use client";
import { useState } from "denext";
import { act } from "${spec}";
export function Island() {
  const [r, setR] = useState("");
  return <button type="button" onClick={async () => setR(await act("hi"))}>ISLAND {r}</button>;
}
`;
  const all: Record<string, string> = {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${FW}mod.ts`,
        "denext/": `${FW}src/`,
        "denext/jsx-runtime": `${FW}src/jsx/jsx-runtime.ts`,
        "denext/jsx-dev-runtime": `${FW}src/jsx/jsx-runtime.ts`,
        "denext/server": `${FW}src/server/mod.ts`,
        "denext/client": `${FW}src/client/mod.ts`,
        "@/": "./",
        "#actions": "./app/actions.ts",
      },
    }),
    "app/actions.ts": ACTION,
    "components/Island.tsx": island,
    ...files,
  };
  if (spa) {
    all["denext.config.ts"] = `export default { mode: "spa", spa: { entry: "./src/main.tsx" } };\n`;
    all["src/main.tsx"] = `import { createRoot } from "denext/client";\n` +
      `import { Island } from "@/components/Island.tsx";\n` +
      `createRoot(document.getElementById("root")!).render(<Island />);\n`;
  } else {
    all["app/layout.tsx"] =
      `export default function Layout({ children }: { children: unknown }) {\n` +
      `  return <html><body>{children}</body></html>;\n}\n`;
    all["app/page.tsx"] = `import { Island } from "@/components/Island.tsx";\n` +
      `export default function Page() { return <main><Island /></main>; }\n`;
  }
  for (const [name, text] of Object.entries(all)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

/** The action's stable id, as the server registers it and its stub names it. */
async function actionId(dir: string): Promise<string> {
  const url = toFileUrl(await Deno.realPath(join(dir, "app/actions.ts"))).href;
  return actionIdFor(serverModuleIdFor(join(dir, "app"), url), "act");
}

/** The CLI under the app's own config, the way `denext` runs a project. */
function cliArgs(dir: string, args: string[]): string[] {
  return ["run", "-A", "--config", join(dir, "deno.json"), join(FW, "cli.ts"), ...args];
}

/** Run a CLI verb to completion. */
async function cli(dir: string, args: string[]): Promise<{ code: number; output: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: cliArgs(dir, args),
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  const dec = new TextDecoder();
  return { code, output: dec.decode(stdout) + dec.decode(stderr) };
}

/** Every file under `root` (all of a client output: chunks, maps, HTML, precompressed copies). */
async function allText(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const e of walk(root, { includeDirs: false })) {
    const bytes = await Deno.readFile(e.path);
    out.set(relative(root, e.path), new TextDecoder().decode(bytes));
  }
  return out;
}

/** Gunzip a precompressed asset's text (the scan reads those too). */
async function gunzip(path: string): Promise<string> {
  const stream = (await Deno.open(path)).readable.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/** Assert no asset under `root` carries the secret (gzip copies decompressed), and return them. */
async function assertNoSecret(root: string): Promise<Map<string, string>> {
  const files = await allText(root);
  assert(files.size > 0, `no client assets under ${root}`);
  for (const [name, text] of files) {
    const body = name.endsWith(".gz") ? await gunzip(join(root, name)) : text;
    assert(!body.includes(SECRET), `the action's secret shipped in ${name}`);
  }
  return files;
}

/** A free localhost port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

/** A long-running CLI server (`start` / `dev`) on a free port, ready to answer `/`. */
async function server(dir: string, verb: "start" | "dev") {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: cliArgs(dir, [verb, "--port", String(port)]),
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).spawn();
  // Keep what the server prints (drained, so a full pipe never stalls it) for a failure message.
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-8000);
    }
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  const exited = child.status.then((s) => s);
  let exitCode: number | null = null;
  exited.then((s) => exitCode = s.code);
  // `localhost`: `denext dev` binds it, which a runner may resolve to `::1` only (`start` binds
  // 0.0.0.0); the client tries each address the name resolves to.
  const origin = `http://localhost:${port}`;
  // Generous: a loaded machine takes a while to start (and, in dev, to build) the server.
  let ready = false;
  for (
    const deadline = Date.now() + 300_000;
    !ready && exitCode === null && Date.now() < deadline;
  ) {
    try {
      const res = await fetch(`${origin}/`);
      await res.body?.cancel();
      ready = res.ok;
    } catch { /* not listening yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 250));
  }
  const stop = async () => {
    if (exitCode === null) child.kill("SIGTERM");
    await exited;
    await drained;
  };
  if (!ready) {
    await stop();
    throw new Error(
      `denext ${verb} did not answer / (exit ${exitCode ?? "none, timed out"}):\n${output}`,
    );
  }
  return { origin, stop };
}

/** Call the action the way its stub does (same-origin POST to its endpoint). */
async function callAction(origin: string, id: string): Promise<unknown> {
  const { body, headers } = encodeActionArgs(["hi"]);
  const res = await fetch(`${origin}${actionEndpoint(id)}`, {
    method: "POST",
    headers: { ...headers, origin, "x-denext-action": "1" },
    body,
  });
  const data = await res.json() as { result?: unknown; error?: string };
  assertEquals(res.status, 200, `action call failed: ${JSON.stringify(data)}`);
  return data.result;
}

/** The text of every `/_denext/` module a dev page loads (static and dynamic imports). */
async function devModules(origin: string): Promise<Map<string, string>> {
  const html = await (await fetch(`${origin}/`)).text();
  const seen = new Map<string, string>();
  const find = (text: string) =>
    [...text.matchAll(/["'](\/_denext\/[^"'\s]+)["']/g)].map((m) => m[1])
      // The framework's own modules (dependencies, or its checkout's sources) hold no app code.
      .filter((u) =>
        !u.startsWith("/_denext/@dep/") && !u.startsWith(`/_denext/@fs${FW}`) &&
        !u.endsWith(".css")
      );
  let queue = find(html);
  while (queue.length > 0) {
    const next: string[] = [];
    for (const u of queue) {
      if (seen.has(u)) continue;
      // Modules only: the reload event stream (and any other non-module URL) never ends.
      const res = await fetch(`${origin}${u}`, { signal: AbortSignal.timeout(60_000) });
      if (!(res.headers.get("content-type") ?? "").includes("javascript")) {
        await res.body?.cancel();
        continue;
      }
      const text = await res.text();
      seen.set(u, text);
      next.push(...find(text));
    }
    queue = next;
  }
  return seen;
}

const SPELLINGS: Spelling[] = ["alias", "hash", "barrel", "platform"];

const opts = { sanitizeOps: false, sanitizeResources: false };

for (const spelling of SPELLINGS) {
  Deno.test({
    name: `denext build + start: an action imported by ${spelling} ships as its stub`,
    ...opts,
  }, async () => {
    const dir = await app(spelling);
    try {
      const built = await cli(dir, ["build"]);
      assertEquals(built.code, 0, built.output);
      const files = await assertNoSecret(join(dir, ".denext", "client"));
      const id = await actionId(dir);
      assert(
        [...files.values()].some((t) => t.includes(id)),
        "the island bundle carries the action's stub",
      );
      const srv = await server(dir, "start");
      try {
        assertEquals(await callAction(srv.origin, id), RESULT);
      } finally {
        await srv.stop();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  Deno.test(
    { name: `denext export: an action imported by ${spelling} ships as its stub`, ...opts },
    async () => {
      const dir = await app(spelling);
      try {
        const platforms = spelling === "platform" ? [[], ["--platform", "ios"]] : [[]];
        for (const flags of platforms) {
          const exported = await cli(dir, ["export", ...flags]);
          assertEquals(exported.code, 0, exported.output);
          const files = await assertNoSecret(join(dir, "out"));
          const id = await actionId(dir);
          assert([...files.values()].some((t) => t.includes(id)), `stub missing (${flags})`);
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  );

  Deno.test({
    name: `denext dev: an action imported by ${spelling} is served as its stub`,
    ...opts,
  }, async () => {
    const dir = await app(spelling);
    const srv = await server(dir, "dev");
    try {
      const modules = await devModules(srv.origin);
      for (const [url, text] of modules) {
        assert(!text.includes(SECRET), `the action's secret was served at ${url}`);
      }
      const id = await actionId(dir);
      assert([...modules.values()].some((t) => t.includes(id)), "the page loads the stub");
      // Asked for directly, the module is still its stub.
      const direct = await (await fetch(`${srv.origin}/_denext/@fs${dir}/app/actions.ts`)).text();
      assert(!direct.includes(SECRET), "the action module is never served as written");
      assertStringIncludes(direct, id);
      assertEquals(await callAction(srv.origin, id), RESULT);
    } finally {
      await srv.stop();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// A page that hydrates as a whole (a hook, no "use client") bundles its own imports: an action
// it imports, even relatively, ships as its stub and is called on the server.
Deno.test({
  name: "denext build: a whole-route bundle ships an action it imports as its stub",
  ...opts,
}, async () => {
  const dir = await app("alias");
  try {
    await Deno.remove(join(dir, "components"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app/page.tsx"),
      `import { useState } from "denext";\nimport { act } from "./actions.ts";\n` +
        `export default function Page() {\n  const [r, setR] = useState("");\n` +
        `  return <button type="button" onClick={async () => setR(await act("hi"))}>{r}</button>;\n}\n`,
    );
    const built = await cli(dir, ["build"]);
    assertEquals(built.code, 0, built.output);
    const files = await assertNoSecret(join(dir, ".denext", "client"));
    const id = await actionId(dir);
    assert([...files.values()].some((t) => t.includes(id)), "the route bundle carries the stub");
    const srv = await server(dir, "start");
    try {
      assertEquals(await callAction(srv.origin, id), RESULT);
    } finally {
      await srv.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  { name: 'SPA mode: a bundle that reaches a "use server" module is refused', ...opts },
  async () => {
    const dir = await app("alias", true);
    try {
      const built = await cli(dir, ["build"]);
      assert(built.code !== 0, "a SPA has no server to call: the build must fail");
      assertStringIncludes(built.output, `a "use server" module would ship to the browser`);
      assertStringIncludes(built.output, join("app", "actions.ts"));
      assertStringIncludes(built.output, join("components", "Island.tsx"));
      for await (const e of walk(join(dir, ".denext"), { includeDirs: false })) {
        const text = await Deno.readTextFile(e.path).catch(() => "");
        assert(!text.includes(SECRET), `the action's secret was written to ${e.path}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test({ name: "SPA dev: the action module is served as its stub", ...opts }, async () => {
  const dir = await app("alias", true);
  const srv = await server(dir, "dev");
  try {
    const direct = await (await fetch(`${srv.origin}/_denext/@fs${dir}/app/actions.ts`)).text();
    assert(!direct.includes(SECRET), "the action module is never served as written");
    assertStringIncludes(direct, "clientActionStub");
  } finally {
    await srv.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * An action whose module imports a module with a `.web` variant (relatively, so the server render
 * loads a COPY of the action module that reaches the variant): the server registers the copy the
 * render uses, so the action runs the variant, in `start` and in `dev` alike. (A static export has
 * no server to call.)
 */
async function variantApp(): Promise<string> {
  const dir = await app("alias");
  await Deno.writeTextFile(
    join(dir, "app/actions.ts"),
    ACTION.replace(`const SECRET`, `import { fmt } from "./fmt.ts";\nconst SECRET`)
      .replace(`return SECRET.length + ":" + x;`, `return fmt(SECRET.length + ":" + x);`),
  );
  await Deno.writeTextFile(
    join(dir, "app/fmt.ts"),
    `export const fmt = (s: string) => "plain:" + s;\n`,
  );
  await Deno.writeTextFile(
    join(dir, "app/fmt.web.ts"),
    `export const fmt = (s: string) => "web:" + s;\n`,
  );
  return dir;
}

for (const verb of ["start", "dev"] as const) {
  Deno.test({
    name: `denext ${verb}: an action whose module reaches a .web variant runs the variant`,
    ...opts,
  }, async () => {
    const dir = await variantApp();
    try {
      if (verb === "start") {
        const built = await cli(dir, ["build"]);
        assertEquals(built.code, 0, built.output);
      }
      const srv = await server(dir, verb);
      try {
        // The page renders first (the render loads the action module's copy), then the call.
        assertEquals(await callAction(srv.origin, await actionId(dir)), `web:${RESULT}`);
      } finally {
        await srv.stop();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
