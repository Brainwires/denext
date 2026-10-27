// Inline `"use server"` functions (src/build/inline-server-action.ts):
//   - on the server they become registered server references (hoisted to module scope when
//     nested); one that closes over an enclosing function's values gets them bound (sealed into
//     its reference id, tests/action-bound.test.ts);
//   - no client bundle may ship one: the compat (esbuild) and native (`deno bundle`) client
//     builds fail with Next's error, and the unbundled dev server serves the error instead.
// Before, a client component's inline action shipped its body to the browser, and a Server
// Component's inline action rendered a `<form>` with no `action`.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  findInlineServerActions,
  INLINE_ACTION_IN_CLIENT_ERROR,
  inlineActionModuleKey,
  InlineServerActionError,
  transformInlineServerActions,
} from "../src/build/inline-server-action.ts";
import { setBuildActionIdSecret } from "../src/server/action-ids.ts";
import { restoreActionIdStateAfterEachTest } from "./helpers/action-id-state.ts";
import { generateServerStub } from "../src/build/client-imports.ts";
import { serverStubPlugin, stopNextCompat } from "../src/build/next-compat.ts";
import { ACTION_PREFIX, getServerAction, isServerAction } from "../src/runtime/server-action.ts";
import { resolveAction } from "../src/server/action-handler.ts";
import { sealBoundValues } from "../src/server/action-bound.ts";
import { buildInChild } from "./helpers/bounded-build.ts";

// A test that installs a build secret or sets DENEXT_ACTION_ID_SECRET hands the next one the
// state as it found it, even when it fails half-way.
restoreActionIdStateAfterEachTest();

const MOD = "file:///app/page.tsx";

Deno.test("a nested inline action is hoisted to a registered reference; its site reads it", async () => {
  const src = `import { db } from "./db.ts";
export default function Page() {
  async function add(fd: FormData) {
    "use server";
    await db.add(fd.get("title"));
  }
  return <form action={add} />;
}
`;
  const { code, changed } = await transformInlineServerActions(src, MOD);
  assert(changed);
  assertStringIncludes(code, "inlineServerReference as _dnxServerRef");
  assertStringIncludes(code, "const add = _dnxInlineAction0;");
  assert(
    /const _dnxInlineAction0 = _dnxServerRef\("a[\w-]+", async function add\(fd: FormData\) \{\s*"use server";/
      .test(code),
    code,
  );
  // Hoisted after the component: the body no longer sits inside it.
  assert(code.indexOf("_dnxInlineAction0 = ") > code.indexOf("return <form"), code);
});

Deno.test("inline action ids are keyed by the project-relative path, so builds at other roots agree", async () => {
  const src = `export async function save() { "use server"; return 1; }\n`;
  const idOf = (code: string) => /_dnxServerRef\("(a[\w-]+)"/.exec(code)![1];
  setBuildActionIdSecret("shared-deploy-secret-for-two-roots");
  try {
    const here = await transformInlineServerActions(src, "file:///srv/a/app/page.tsx", {
      projectDir: "/srv/a",
    });
    const there = await transformInlineServerActions(src, "file:///srv/b/app/page.tsx", {
      projectDir: "/srv/b",
    });
    assertEquals(idOf(here.code), idOf(there.code), "one source, one secret: one id");
    assertEquals(
      inlineActionModuleKey("file:///srv/a/app/page.tsx", "/srv/a"),
      "app/page.tsx",
      "`/`-separated, however the OS spells paths",
    );
    const other = await transformInlineServerActions(src, "file:///srv/a/app/other.tsx", {
      projectDir: "/srv/a",
    });
    assertNotEquals(idOf(other.code), idOf(here.code), "another module: another id");
    // Without a project root the absolute URL keys it, so the two roots differ.
    const absA = await transformInlineServerActions(src, "file:///srv/a/app/page.tsx");
    const absB = await transformInlineServerActions(src, "file:///srv/b/app/page.tsx");
    assertNotEquals(idOf(absA.code), idOf(absB.code));
    assertEquals(inlineActionModuleKey("file:///srv/a/app/page.tsx"), "file:///srv/a/app/page.tsx");
  } finally {
    setBuildActionIdSecret(null);
  }
});

Deno.test("a module-scope inline action is registered in place, exports kept", async () => {
  const src = `export async function save() { "use server"; return 1; }
export const remove = async () => { "use server"; return 2; };
`;
  const { code } = await transformInlineServerActions(src, MOD);
  assert(/export const save = _dnxServerRef\("a[\w-]+", async function save\(\)/.test(code));
  assert(/export const remove = _dnxServerRef\("a[\w-]+", async \(\) =>/.test(code), code);
  assert(!code.includes("_dnxInlineAction"), "nothing hoisted at module scope");
});

Deno.test("the registered reference is a server action: callable, with its endpoint id", async () => {
  const { code } = await transformInlineServerActions(
    `export default function Page() {\n  async function ping(n: number) { "use server"; return n + 1; }\n  return ping;\n}\n`,
    MOD,
  );
  const dir = await Deno.makeTempDir({ prefix: "denext_inline_action_" });
  try {
    const file = join(dir, "page.ts");
    // The type annotation is fine for Deno; the JSX-free fixture imports as plain TS.
    await Deno.writeTextFile(file, code);
    const mod = await import(`file://${file}`);
    const ping = mod.default();
    assert(isServerAction(ping), "tagged as a server action");
    assertEquals(await ping(1), 2);
    assert(mod.default() === ping, "every render reads the same registered reference");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an inline action that closes over a component's values gets them bound", async () => {
  const src = `export default function Page({ id }: { id: string }) {
  const prefix = "p";
  async function del() { "use server"; await remove(prefix + id); }
  return <form action={del} />;
}
`;
  const { code } = await transformInlineServerActions(src, MOD);
  // The hoisted function takes the values it reads first, in a stable (sorted) order.
  assert(
    /const _dnxInlineAction0 = _dnxServerRef\("a[\w-]+", \(id, prefix, \.\.\.args\) => \(async function del\(\)/
      .test(code),
    code,
  );
  // The site binds them, read lazily; the declaration moved to the top of its block.
  assertStringIncludes(
    code,
    'export default function Page({ id }: { id: string }) {const del = _dnxBindAction(_dnxInlineAction0, () => [id, prefix], "del");',
  );
  assertEquals(code.match(/async function del/g)?.length, 1, "the body is in one place");
});

Deno.test("a bound inline action runs with the values its component had", async () => {
  const { code } = await transformInlineServerActions(
    `export default function Page(n: number) {
  // Declared above the value it reads, and used above its own declaration: both hoisted.
  const early = ping;
  async function ping(m: number) { "use server"; return [base, n, m]; }
  const base = "b";
  return { early, ping };
}
`,
    MOD,
  );
  const dir = await Deno.makeTempDir({ prefix: "denext_inline_bound_" });
  try {
    const file = join(dir, "page.ts");
    await Deno.writeTextFile(file, code);
    const mod = await import(`file://${file}`);
    const { early, ping } = mod.default(7);
    assert(early === ping, "a use above the declaration reads the same reference");
    assert(isServerAction(ping), "tagged as a server action");
    assertEquals(await ping(1), ["b", 7, 1]);
    assert(ping.denextActionId.includes("."), "its id carries the sealed values");
    assert(mod.default(8).ping.denextActionId !== ping.denextActionId, "a render per values");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a "use server" method is a build error naming it', async () => {
  const src = `export default function Page() {
  const o = { async m() { "use server"; return 1; } };
  return o;
}
`;
  const err = await assertRejects(
    () => transformInlineServerActions(src, MOD),
    InlineServerActionError,
  );
  assertStringIncludes(err.message, 'a "use server" method is not supported');
  assertStringIncludes(err.message, `${MOD}:2:15`);
});

Deno.test('a "use server" module, or a module with no inline action, is left as written', async () => {
  const actions = `"use server";\nexport async function a() { "use server"; return 1; }\n`;
  assertEquals((await transformInlineServerActions(actions, MOD)).changed, false);
  assertEquals(await findInlineServerActions(actions), []);
  const plain =
    `export const label = "use server";\nexport function f() { return "use server"; }\n`;
  assertEquals((await transformInlineServerActions(plain, MOD)).changed, false);
  assertEquals(await findInlineServerActions(plain), []);
});

Deno.test("findInlineServerActions: every inline action's position", async () => {
  const src =
    `"use client";\nexport function W() {\n  async function a() { "use server"; }\n  const b = async () => {\n    "use server";\n  };\n  return null;\n}\n`;
  assertEquals(await findInlineServerActions(src), ["3:3", "4:13"]);
});

/** A temp dir holding `files` (project-relative path → source). */
async function tempApp(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix }));
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

const SECRET = "SECRET_ACTION_BODY";

const CLIENT_WITH_INLINE = `"use client";
export function Widget() {
  async function leak() { "use server"; return "${SECRET}"; }
  return <button type="button">{typeof leak}</button>;
}
`;

Deno.test({
  name: "compat client bundle: an inline action in client code fails the build, never ships",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const esbuild = await import("../src/build/esbuild/mod.ts");
  const dir = await tempApp("denext_inline_client_", {
    "widget.tsx": CLIENT_WITH_INLINE,
    // Reached only from client code: Next refuses it as well.
    "helper.ts": `export async function helper() { "use server"; return "${SECRET}"; }\n`,
    "entry.ts": `export { Widget } from "./widget.tsx";\nexport { helper } from "./helper.ts";\n`,
  });
  try {
    const outdir = join(dir, "out");
    const err = await assertRejects(
      () =>
        esbuild.build({
          entryPoints: [join(dir, "entry.ts")],
          bundle: true,
          outdir,
          format: "esm",
          platform: "browser",
          jsx: "automatic",
          external: ["react", "react/jsx-runtime"],
          plugins: [serverStubPlugin([], generateServerStub)],
          logLevel: "silent",
        }),
      Error,
    );
    assertStringIncludes(err.message, INLINE_ACTION_IN_CLIENT_ERROR.split("\n")[0]);
    assertStringIncludes(err.message, "widget.tsx:3:3");
    assertStringIncludes(err.message, "helper.ts:1:8");
    const written = await Array.fromAsync(Deno.readDir(outdir)).catch(() => []);
    assertEquals(written, [], "no client output was written");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

/** The path of a framework file (an import-map target for a native temp app). */
const fw = (p: string) => fromFileUrl(new URL(`../${p}`, import.meta.url));

Deno.test({
  name: "native client bundle: an inline action in a client component fails the build",
}, async () => {
  const dir = await tempApp("denext_inline_native_", {
    "deno.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      nodeModulesDir: "manual",
      imports: {
        "denext": fw("mod.ts"),
        "denext/jsx-runtime": fw("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": fw("src/jsx/jsx-runtime.ts"),
        "denext/server": fw("src/server/mod.ts"),
        "denext/client": fw("src/client/mod.ts"),
      },
    }),
    "app/widget.tsx": CLIENT_WITH_INLINE,
    "app/page.tsx": `import { Widget } from "./widget.tsx";\n` +
      `export default function Page() { return <main><Widget /></main>; }\n`,
  });
  try {
    const err = await assertRejects(() => buildInChild(dir), Error);
    assertStringIncludes(err.message, INLINE_ACTION_IN_CLIENT_ERROR.split("\n")[0]);
    assertStringIncludes(err.message, "app/widget.tsx:3:3");
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a capturing inline action can't be called through its plain id with forged values", async () => {
  // The audit's proof: the page's form carries `<id>.<token>`; a POST to the plain `<id>` with
  // `args` must not reach the hoisted function, whose leading parameters are the captured values.
  const { code } = await transformInlineServerActions(
    `export default function Page(userId: string) {
  async function del() { "use server"; return "deleted " + userId; }
  return del;
}
`,
    "file:///app/forged-capture.tsx",
  );
  const dir = await Deno.makeTempDir({ prefix: "denext_inline_forge_" });
  try {
    const file = join(dir, "page.ts");
    await Deno.writeTextFile(file, code);
    const mod = await import(`file://${file}`);
    const del = mod.default("alice");
    const boundId: string = del.denextActionId;
    const plainId = boundId.slice(0, boundId.indexOf("."));
    const at = (id: string) =>
      new Request(`http://app.test${ACTION_PREFIX}${encodeURIComponent(id)}`, { method: "POST" });
    // The legitimate call, through the sealed id, gets the captured value.
    assertEquals(await resolveAction(at(boundId))!(), "deleted alice");
    // The plain id resolves to nothing: no caller-chosen value ever becomes a captured one.
    assertEquals(resolveAction(at(plainId)), undefined);
    assertEquals(getServerAction(plainId), undefined);
    // A token the server sealed for this action with fewer values than it captures is refused.
    assertEquals(resolveAction(at(`${plainId}.${sealBoundValues(plainId, [])}`)), undefined);
    // Binding more values (a nested `.bind`) keeps the captured ones first.
    const more = del.bind(null, "x");
    assertEquals(await resolveAction(at(more.denextActionId))!(), "deleted alice");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
