// A module sidecar's children (src/desktop/sidecar-child.ts): the argv / environment contract on
// every OS (the command a sidecar builds, how the child recognizes itself), the shared helpers
// (`childCommand`, `spawnSelf`, the runtime start-up lines stripped from a child's stdout), and a
// real module sidecar, in a worker, that starts a child of itself which echoes its stdin to stdout
// and exits with a code (the Deno CLI path; the packaged-app path is
// tests/desktop-sidecar-packaged-macos.test.ts).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  cliPermissionFlags,
  parentChildBase,
  readSidecarChildLaunch,
  type SidecarChildBase,
  sidecarChildBase,
  sidecarChildHelpersUrl,
  sidecarChildLaunch,
  type SidecarChildLaunchInput,
} from "../src/desktop/sidecar-child.ts";
import {
  SIDECAR_CHILD_ARGC_ENV,
  SIDECAR_CHILD_ENV,
  type SidecarDefinition,
  sidecarModuleUrl,
} from "../src/desktop/sidecar.ts";
import { workerSidecarLauncher } from "../src/desktop/sidecar-launch.ts";
import type { SidecarLaunchContext } from "../src/desktop/sidecar-supervisor.ts";

const SIDECARS: SidecarDefinition[] = [
  { name: "server", run: { module: "./server/main.ts" } },
  {
    name: "node",
    run: { module: "apps/server/main.mjs", nodeModules: "apps/server/node_modules" },
  },
  { name: "tool", run: { exec: "./bin/tool" } },
];

/** The platforms' shapes of an app's executable and entry. */
const PLATFORMS = [
  {
    os: "macos",
    exe: "/Applications/My App.app/Contents/MacOS/My App",
    entry: "/var/folders/xy/T/deno-compile-My App/desktop.ts",
  },
  { os: "linux", exe: "/opt/my-app/my-app", entry: "/tmp/deno-compile-my-app/desktop.ts" },
  {
    os: "windows",
    exe: "C:\\Program Files\\My App\\My App.exe",
    entry: "C:\\Users\\me\\AppData\\Local\\Temp\\deno-compile-My App.exe\\desktop.ts",
  },
] as const;

// ── the contract ─────────────────────────────────────────────────────────────────────────────

Deno.test("sidecarChildBase: a compiled app re-runs its own executable as `run <entry>` (every OS)", () => {
  for (const { exe, entry } of PLATFORMS) {
    assertEquals(
      sidecarChildBase({ name: "server", execPath: exe, entryPath: entry, standalone: true }),
      {
        name: "server",
        command: exe,
        args: ["run", entry],
        env: { [SIDECAR_CHILD_ENV]: "server" },
        argcEnv: SIDECAR_CHILD_ARGC_ENV,
        banner: true,
      },
    );
  }
  // A compiled app's permissions are baked: flags are never passed to it.
  const compiled = sidecarChildBase({
    name: "server",
    execPath: "/app",
    entryPath: "/e.ts",
    standalone: true,
    permissionFlags: ["--allow-all"],
  });
  assertEquals("args" in compiled && compiled.args, ["run", "/e.ts"]);
});

Deno.test("sidecarChildBase: the Deno CLI gets the app's unscoped permissions; no entry is an error", () => {
  assertEquals(
    sidecarChildBase({
      name: "server",
      execPath: "/usr/local/bin/deno",
      entryPath: "/p/desktop.ts",
      standalone: false,
      permissionFlags: ["--allow-read", "--allow-net"],
    }),
    {
      name: "server",
      command: "/usr/local/bin/deno",
      args: ["run", "--allow-read", "--allow-net", "/p/desktop.ts"],
      env: { [SIDECAR_CHILD_ENV]: "server" },
      argcEnv: SIDECAR_CHILD_ARGC_ENV,
      banner: false,
    },
  );
  const none = sidecarChildBase({ name: "server", execPath: "/deno", standalone: false });
  assert("error" in none && /importMetaUrl/.test(none.error), JSON.stringify(none));
});

Deno.test("cliPermissionFlags: only the kinds granted unscoped; an unknown kind is skipped", () => {
  const granted = new Set(["read", "env", "run"]);
  assertEquals(
    cliPermissionFlags((name) => {
      if (name === "import") throw new TypeError("unknown permission");
      return granted.has(name) ? "granted" : "prompt";
    }),
    ["--allow-read", "--allow-env", "--allow-run"],
  );
  // This test process runs with -A.
  assert(cliPermissionFlags().includes("--allow-run"));
});

Deno.test("parentChildBase: this process's executable and entry", () => {
  const base = parentChildBase("server", import.meta.url);
  assert("command" in base);
  assertEquals(base.command, Deno.execPath());
  assertEquals(base.args.at(-1), fromFileUrl(import.meta.url));
  assertEquals(base.banner, false);
  assert("error" in parentChildBase("server", undefined));
  assert("error" in parentChildBase("server", "https://example.com/desktop.ts"));
});

/** A detection input with defaults. */
function launchInput(extra: Partial<SidecarChildLaunchInput>): SidecarChildLaunchInput {
  return {
    marker: "server",
    argc: "0",
    args: [],
    standalone: false,
    entryPath: "/p/desktop.ts",
    sidecars: SIDECARS,
    ...extra,
  };
}

Deno.test("sidecarChildLaunch: a compiled app's child has the runtime's `run <entry> …args` (every OS)", () => {
  for (const { entry } of PLATFORMS) {
    const launch = sidecarChildLaunch(launchInput({
      standalone: true,
      entryPath: entry,
      argc: "3",
      args: ["run", entry, "mcp-bridge", "--stdio", "run"],
    }));
    assertEquals(launch?.name, "server");
    assertEquals(launch?.args, ["mcp-bridge", "--stdio", "run"]);
    assertEquals(launch?.definition, SIDECARS[0]);
    // No arguments of its own.
    const bare = sidecarChildLaunch(launchInput({
      standalone: true,
      entryPath: entry,
      args: ["run", entry],
    }));
    assertEquals(bare?.args, []);
  }
});

Deno.test("sidecarChildLaunch: a stray marker on a normal launch is ignored", () => {
  // No marker at all.
  assertEquals(sidecarChildLaunch(launchInput({ marker: undefined })), null);
  assertEquals(sidecarChildLaunch(launchInput({ marker: "" })), null);
  // The app opened with arguments of its own (a deep link, a file), not the worker shape.
  for (
    const args of [
      [],
      ["myapp://open"],
      ["run", "/elsewhere/desktop.ts", "x"],
      ["/p/desktop.ts", "x"],
    ]
  ) {
    assertEquals(
      sidecarChildLaunch(launchInput({ standalone: true, argc: "1", args })),
      null,
      JSON.stringify(args),
    );
  }
  // A count that does not fit.
  assertEquals(
    sidecarChildLaunch(launchInput({
      standalone: true,
      argc: "9",
      args: ["run", "/p/desktop.ts"],
    })),
    null,
  );
});

Deno.test("sidecarChildLaunch: the Deno CLI's arguments are the child's; a bad marker throws", () => {
  assertEquals(
    sidecarChildLaunch(launchInput({ marker: "node", argc: "2", args: ["a", "-b"] }))?.args,
    ["a", "-b"],
  );
  assertThrows(
    () => sidecarChildLaunch(launchInput({ argc: "x", args: ["a"] })),
    Error,
    SIDECAR_CHILD_ARGC_ENV,
  );
  assertThrows(() => sidecarChildLaunch(launchInput({ argc: undefined })), Error);
  assertThrows(
    () => sidecarChildLaunch(launchInput({ marker: "nope" })),
    Error,
    "names no module sidecar",
  );
  assertThrows(
    () => sidecarChildLaunch(launchInput({ marker: "tool" })),
    Error,
    "names no module sidecar",
  );
});

Deno.test("readSidecarChildLaunch: reads this process and removes the markers", () => {
  Deno.env.set(SIDECAR_CHILD_ENV, "server");
  Deno.env.set(SIDECAR_CHILD_ARGC_ENV, "0");
  try {
    const launch = readSidecarChildLaunch(import.meta.url, SIDECARS);
    assertEquals(launch?.name, "server");
    assertEquals(launch?.args, []);
    assertEquals(Deno.env.get(SIDECAR_CHILD_ENV), undefined);
    assertEquals(Deno.env.get(SIDECAR_CHILD_ARGC_ENV), undefined);
    assertEquals(readSidecarChildLaunch(import.meta.url, SIDECARS), null);
  } finally {
    Deno.env.delete(SIDECAR_CHILD_ENV);
    Deno.env.delete(SIDECAR_CHILD_ARGC_ENV);
  }
});

// ── the helpers ──────────────────────────────────────────────────────────────────────────────

/** The helpers module, as the worker wrapper and a child load it. */
interface Helpers {
  bannerLength(s: string): number;
  childHelpers(base: SidecarChildBase): {
    childCommand(args?: unknown): { command: string; args: string[]; env: Record<string, string> };
    spawnSelf(args?: string[], options?: Record<string, unknown>): ChildLike;
  };
}

/** The bits of a `node:child_process` child the tests use. */
interface ChildLike {
  stdin: { end(s: string): void };
  stdout: { setEncoding(e: string): void; on(e: string, f: (d: string) => void): void };
  on(e: "close", f: (code: number | null) => void): void;
}

const helpers = await import(sidecarChildHelpersUrl()) as Helpers;

Deno.test("childCommand: the base, then the child's arguments and their count", () => {
  const { childCommand } = helpers.childHelpers({
    name: "server",
    command: "C:\\Program Files\\My App\\My App.exe",
    args: ["run", "C:\\Temp\\desktop.ts"],
    env: { [SIDECAR_CHILD_ENV]: "server" },
    argcEnv: SIDECAR_CHILD_ARGC_ENV,
    banner: true,
  });
  assertEquals(childCommand(["mcp-bridge", 3 as unknown as string]), {
    command: "C:\\Program Files\\My App\\My App.exe",
    args: ["run", "C:\\Temp\\desktop.ts", "mcp-bridge", "3"],
    env: { [SIDECAR_CHILD_ENV]: "server", [SIDECAR_CHILD_ARGC_ENV]: "2" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  } as unknown as ReturnType<typeof childCommand>);
  assertEquals(childCommand().args, ["run", "C:\\Temp\\desktop.ts"]);
  assertThrows(() => childCommand("mcp-bridge"), TypeError);
  const broken = helpers.childHelpers({ error: "no entry" });
  assertThrows(() => broken.childCommand([]), Error, "no entry");
  assertThrows(() => broken.spawnSelf([]), Error, "no entry");
});

Deno.test("bannerLength: the runtime's start-up lines, whole, partial or absent", () => {
  const line1 = "Runtime loaded successfully from: /App.app/Contents/MacOS/libruntime.dylib\n";
  assertEquals(helpers.bannerLength(""), -1);
  assertEquals(helpers.bannerLength("Runtime lo"), -1);
  assertEquals(helpers.bannerLength("Runtime loaded successfully from: /App"), -1);
  assertEquals(helpers.bannerLength(line1), -1);
  assertEquals(helpers.bannerLength(line1 + "Runtime sta"), -1);
  assertEquals(helpers.bannerLength(line1 + "Runtime started\n{}"), line1.length + 16);
  const crlf = "Runtime loaded successfully from: C:\\App\\runtime.dll\r\n";
  assertEquals(helpers.bannerLength(crlf + "Runtime started\r\n{}"), crlf.length + 17);
  // Only the first line (a runtime that prints one), then the child's own output.
  assertEquals(helpers.bannerLength(line1 + "{}\n"), line1.length);
  // The child's own output from the first byte.
  assertEquals(helpers.bannerLength("{"), 0);
  assertEquals(helpers.bannerLength("Runtime error\n"), 0);
});

/** A fake child program: the given start-up output, then its stdin echoed, then exit 3. */
const FAKE_CHILD = `
const out = (s) => Deno.stdout.writeSync(new TextEncoder().encode(s));
for (const part of JSON.parse(Deno.env.get("FAKE_PREFIX"))) { out(part); await new Promise((r) => setTimeout(r, 20)); }
const text = new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer());
out(JSON.stringify({ text, args: Deno.args, marker: Deno.env.get("${SIDECAR_CHILD_ENV}") ?? null,
  argc: Deno.env.get("${SIDECAR_CHILD_ARGC_ENV}") ?? null, leaked: Deno.env.get("DENO_DESKTOP_WS_URL") ?? null }) + "\\n");
Deno.exit(3);
`;

/** Run `spawnSelf` against the fake child; resolves its exit code and stdout. */
async function spawnFake(
  dir: string,
  prefix: string[],
  banner: boolean,
): Promise<{ code: number | null; out: string }> {
  const script = join(dir, "child.mjs");
  await Deno.writeTextFile(script, FAKE_CHILD);
  const { spawnSelf } = helpers.childHelpers({
    name: "server",
    command: Deno.execPath(),
    args: ["run", "-A", script],
    env: { [SIDECAR_CHILD_ENV]: "server" },
    argcEnv: SIDECAR_CHILD_ARGC_ENV,
    banner,
  });
  const child = spawnSelf(["a", "b"], {
    env: { ...Deno.env.toObject(), FAKE_PREFIX: JSON.stringify(prefix), DENO_DESKTOP_WS_URL: "x" },
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => out += d);
  child.stdin.end("ping");
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, out };
}

Deno.test("spawnSelf: the child's stdout without the runtime's start-up lines; IPC, marker, argc", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-child-" });
  try {
    const echoed = JSON.stringify({
      text: "ping",
      args: ["a", "b"],
      marker: "server",
      argc: "2",
      leaked: null, // the runtime's own variables never reach a child
    }) + "\n";
    // The two lines, split across writes as a pipe may deliver them.
    const split = await spawnFake(dir, [
      "Runtime lo",
      "aded successfully from: /App/libruntime.dylib\nRunt",
      "ime started\n",
    ], true);
    assertEquals(split, { code: 3, out: echoed });
    // Windows line ends.
    assertEquals(
      await spawnFake(dir, [
        "Runtime loaded successfully from: C:\\App\\runtime.dll\r\nRuntime started\r\n",
      ], true),
      { code: 3, out: echoed },
    );
    // No start-up lines (another runtime): nothing is taken from the child's output.
    assertEquals(await spawnFake(dir, ["Runtime error: kept\n"], true), {
      code: 3,
      out: "Runtime error: kept\n" + echoed,
    });
    // The Deno CLI prints none, and the output is not touched.
    const cli = await spawnFake(dir, ["Runtime started\n"], false);
    assertEquals(cli, { code: 3, out: "Runtime started\n" + echoed });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spawnSelf: without permissions.run over the app's executable it says so", async () => {
  // A process without --allow-run, as a packaged app whose sidecar did not ask for it.
  const script = `
const { sidecarChildHelpersUrl } = await import(${
    JSON.stringify(import.meta.resolve("../src/desktop/sidecar-child.ts"))
  });
const { childHelpers } = await import(sidecarChildHelpersUrl());
try {
  childHelpers({ name: "server", command: Deno.execPath(), args: ["run", "x.ts"], env: {}, argcEnv: "N", banner: false }).spawnSelf([]);
  console.log("spawned");
} catch (err) {
  console.log(err.message);
}`;
  const dir = await Deno.makeTempDir({ prefix: "denext-sidecar-child-" });
  const file = join(dir, "probe.mjs");
  await Deno.writeTextFile(file, script);
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--allow-read",
      "--allow-env",
      "--config",
      fromFileUrl(new URL("../deno.json", import.meta.url)),
      file,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output().finally(() => Deno.remove(dir, { recursive: true }));
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(/sidecar server: spawnSelf\(\) .*permissions\.run/.test(text), text);
});

// ── a real module sidecar and its child ──────────────────────────────────────────────────────

const FIXTURE = new URL("./fixtures/sidecar-child/", import.meta.url);

Deno.test({
  name: "worker sidecar: spawnSelf starts a child of the app that runs the module headless",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const entry = new URL("desktop.ts", FIXTURE).href;
    const definition: SidecarDefinition = {
      name: "echo",
      run: { module: "./echo.mjs" },
      env: { MODE: "desktop" },
    };
    const lines: string[] = [];
    let ready = 0;
    const ctx: SidecarLaunchContext = {
      definition,
      bootstrap: null,
      secrets: { TOKEN: "s3cret" },
      onLine: (stream, line) => lines.push(`${stream}:${line}`),
      onReadySignal: () => ready++,
    };
    const inst = await workerSidecarLauncher({
      entry: sidecarModuleUrl(definition, entry),
      child: parentChildBase("echo", entry),
    })(ctx);
    try {
      const end = Date.now() + 90_000;
      while (ready === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      const line = lines.find((l) => l.startsWith("stdout:RESULT "));
      assert(line, `no result within 90 s: ${lines.join("\n")}`);
      const result = JSON.parse(line.slice("stdout:RESULT ".length));
      assertEquals(result.code, 7, result.err);
      assertEquals(JSON.parse(result.out), {
        name: "echo",
        argv: ["echo", "7", "--flag"],
        input: "ping\n",
        mode: "desktop", // the sidecar's environment
        marker: null, // removed, so a grandchild does not inherit it
        secrets: [], // never handed to a child
      });
    } finally {
      await inst.stop(0);
    }
  },
});
