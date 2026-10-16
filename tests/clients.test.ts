// Typed clients in other languages: `@denext/openapi/clients` turns an OpenAPI document (and
// `@denext/graphql` a schema's SDL) into one dependency-free Python, Go, Swift or Kotlin file.
// The output is held to golden files (regenerate them with `UPDATE_GOLDEN=1`); where the
// language's toolchain is installed the goldens are also compiled / type-checked (`python3`
// ≥ 3.11 + `mypy` when present, `go vet`, `swiftc -typecheck`, and Kotlin when `DENEXT_KOTLINC`
// names a `kotlinc`).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  CLIENT_LANGUAGES,
  type ClientLanguage,
  emitClient,
  modelFromOpenApi,
} from "../packages/openapi/clients/mod.ts";
import type { OpenApiDocument } from "../packages/openapi/spec.ts";
import { createOpenapiCommand } from "../packages/openapi/command.ts";
import { createGraphqlCommand } from "../packages/graphql/command.ts";
import { modelFromSdl } from "../packages/graphql/client.ts";
import type { CommandContext } from "../src/cli/command.ts";

const FIXTURES = new URL("./fixtures/clients/", import.meta.url);
const document = JSON.parse(
  await Deno.readTextFile(new URL("openapi.json", FIXTURES)),
) as OpenApiDocument;
const sdl = await Deno.readTextFile(new URL("schema.graphql", FIXTURES));
const UPDATE = Deno.env.get("UPDATE_GOLDEN") === "1";

/** Compare `source` with the golden file (or rewrite it under UPDATE_GOLDEN=1). */
async function golden(kind: "rest" | "graphql", fileName: string, source: string) {
  const url = new URL(`golden/${kind}/${fileName}`, FIXTURES);
  if (UPDATE) {
    await Deno.mkdir(new URL(`golden/${kind}/`, FIXTURES), { recursive: true });
    await Deno.writeTextFile(url, source);
    return;
  }
  assertEquals(source, await Deno.readTextFile(url), `${kind}/${fileName} drifted from its golden`);
}

for (const lang of CLIENT_LANGUAGES) {
  Deno.test(`clients: the ${lang} REST client matches its golden`, async () => {
    const { fileName, source } = emitClient(document, lang);
    await golden("rest", fileName, source);
  });
  Deno.test(`clients: the ${lang} GraphQL client matches its golden`, async () => {
    const { fileName, source } = emitClient(modelFromSdl(sdl), lang);
    await golden("graphql", fileName, source);
  });
}

Deno.test("modelFromOpenApi: components, inline objects, allOf, nullability, recursion, operations", () => {
  const model = modelFromOpenApi(document);
  const byName = new Map(model.types.map((t) => [t.name, t]));
  assert(!byName.has("ApiError"), "the error envelope is each client's own type");
  assertEquals(byName.get("Status"), {
    kind: "enum",
    name: "Status",
    values: ["open", "done", "in-progress"],
    description: "Where a todo stands.",
  });
  const todo = byName.get("Todo");
  assert(todo?.kind === "object");
  const field = (name: string) => todo.fields.find((f) => f.name === name)!;
  assertEquals(field("parent").type, { kind: "nullable", inner: { kind: "named", name: "Todo" } });
  assertEquals(field("score").type, { kind: "nullable", inner: { kind: "number" } });
  assertEquals(field("tags").type, { kind: "named", name: "Tags" });
  assertEquals([field("id").required, field("type").required], [true, false]);
  // allOf of objects is one object; an inline body becomes a named type from its operation.
  const patch = byName.get("TodoPatch");
  assert(patch?.kind === "object");
  assertEquals(patch.fields.map((f) => f.name), ["title", "status"]);
  assert(byName.get("PostApiTodosBody")?.kind === "object");
  assert(byName.get("GetApiTodosStatus")?.kind === "enum", "an inline query enum is named");
  const list = model.operations.find((o) => o.name === "getApiTodos")!;
  assertEquals(list.queryParams.map((q) => [q.name, q.required]), [
    ["status", false],
    ["limit", false],
    ["tag", false],
  ]);
  assertEquals(list.response, { kind: "array", items: { kind: "named", name: "Todo" } });
  const del = model.operations.find((o) => o.name === "deleteApiTodosById")!;
  assertEquals([del.method, del.response, del.pathParams.map((p) => p.name)], [
    "DELETE",
    undefined,
    ["id"],
  ]);
  assertEquals(
    model.operations.find((o) => o.name === "postApiTodos")!.errors.duplicate,
    409,
  );
});

Deno.test("clients: keywords and non-identifier keys stay valid in every language", () => {
  const py = emitClient(document, "python").source;
  assertStringIncludes(py, "def get_api_stats(self, *, class_: str)");
  assertStringIncludes(py, '"owner-id": "NotRequired[str]"', "the functional TypedDict form");
  const go = emitClient(document, "go").source;
  assert(/OwnerID\s+\*string\s+`json:"owner-id,omitempty"`/.test(go), "an exported, tagged field");
  const swift = emitClient(document, "swift").source;
  assertStringIncludes(swift, "public func getApiStats(`class`: String)");
  assertStringIncludes(swift, 'case ownerId = "owner-id"');
  assertStringIncludes(swift, "public final class Todo", "a self-containing type is a class");
  const kotlin = emitClient(document, "kotlin").source;
  assertStringIncludes(kotlin, "fun getApiStats(`class`: String)");
  assertStringIncludes(kotlin, 'if (ownerId != null) put("owner-id", ownerId)');
});

Deno.test("modelFromSdl: output fields optional, inputs required when non-null without a default", () => {
  const model = modelFromSdl(sdl, "/gql");
  assertEquals(model.graphqlPath, "/gql");
  const byName = new Map(model.types.map((t) => [t.name, t]));
  const input = byName.get("NewTodo");
  assert(input?.kind === "object");
  assertEquals(input.fields.map((f) => [f.name, f.required]), [
    ["title", true],
    ["tags", false],
    ["priority", false],
    ["meta", false],
  ]);
  const todo = byName.get("Todo");
  assert(todo?.kind === "object");
  assert(todo.fields.every((f) => !f.required));
  assertEquals(todo.fields.find((f) => f.name === "attachments")!.type, {
    kind: "nullable",
    inner: { kind: "array", items: { kind: "any" } },
  }, "a union is untyped JSON");
  assert(!byName.has("Attachment") && !byName.has("JSON") && !byName.has("__Schema"));
  assertEquals(byName.get("Status")?.kind, "enum");
});

/** A CLI context with these positionals and flags. */
const cli = (positionals: string[], flags: Record<string, unknown>) =>
  ({ positionals, flags, global: {} }) as unknown as CommandContext;

function io() {
  const lines: string[] = [];
  const files = new Map<string, string>();
  return {
    lines,
    files,
    io: {
      log: (l: string) => lines.push(l),
      error: (l: string) => lines.push(`E ${l}`),
      readFile: (p: string) => Promise.resolve(files.get(p) ?? ""),
      writeFile: (p: string, t: string) => Promise.resolve(void files.set(p, t)),
      exit: (code: number) => lines.push(`exit ${code}`),
    },
  };
}

Deno.test("denext openapi client --lang writes the client; an unknown language is refused", async () => {
  const t = io();
  const cmd = createOpenapiCommand(() => Promise.resolve({ document, warnings: [] }), t.io);
  await cmd.run(cli(["client"], { lang: "go", out: "client.go", package: "todos" }));
  assertStringIncludes(t.files.get("client.go")!, "package todos\n");
  assertStringIncludes(t.lines.at(-1)!, "Wrote client.go (go client, 6 operations)");
  await assertRejects(async () => await cmd.run(cli(["client"], { lang: "rust" })), Error, "rust");
});

Deno.test("denext graphql client --lang prints the client for the schema", async () => {
  const t = io();
  const cmd = createGraphqlCommand(() => Promise.resolve(sdl), t.io, "/api/graphql");
  await cmd.run(cli(["client"], { lang: "kotlin" }));
  assertStringIncludes(t.lines[0], "class GraphQLClient(");
  assertStringIncludes(t.lines[0], "GraphQL /api/graphql");
  await assertRejects(async () => await cmd.run(cli(["client"], {})), Error, "language");
});

// ── The goldens compile where the toolchain is installed ─────────────────────

/** Run a command; `null` when the program is not installed. */
async function run(cmd: string, args: string[], cwd?: string) {
  try {
    const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" })
      .output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    return { ok: out.success, text };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function hasTool(cmd: string, args: string[], want?: RegExp): Promise<boolean> {
  const r = await run(cmd, args);
  return !!r?.ok && (!want || want.test(r.text));
}

const tools = {
  python: await hasTool("python3", ["-c", "import sys; assert sys.version_info >= (3, 11)"]),
  mypy: await hasTool("python3", ["-m", "mypy", "--version"]),
  go: await hasTool("go", ["version"]),
  swift: await hasTool("swiftc", ["--version"]),
  kotlin: !!Deno.env.get("DENEXT_KOTLINC"),
};

/** A temp dir holding both goldens of `lang`. */
async function goldens(lang: ClientLanguage): Promise<{ dir: string; files: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: `denext_client_${lang}_` });
  const files: string[] = [];
  for (const kind of ["rest", "graphql"] as const) {
    const fileName = emitClient(document, lang).fileName;
    await Deno.mkdir(join(dir, kind));
    const target = join(dir, kind, fileName);
    await Deno.copyFile(new URL(`golden/${kind}/${fileName}`, FIXTURES), target);
    files.push(target);
  }
  return { dir, files };
}

Deno.test({
  name: "clients: the Python goldens compile (and pass mypy --strict when it is installed)",
  ignore: !tools.python,
}, async () => {
  const { dir, files } = await goldens("python");
  try {
    for (const file of files) {
      const r = await run("python3", ["-m", "py_compile", file]);
      assert(r?.ok, r?.text);
      if (tools.mypy) {
        const m = await run("python3", ["-m", "mypy", "--strict", file]);
        assert(m?.ok, m?.text);
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  { name: "clients: the Go goldens pass gofmt and go vet", ignore: !tools.go },
  async () => {
    const { dir, files } = await goldens("go");
    try {
      for (const file of files) {
        const pkg = join(file, "..");
        await Deno.writeTextFile(join(pkg, "go.mod"), "module example.com/client\n\ngo 1.21\n");
        const fmt = await run("gofmt", ["-l", "."], pkg);
        assertEquals(fmt?.text.trim(), "", "gofmt-clean");
        const vet = await run("go", ["vet", "./..."], pkg);
        assert(vet?.ok, vet?.text);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test({ name: "clients: the Swift goldens type-check", ignore: !tools.swift }, async () => {
  const { dir, files } = await goldens("swift");
  try {
    for (const file of files) {
      const r = await run("swiftc", ["-typecheck", "-swift-version", "6", file]);
      assert(r?.ok, r?.text);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({ name: "clients: the Kotlin goldens compile", ignore: !tools.kotlin }, async () => {
  const { dir, files } = await goldens("kotlin");
  try {
    for (const file of files) {
      const r = await run(Deno.env.get("DENEXT_KOTLINC")!, ["-d", join(dir, "out"), file]);
      assert(r?.ok, r?.text);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
