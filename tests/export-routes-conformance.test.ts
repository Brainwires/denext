// Which exported file serves a URL path, on every surface that serves a static export, held to ONE
// spec: the vectors in fixtures/export-routes.json. The TS resolver (src/build/export-paths.ts) is
// checked directly; the desktop request handler and the SPA prod server end to end over the
// vectors' fixture export; the SPA shell decision (`wantsShell`, which the SPA dev handler shares);
// and the Capacitor shells' native routers, whose candidate order must mirror the resolver's and
// which, where swiftc / javac exist, are compiled against stubs and run over the same vectors.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  EXPORT_PAGE_SUFFIXES,
  EXPORT_SHELL_PAGE,
  resolveExportPath,
} from "../src/build/export-paths.ts";
import { createDesktopHandler } from "../src/build/desktop.ts";
import { wantsShell } from "../src/build/spa/shared.ts";
import { startSpaProdServer } from "../src/build/spa.ts";
import { EXPORT_ROUTER_SWIFT } from "../src/build/bridge-export-router-native-template.ts";
import { mainActivitySource } from "../src/build/mobile-native-install.ts";

interface Vector {
  url: string;
  pages: string[];
  navigation: boolean;
  serves: string | null;
  note?: string;
  nativeSkip?: string;
}

interface Spec {
  files: Record<string, string>;
  outside: Record<string, string>;
  vectors: Vector[];
}

const SPEC: Spec = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/export-routes.json", import.meta.url)),
);
const ORIGIN = "http://127.0.0.1";

/** A URL-style path with its empty segments collapsed (`//about` → `/about`), as a file read does. */
const normalize = (path: string): string => path.replace(/\/{2,}/g, "/");

/** The pathname a surface sees for a vector's request target. */
const pathnameOf = (v: Vector): string => new URL(ORIGIN + v.url).pathname;

/** The marker a fixture file's content carries (`ABOUT_DIR`), which survives the shell injection. */
const marker = (file: string): string => SPEC.files[file].match(/[A-Z][A-Z_]+/)![0];

/** The vectors' export directory (`out/`) with the `outside` files written beside it. */
async function fixtureExport(): Promise<{ root: string; out: string }> {
  const root = await Deno.makeTempDir({ prefix: "denext-export-routes-" });
  const out = join(root, "out");
  const write = async (base: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(base, rel)), { recursive: true });
      await Deno.writeTextFile(join(base, rel), content);
    }
  };
  await write(out, SPEC.files);
  await write(root, SPEC.outside);
  return { root, out };
}

/** Whether the vector's path itself names the file it serves (`/x.html/` → `x.html`): an asset. */
const namesFile = (v: Vector): boolean =>
  normalize(decodeURIComponent(pathnameOf(v))).replace(/(.)\/$/, "$1") === "/" + v.serves;

/** Assert a response serves what `expected` names (a file, the shell, or a 404). */
async function assertServes(res: Response, expected: string | null, what: string): Promise<void> {
  const body = await res.text();
  assert(!body.includes("SECRET"), `${what}: served a file from outside the export`);
  if (expected === null) {
    assertEquals(res.status, 404, what);
    return;
  }
  assertEquals(res.status, 200, what);
  assertStringIncludes(body, marker(expected === "shell" ? "index.html" : expected), what);
}

Deno.test("export routes: the spec's vectors are well formed", () => {
  assert(SPEC.vectors.length > 20);
  for (const v of SPEC.vectors) {
    assert(v.serves === null || v.serves === "shell" || v.serves in SPEC.files, v.url);
    // A file the vector serves is one of its page candidates, or the path itself (an asset).
    if (v.serves !== null && v.serves !== "shell") {
      assert(
        v.pages.some((p) => normalize(decodeURIComponent(p)) === "/" + v.serves) ||
          namesFile(v),
        v.url,
      );
    }
    if (v.serves === "shell") assert(v.navigation, `${v.url}: only a navigation gets the shell`);
  }
});

Deno.test("export routes: resolveExportPath matches every vector", () => {
  for (const v of SPEC.vectors) {
    assertEquals(
      resolveExportPath(pathnameOf(v)),
      { pages: v.pages, navigation: v.navigation },
      v.url,
    );
  }
});

Deno.test("export routes: the SPA shell decision is the resolver's navigation flag", () => {
  for (const v of SPEC.vectors) {
    const req = (method: string, headers: Record<string, string> = {}) =>
      new Request(ORIGIN + v.url, { method, headers });
    assertEquals(wantsShell(req("GET"), pathnameOf(v)), v.navigation, v.url);
    assertEquals(wantsShell(req("HEAD"), pathnameOf(v)), v.navigation, v.url);
    // A document request always gets the shell; a non-GET/HEAD never does.
    assert(wantsShell(req("GET", { accept: "text/html" }), pathnameOf(v)), v.url);
    assert(!wantsShell(req("POST"), pathnameOf(v)), v.url);
  }
});

Deno.test("export routes: the desktop handler serves every vector", async () => {
  const { root, out } = await fixtureExport();
  try {
    const handle = createDesktopHandler({}, out, undefined, "tok-vectors");
    for (const v of SPEC.vectors) {
      const res = await handle(new Request(ORIGIN + v.url), new URL(ORIGIN + v.url));
      await assertServes(res, v.serves, `desktop ${v.url}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export routes: the SPA prod server gives every navigation the shell", async () => {
  // A built SPA serves `public/` as files and the shell for a navigation: it has no pages of its
  // own, so a navigation the path itself does not name a file for is the shell, and anything else
  // is the file itself or a 404.
  const { root, out } = await fixtureExport();
  const project = join(root, "spa");
  await Deno.mkdir(join(project, ".denext", "client"), { recursive: true });
  await Deno.rename(out, join(project, "public"));
  await Deno.writeTextFile(
    join(project, ".denext", "client", "index.html"),
    SPEC.files["index.html"],
  );
  const ac = new AbortController();
  const port = Promise.withResolvers<number>();
  const server = await startSpaProdServer({
    projectDir: project,
    port: 0,
    hostname: "127.0.0.1",
    signal: ac.signal,
    onListen: ({ port: p }) => port.resolve(p),
  });
  try {
    const base = `http://127.0.0.1:${await port.promise}`;
    for (const v of SPEC.vectors) {
      const res = await fetch(base + v.url);
      await assertServes(res, v.navigation && !namesFile(v) ? "shell" : v.serves, `spa ${v.url}`);
    }
  } finally {
    ac.abort();
    await server.finished;
    await Deno.remove(root, { recursive: true });
  }
});

/** The candidate suffixes a native router's `[path + "/index.html", path + ".html"]` list names. */
function nativeSuffixes(source: string, list: RegExp): string[] {
  const m = list.exec(source);
  assert(m, `no candidate list matching ${list}`);
  return [...m[1].matchAll(/\+\s*"([^"]+)"/g)].map((s) => s[1]);
}

const swiftList = /for candidate in \[([^\]]+)\]/;
const javaList = /new String\[\] \{([^}]+)\}/;

Deno.test("export routes: the native routers try the resolver's candidates in its order", async () => {
  assertEquals(nativeSuffixes(EXPORT_ROUTER_SWIFT, swiftList), [...EXPORT_PAGE_SUFFIXES]);
  assertStringIncludes(EXPORT_ROUTER_SWIFT, `return basePath + "${EXPORT_SHELL_PAGE}"`);
  const java = await mainActivitySource("com.example.app", new Set());
  assertEquals(nativeSuffixes(java, javaList), [...EXPORT_PAGE_SUFFIXES]);
});

/** The vectors a native router is held to, with the decoded path Capacitor hands it. */
const nativeVectors = () =>
  SPEC.vectors.filter((v) => !v.nativeSkip).map((v) => ({
    v,
    path: decodeURIComponent(pathnameOf(v)),
  }));

/** Whether a decoded path has a `..` segment (`/../secret`), which no native router follows. */
const climbs = (path: string): boolean => path.split("/").includes("..");

/** The page a navigation vector names (`/about/index.html`), or null for the shell / non-page. */
const pageOf = (v: Vector): string | null =>
  v.navigation && v.serves !== null && v.serves !== "shell" && pathnameOf(v) !== "/"
    ? "/" + v.serves
    : null;

/** Run `cmd` with `input` on stdin; its stdout lines. */
async function runLines(cmd: string, args: string[], input: string): Promise<string[]> {
  const child = new Deno.Command(cmd, { args, stdin: "piped", stdout: "piped", stderr: "piped" })
    .spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).split("\n").slice(0, -1);
}

const has = (tool: string): boolean => {
  try {
    return new Deno.Command(tool, { args: ["-version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
};

const SWIFT_DRIVER = `
import Foundation
protocol Router {
    var basePath: String { get set }
    func route(for path: String) -> String
}
${EXPORT_ROUTER_SWIFT}
var router = DenextExportRouter()
router.basePath = CommandLine.arguments[1]
while let line = readLine() { print(router.route(for: line)) }
`;

Deno.test({
  name: "export routes: the iOS router (compiled) serves every vector",
  ignore: Deno.build.os !== "darwin" || !has("swiftc"),
  async fn() {
    const { root, out } = await fixtureExport();
    try {
      await Deno.writeTextFile(join(root, "router.swift"), SWIFT_DRIVER);
      const bin = join(root, "router");
      const compile = await new Deno.Command("swiftc", {
        args: ["-o", bin, join(root, "router.swift")],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(compile.success, new TextDecoder().decode(compile.stderr));
      const cases = nativeVectors();
      const routed = await runLines(bin, [out], cases.map((c) => c.path).join("\n") + "\n");
      cases.forEach(({ v, path }, i) => {
        const page = pageOf(v);
        // A page → that page; any other navigation → the root shell; a path with an extension
        // passes through to Capacitor's handler, unless it climbs out of the UI directory: then
        // it is refused with the directory itself, which the handler cannot read.
        const want = page ?? (v.navigation ? EXPORT_SHELL_PAGE : climbs(path) ? "/" : path);
        assertEquals(normalize(routed[i]), normalize(out + want), `ios ${v.url}`);
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

/** The Android client's `exportedPage` method, lifted out of the composed MainActivity. */
async function javaExportedPage(): Promise<string> {
  const java = await mainActivitySource("com.example.app", new Set());
  const start = java.indexOf("        private String exportedPage(");
  const end = java.indexOf("        /** Whether the UI served has page");
  assert(start > 0 && end > start, "no exportedPage method in the MainActivity");
  return java.slice(start, end);
}

Deno.test({
  name: "export routes: the Android router (compiled) serves every vector",
  ignore: !has("javac") || !has("java"),
  async fn() {
    const { root, out } = await fixtureExport();
    const src = join(root, "java");
    try {
      await Deno.mkdir(join(src, "android", "net"), { recursive: true });
      await Deno.writeTextFile(
        join(src, "android", "net", "Uri.java"),
        `package android.net;
public final class Uri {
    private final String path;
    public Uri(String path) { this.path = path; }
    public String getHost() { return "localhost"; }
    public String getPath() { return path; }
}
`,
      );
      await Deno.writeTextFile(
        join(src, "Harness.java"),
        `public final class Harness {
    static final class Bridge {
        final String base;
        Bridge(String base) { this.base = base; }
        String getServerUrl() { return null; }
        String getHost() { return "localhost"; }
        String getServerBasePath() { return base; }
    }
    private final Bridge bridge;
    Harness(String base) { this.bridge = new Bridge(base); }
    private boolean exists(String base, String page) { return new java.io.File(base + page).isFile(); }
${await javaExportedPage()}
    public static void main(String[] args) throws Exception {
        Harness h = new Harness(args[0]);
        java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
        for (String line; (line = in.readLine()) != null;) {
            System.out.println(String.valueOf(h.exportedPage(new android.net.Uri(line))));
        }
    }
}
`,
      );
      const classes = join(root, "classes");
      const compile = await new Deno.Command("javac", {
        args: [
          "-d",
          classes,
          join(src, "android", "net", "Uri.java"),
          join(src, "Harness.java"),
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(compile.success, new TextDecoder().decode(compile.stderr));
      const cases = nativeVectors();
      const routed = await runLines(
        "java",
        ["-cp", classes, "Harness", out],
        cases.map((c) => c.path).join("\n") + "\n",
      );
      cases.forEach(({ v }, i) => {
        // A page → that page's path; anything else is left to Capacitor (null), which answers
        // a navigation with the root index.html and a path with an extension with the file.
        const page = pageOf(v);
        assertEquals(routed[i] === "null" ? null : normalize(routed[i]), page, `android ${v.url}`);
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
