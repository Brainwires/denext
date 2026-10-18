// @denext/tanstack-start's `importProtection.behavior: "mock"` in `denext dev`, as Start's dev
// server applies it: a denied file is loaded as Start's self-denial module (its named exports over
// a mock), a denied specifier resolves to a mock-edge module (the names its importer uses), the
// violation is a warning in Start's words (once per process, or every build with `log:
// "always"`), and a marker stays a warning. A build still fails, and `behavior` resolves per
// command as Start resolves it. Start's own mock modules (loaded from the installed example) are
// checked in a subprocess: the browser mock reports its use per `mockAccess`.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { startBuild } from "../packages/tanstack-start/src/compile.ts";
import {
  compileImportProtection,
  effectiveBehavior,
  type ImportProtection,
  type ImportProtectionOptions,
  type ProtectionCommand,
} from "../packages/tanstack-start/src/protect.ts";
import type { StartMocks, StartToolchain } from "../packages/tanstack-start/src/toolchain.ts";
import { buildNextCompatClientEntries } from "../src/build/next-compat-build.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";

/**
 * Stand-ins for Start's mock modules with the same contract (ids, an edge's named exports over a
 * runtime mock, a self-denial module's), recognizable in a bundle.
 */
const PREFIX = "tanstack-start-import-protection:";
const fakeMocks: StartMocks = {
  MOCK_MODULE_ID: `${PREFIX}mock`,
  MOCK_EDGE_PREFIX: `${PREFIX}mock-edge:`,
  MOCK_RUNTIME_PREFIX: `${PREFIX}mock-runtime:`,
  mockRuntimeModuleIdFromViolation: (info, mode) =>
    info.env === "client" && mode !== "off"
      ? `${PREFIX}mock-runtime:${encodeURIComponent(JSON.stringify({ ...info, mode }))}`
      : `${PREFIX}mock`,
  makeMockEdgeModuleId: (exports, runtimeId) =>
    `${PREFIX}mock-edge:${encodeURIComponent(JSON.stringify({ exports, runtimeId }))}`,
  loadSilentMockModule: () => ({ code: `export default { silent: "SILENT_MOCK" };` }),
  loadMockEdgeModule: (payload) => {
    const { exports, runtimeId } = JSON.parse(decodeURIComponent(payload));
    return {
      code: `import mock from ${JSON.stringify(runtimeId)};\n` +
        (exports as string[]).map((n) => `export const ${n} = mock.${n};\n`).join("") +
        `export default mock;\n`,
    };
  },
  loadMockRuntimeModule: (payload) => ({
    code: `const meta = ${decodeURIComponent(payload)};\n` +
      `export default new Proxy({}, { get: (_t, p) => () => "RUNTIME_MOCK:" + meta.specifier + ":" + String(p) });\n`,
  }),
  generateDevSelfDenialModule: (exports, runtimeId) => ({
    code: `import mock from ${JSON.stringify(runtimeId)};\n` +
      exports.map((n) => `export const ${n} = mock.${n};\n`).join("") +
      `export default mock;\n`,
  }),
  getMockExportNamesBySource: (code) => {
    const out = new Map<string, string[]>();
    for (const m of code.matchAll(/import \{([^}]*)\} from "([^"]+)"/g)) {
      out.set(m[2], m[1].split(",").map((n) => n.trim()).filter(Boolean));
    }
    return out;
  },
  getNamedExports: (code) => [...code.matchAll(/export const (\w+)/g)].map((m) => m[1]),
};

/** A compiler that leaves every module as written. */
const toolchain = {
  createCompiler: () => ({
    compile: ({ code }: { code: string }) => Promise.resolve({ code }),
    ingestModule: () => undefined,
  }),
  mayNeedCompile: () => false,
  detectKinds: () => new Set<string>(),
} as unknown as StartToolchain;

/** An app whose `bad.ts` imports a `*.server.*` file and Start's server entry by name. */
async function app(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_mock_" }));
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
  await Deno.mkdir(join(dir, "src"));
  const file = (name: string, code: string) => Deno.writeTextFile(join(dir, "src", name), code);
  await file("db.server.ts", `export const db = () => "DB_SECRET";\nexport const other = 1;\n`);
  await file(
    "bad.ts",
    `import { db } from "./db.server.ts";\n` +
      `import { getRequest } from "@tanstack/react-start/server";\n` +
      `export const run = () => [db(), getRequest()];\n`,
  );
  return dir;
}

/** The app's import protection for `command` (one per process, as the plugin compiles it). */
const protect = (dir: string, options: ImportProtectionOptions, command: ProtectionCommand) =>
  compileImportProtection(options, dir, join(dir, "src"), command);

/** Build the browser bundle of `src/bad.ts` under `protection`. */
function build(dir: string, protection: ImportProtection): Promise<unknown> {
  const start = startBuild({
    env: "client",
    toolchain,
    projectRoot: dir,
    routerFile: join(dir, "src", "router.tsx"),
    startFile: null,
    knownServerFns: {},
    protection,
    mocks: () => Promise.resolve(fakeMocks),
  });
  return buildNextCompatClientEntries({
    projectDir: dir,
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    clientDir: join(dir, ".denext", "client"),
    entries: [{
      id: "client",
      source: `import { run } from ${JSON.stringify(join(dir, "src", "bad.ts"))};\nrun();\n`,
    }],
    extraPlugins: [start.plugin],
  });
}

async function bundleText(dir: string): Promise<string> {
  let js = "";
  for await (const entry of Deno.readDir(join(dir, ".denext", "client"))) {
    if (entry.isFile && entry.name.endsWith(".js")) {
      js += await Deno.readTextFile(join(dir, ".denext", "client", entry.name));
    }
  }
  return js;
}

/** Run `fn` with console.warn captured. */
async function warned(fn: () => Promise<unknown>): Promise<string[]> {
  const warn = console.warn;
  const out: string[] = [];
  console.warn = (...args: unknown[]) => void out.push(args.join(" "));
  try {
    await fn();
    return out;
  } finally {
    console.warn = warn;
  }
}

Deno.test("tanstack-start import protection: behavior resolves per command, as Start's", () => {
  assertEquals(effectiveBehavior(undefined, "dev"), "error", "unset: every violation fails");
  assertEquals(effectiveBehavior({ behavior: "mock" }, "dev"), "mock");
  assertEquals(effectiveBehavior({ behavior: "mock" }, "build"), "error", "a build never mocks");
  assertEquals(effectiveBehavior({ behavior: { build: "error" } }, "dev"), "mock", "dev: mock");
  assertEquals(effectiveBehavior({ behavior: { dev: "error" } }, "dev"), "error");
  const off = compileImportProtection({ enabled: false, behavior: "mock" }, "/p", "/p/src", "dev");
  assertEquals(off.behavior, "error");
  assertEquals(compileImportProtection({}, "/p", "/p/src").mockAccess, "error");
});

Deno.test({
  name: 'tanstack-start import protection: a dev "mock" ships Start\'s mocks and warns',
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await app();
  try {
    // A build fails, whatever the behavior.
    const err = await assertRejects(() => build(dir, protect(dir, { behavior: "mock" }, "build")));
    assertStringIncludes(String(err), "[import-protection] Import denied in client environment");

    // Dev: the build passes, the denied file is its self-denial module, the specifier an edge.
    const dev = protect(dir, { behavior: "mock" }, "dev");
    const once = await warned(() => build(dir, dev));
    const js = await bundleText(dir);
    assert(!js.includes("DB_SECRET"), "the denied file's body never ships");
    assertStringIncludes(js, "RUNTIME_MOCK:", "the runtime mock stands in");
    assertEquals(once.length, 2, once.join("\n---\n"));
    assertStringIncludes(once.join("\n"), "Denied by file pattern: **/*.server.*");
    assertStringIncludes(
      once.join("\n"),
      "Denied by specifier pattern: @tanstack/react-start/server",
    );
    // log "once" (the default): the next build reports nothing new.
    assertEquals(await warned(() => build(dir, dev)), []);
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: 'tanstack-start import protection: log "always" warns on every dev build',
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await app();
  try {
    const protection = compileImportProtection(
      { behavior: { dev: "mock" }, log: "always", mockAccess: "off" },
      dir,
      join(dir, "src"),
      "dev",
    );
    assertEquals([protection.reportsMocked("k"), protection.reportsMocked("k")], [true, true]);
    const opts: ImportProtectionOptions = { behavior: { dev: "mock" }, log: "always" };
    const always = protect(dir, opts, "dev");
    assertEquals((await warned(() => build(dir, always))).length, 2);
    assertEquals((await warned(() => build(dir, always))).length, 2);
    // onViolation returning false waives a mocked violation too.
    const waiving = protect(dir, {
      ...opts,
      onViolation: (v) => v.type !== "file" && undefined,
    }, "dev");
    const waived = await warned(() => build(dir, waiving));
    assertEquals(waived.length, 1);
    assertStringIncludes(waived[0], "Denied by specifier pattern");
  } finally {
    await stopNextCompat().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// Start's own mock modules, from the example app's install (`deno install` in
// examples/tanstack-start; the e2e does it). Skipped when the example is not installed.
const EXAMPLE = fromFileUrl(new URL("../examples/tanstack-start", import.meta.url));
const installed = await Deno.stat(join(EXAMPLE, "node_modules", "@tanstack", "react-start"))
  .then(() => true, () => false);

Deno.test({
  name: "tanstack-start import protection (installed example): Start's own mock modules",
  ignore: !installed,
}, async () => {
  const probe = fromFileUrl(new URL("./fixtures/tanstack-start/mock-probe.ts", import.meta.url));
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(EXAMPLE, "deno.json"), probe, EXAMPLE],
    cwd: EXAMPLE,
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const r = JSON.parse(new TextDecoder().decode(out.stdout)) as Record<string, unknown>;
  // A denied specifier's edge exports the names its importer uses.
  assertEquals(r.edgeExports, ["getRequest", "setCookie"]);
  // A denied file becomes its own named exports over the runtime mock.
  assertStringIncludes(r.selfDenial as string, "export const db = mock.db;");
  assertStringIncludes(r.selfDenial as string, "export const other = mock.other;");
  // In the browser the mock reports its use with console.error (mockAccess "error").
  assertEquals(r.called, "[import-protection mock]");
  assertStringIncludes(
    r.reported as string,
    "[import-protection] Mocked import used in dev client",
  );
  assertStringIncludes(r.reported as string, 'Denied import: "./db.server.ts"');
  // On the server, and with mockAccess "off", it is Start's silent mock.
  assertEquals(r.serverRuntime, "tanstack-start-import-protection:mock");
  assertEquals(r.offRuntime, "tanstack-start-import-protection:mock");
});
