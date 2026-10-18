// Run by tests/tanstack-start-mock.test.ts under examples/tanstack-start's config (so the app's npm
// packages resolve): Start's own import-protection mocks, loaded as the plugin loads them, through
// the plugin's helpers. Prints what they produced as JSON.

import { loadStartMocks } from "../../../packages/tanstack-start/src/toolchain.ts";
import {
  mockEdgeId,
  mockModuleSource,
  selfDenialSource,
} from "../../../packages/tanstack-start/src/mock.ts";
import { compileImportProtection } from "../../../packages/tanstack-start/src/protect.ts";

const root = "/p";
const mocks = await loadStartMocks(Deno.args[0]);
const dev = compileImportProtection({ behavior: "mock" }, root, "/p/src", "dev");
const off = compileImportProtection(
  { behavior: "mock", mockAccess: "off" },
  root,
  "/p/src",
  "dev",
);

const importerCode = `import { getRequest, setCookie } from "@tanstack/react-start/server";
export const a = () => [getRequest(), setCookie("a", "b")];
`;
const edge = mockEdgeId(mocks, dev, {
  env: "client",
  importer: "/p/src/a.ts",
  importerCode,
  specifier: "@tanstack/react-start/server",
});
const edgeSource = mockModuleSource(mocks, edge);
const edgeExports = [...edgeSource.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort();

const selfDenial = selfDenialSource(mocks, dev, {
  env: "client",
  file: "/p/src/db.server.ts",
  source: `export const db = () => "DB";\nexport const other = 1;\n`,
});

// The browser runtime mock of a denied import: using it reports, once per access.
const runtimeId = mocks.mockRuntimeModuleIdFromViolation(
  { env: "client", importer: "/p/src/a.ts", specifier: "./db.server.ts", trace: [] },
  "error",
  root,
);
const runtime = mockModuleSource(mocks, runtimeId);
const reports: string[] = [];
const error = console.error;
console.error = (e: unknown) => void reports.push(String(e instanceof Error ? e.message : e));
let called = "";
try {
  const mod = await import(`data:text/javascript,${encodeURIComponent(runtime)}`);
  called = String(mod.default.db());
} finally {
  console.error = error;
}

// A build's "mock": Start's build mocks (an edge over a per-violation build id, which loads the
// silent mock; a denied file as a self-contained mock).
const build = compileImportProtection({ behavior: "mock" }, root, "/p/src", "build");
const buildEdge = mockEdgeId(mocks, build, {
  env: "client",
  importer: "/p/src/a.ts",
  importerCode,
  specifier: "@tanstack/react-start/server",
});
const buildEdgeSource = mockModuleSource(mocks, buildEdge);
const buildEdgeRuntime = /import mock from "([^"]+)"/.exec(buildEdgeSource)?.[1] ?? "";
const buildSelfDenial = selfDenialSource(mocks, build, {
  env: "client",
  file: "/p/src/db.server.ts",
  source: `export const db = () => "DB";\nexport const other = 1;\n`,
});

console.log(JSON.stringify({
  buildEdgeRuntime,
  buildEdgeExports: [...buildEdgeSource.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort(),
  buildRuntimeIsSilent: mockModuleSource(mocks, buildEdgeRuntime) ===
    mocks.loadSilentMockModule().code,
  buildSelfDenial,
  edgeExports,
  selfDenial,
  called,
  reported: reports.join("\n"),
  serverRuntime: mocks.mockRuntimeModuleIdFromViolation(
    { env: "server", importer: "/p/src/a.ts", specifier: "x", trace: [] },
    "error",
    root,
  ),
  offRuntime: mocks.mockRuntimeModuleIdFromViolation(
    { env: "client", importer: "/p/src/a.ts", specifier: "x", trace: [] },
    off.mockAccess,
    root,
  ),
}));
