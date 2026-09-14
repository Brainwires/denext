import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type CallArgSet, type CallTarget, setCallArguments } from "../src/build/call-args-edit.ts";
import { parseModule } from "../src/build/swc-ast.ts";

const OPENAPI: CallTarget = { arrayKey: "plugins", callee: "openapi" };

/** Format `source` the way `deno task check` would, so a test can assert fmt-stability. */
async function denoFmt(source: string): Promise<string> {
  const config = new URL("../deno.json", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--config", config, "--ext", "ts", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout);
}

/** Run an edit that must succeed; returns the rewritten source. */
async function edit(source: string, sets: CallArgSet[]): Promise<string> {
  const result = await setCallArguments(source, OPENAPI, sets);
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}\n${result.snippet}`);
  return result.source;
}

/** Run an edit that must refuse; returns the refusal. */
async function refusal(source: string, sets: CallArgSet[] = [{ path: ["a"], value: 1 }]) {
  const result = await setCallArguments(source, OPENAPI, sets);
  assert(!result.ok, `expected a refusal, got:\n${result.ok ? result.source : ""}`);
  return result;
}

const MULTI = `export default {
  plugins: [
    openapi({
      title: "API",
    }),
  ],
};
`;

// --- a zero-argument call ---------------------------------------------------

Deno.test("setCallArguments: a zero-argument call gains one object holding every set", async () => {
  const out = await edit(`export default {\n  plugins: [openapi()],\n};\n`, [
    { path: ["info", "title"], value: "API" },
    { path: ["info", "version"], value: "1" },
    { path: ["docs"], value: false },
  ]);
  assertEquals(
    out,
    `export default {\n  plugins: [openapi({ info: { title: "API", version: "1" }, docs: false })],\n};\n`,
  );
  // A comment inside the empty argument list stays; the object goes after it.
  assertEquals(
    await edit(`export default { plugins: [openapi(/* later */)] };`, [{ path: ["a"], value: 1 }]),
    `export default { plugins: [openapi(/* later */{ a: 1 })] };`,
  );
});

Deno.test("setCallArguments: a long options object expands at the call's indent", async () => {
  const src = `export default {\n  plugins: [\n    htmx(),\n    openapi(),\n  ],\n};\n`;
  const info = {
    title: "My API",
    version: "1.0.0",
    description: "A long description here, long enough",
  };
  assertEquals(
    await edit(src, [{ path: ["info"], value: info }]),
    `export default {
  plugins: [
    htmx(),
    openapi({
      info: {
        title: "My API",
        version: "1.0.0",
        description: "A long description here, long enough",
      },
    }),
  ],
};
`,
  );
});

Deno.test("setCallArguments: nothing to write is a no-op with an empty diff", async () => {
  const src = `export default { plugins: [openapi()] };`;
  for (const sets of [[], [{ path: ["a"], value: undefined }]]) {
    const result = await setCallArguments(src, OPENAPI, sets);
    assert(result.ok);
    assertEquals(result.source, src);
    assertEquals(result.diff, "");
  }
});

// --- an existing options object ---------------------------------------------

Deno.test("setCallArguments: sets a new key, updates an existing one, reports a diff", async () => {
  const result = await setCallArguments(MULTI, OPENAPI, [
    { path: ["version"], value: "1" },
    { path: ["title"], value: "Docs" },
  ]);
  assert(result.ok);
  assertEquals(result.source, MULTI.replace(`"API",`, `"Docs",\n      version: "1",`));
  assertStringIncludes(result.diff, `+      version: "1",`);
  assertStringIncludes(result.diff, `-      title: "API",`);
});

Deno.test("setCallArguments: deletes a key; deleting an absent key is a no-op", async () => {
  const src = MULTI.replace(`"API",`, `"API",\n      version: "1",`);
  const out = await edit(src, [
    { path: ["version"], value: undefined },
    { path: ["nope", "deeper"], value: undefined },
  ]);
  assertEquals(out, MULTI);
});

Deno.test("setCallArguments: a nested path writes into, or creates, intermediate objects", async () => {
  const into = await edit(`export default { plugins: [openapi({ info: { title: "x" } })] };`, [
    { path: ["info", "contact", "email"], value: "a@b.c" },
  ]);
  assertEquals(
    into,
    `export default { plugins: [openapi({ info: { title: "x", contact: { email: "a@b.c" } } })] };`,
  );
  // Several sets against one single-line object: each re-parses, so no two edits overlap.
  const created = await edit(`export default {\n  plugins: [openapi({ title: "API" })],\n};\n`, [
    { path: ["version"], value: "1" },
    { path: ["info", "x"], value: 2 },
  ]);
  assertEquals(
    created,
    `export default {\n  plugins: [openapi({ title: "API", version: "1", info: { x: 2 } })],\n};\n`,
  );
});

Deno.test("setCallArguments: comments and other plugin calls survive byte for byte", async () => {
  const src = `import { htmx } from "@denext/htmx";
import { openapi } from "@denext/openapi";

export default {
  // plugins load in this order — keep htmx first
  plugins: [
    htmx({ /* boost every link */ boost: true }),
    openapi({
      // the public title
      title: "API",
    }), // trailing note
  ],
};
`;
  const out = await edit(src, [
    { path: ["title"], value: "Docs" },
    { path: ["version"], value: "1" },
  ]);
  assertEquals(out, src.replace(`title: "API",`, `title: "Docs",\n      version: "1",`));
});

// --- config module forms ----------------------------------------------------

Deno.test("setCallArguments: every supported config module form is edited", async () => {
  const forms = [
    `export default defineConfig({\n  plugins: [openapi()],\n});\n`,
    `export default (phase) => ({\n  plugins: [openapi()],\n});\n`,
    `export default function cfg() {\n  return {\n    plugins: [openapi()],\n  };\n}\n`,
    `export default {\n  plugins: [openapi()],\n} satisfies DenextConfig;\n`,
    `export const plugins = [openapi()];\n`,
  ];
  for (const src of forms) {
    const out = await edit(src, [{ path: ["a"], value: 1 }]);
    assertEquals(out, src.replace("openapi()", "openapi({ a: 1 })"), src);
  }
});

// --- refusals ---------------------------------------------------------------

Deno.test("setCallArguments: a code-valued option is refused, as setConfigValue refuses it", async () => {
  const code = await refusal(`export default { plugins: [openapi({ foo: () => 1 })] };`, [
    { path: ["foo"], value: 2 },
  ]);
  assertStringIncludes(code.reason, "holds code");
  assertEquals(code.snippet, "() => 1");
  const through = await refusal(`export default { plugins: [openapi({ info: getInfo() })] };`, [
    { path: ["info", "title"], value: "x" },
  ]);
  assertStringIncludes(through.reason, "`info` is not an object literal");
  // One refusal writes nothing, even after an earlier set that would have succeeded.
  await refusal(`export default { plugins: [openapi({ a: 1, foo: () => 1 })] };`, [
    { path: ["a"], value: 2 },
    { path: ["foo"], value: 3 },
  ]);
});

Deno.test("setCallArguments: spread arguments and spread options are refused", async () => {
  for (const call of ["openapi(...args)", "openapi({ ...base, a: 1 })"]) {
    const bail = await refusal(`export default { plugins: [${call}] };`);
    assertStringIncludes(bail.reason, "spread");
    assertEquals(bail.snippet, call);
  }
});

Deno.test("setCallArguments: a member callee is refused", async () => {
  const bail = await refusal(`export default { plugins: [plugins.openapi()] };`);
  assertStringIncludes(bail.reason, "member expression");
  assertEquals(bail.snippet, "plugins.openapi()");
});

Deno.test("setCallArguments: a non-literal argument or a second argument is refused", async () => {
  for (const call of ["openapi(opts)", "openapi(makeOptions())", "openapi({ a: 1 }, extra)"]) {
    const bail = await refusal(`export default { plugins: [${call}] };`);
    assertEquals(bail.snippet, call);
  }
  const variable = await refusal(`export default { plugins: [openapi(opts)] };`);
  assertStringIncludes(variable.reason, "not an object literal");
  const two = await refusal(`export default { plugins: [openapi({}, extra)] };`);
  assertStringIncludes(two.reason, "2 arguments");
});

Deno.test("setCallArguments: a missing call or a plugins value that is not an array", async () => {
  const absent = await refusal(`export default { plugins: [htmx()] };`);
  assertStringIncludes(absent.reason, "plugin call not found");
  const unset = await refusal(`export default { basePath: "/a" };`);
  assertStringIncludes(unset.reason, "plugin call not found");
  for (const value of ["getPlugins()", "list", "() => [openapi()]"]) {
    const bail = await refusal(`export default { plugins: ${value} };`);
    assertStringIncludes(bail.reason, "not an array literal");
    assertEquals(bail.snippet, value);
  }
  const opaque = await refusal(`export default makeConfig();`);
  assertStringIncludes(opaque.reason, "no editable config object");
});

Deno.test("setCallArguments: two matching calls are ambiguous", async () => {
  const bail = await refusal(`export default { plugins: [openapi(), openapi({ a: 1 })] };`);
  assertStringIncludes(bail.reason, "ambiguous");
  assertEquals(bail.snippet, "openapi()\nopenapi({ a: 1 })");
});

Deno.test("setCallArguments: an empty path is refused", async () => {
  const bail = await refusal(`export default { plugins: [openapi()] };`, [{ path: [], value: 1 }]);
  assertStringIncludes(bail.reason, "empty key path");
});

// --- output quality ---------------------------------------------------------

Deno.test("setCallArguments: every written source is deno fmt stable and re-parses", async () => {
  const src = `import { htmx } from "@denext/htmx";
import { openapi } from "@denext/openapi";

export default {
  // plugins load in this order
  plugins: [
    htmx(),
    openapi(),
  ],
};
`;
  assertEquals(await denoFmt(src), src, "the fixture itself is fmt-clean");
  const info = { title: "My API", version: "1.0.0", description: "Everything the API offers" };
  const first = await edit(src, [{ path: ["info"], value: info }]);
  const second = await edit(first, [
    { path: ["info", "license"], value: "MIT" },
    { path: ["servers"], value: [{ url: "https://api.example.com", description: "production" }] },
    { path: ["docs", "path"], value: "/reference" },
  ]);
  const hugged = await edit(`export default {\n  plugins: [openapi()],\n};\n`, [
    { path: ["docs"], value: { path: "/reference", title: "Reference" } },
  ]);
  for (const out of [first, second, hugged]) {
    assertEquals(await denoFmt(out), out, out);
    assert(await parseModule(out) !== null, out);
  }
});
