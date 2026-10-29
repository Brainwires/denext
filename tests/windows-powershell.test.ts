// Windows PowerShell 5.1 under a module path inherited from PowerShell 7: every script denext
// hands `powershell.exe` first points `PSModulePath` at 5.1's own modules, so its cmdlets
// (`Add-Type`, `New-Object`, `ConvertFrom-Json`, `Get-NetTCPConnection`, …) still autoload when
// an app or the CLI was started from a `pwsh` terminal.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { OWN_MODULE_PATH, withOwnModules } from "../src/build/windows-powershell.ts";
import { SHELL_PATH_ENV, shellPathCommand } from "../src/desktop/caps/shell.ts";
import { secureStoreCommand } from "../src/desktop/caps/secure-store.ts";
import { DIALOG_NAME_ENV, dialogsCapability } from "../src/desktop/caps/dialogs.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import type { DesktopCapCtx } from "../src/desktop/extension.ts";
import { listeningPidCommand } from "../src/profile/browser.ts";

const WINDOWS = Deno.build.os === "windows";

/** The `-Command` script of a `powershell.exe` argv. */
function commandScript(args: readonly string[]): string {
  const i = args.indexOf("-Command");
  assert(i >= 0 && i + 1 < args.length, `no -Command in ${args.join(" ")}`);
  return args[i + 1];
}

/** A script that resets the module path before anything else runs. */
function assertResetsFirst(script: string): void {
  assert(script.startsWith(`${OWN_MODULE_PATH}; `), `no module-path reset first: ${script}`);
}

Deno.test("withOwnModules: the module-path reset, then the script", () => {
  assertEquals(OWN_MODULE_PATH, '$env:PSModulePath = "$PSHOME\\Modules"');
  assertEquals(
    withOwnModules("Add-Type -AssemblyName X"),
    `${OWN_MODULE_PATH}; Add-Type -AssemblyName X`,
  );
  assertEquals(withOwnModules("a\nb"), `${OWN_MODULE_PATH}; a\nb`);
});

Deno.test("shell trash on Windows: the script resets the module path first", () => {
  const [cmd, args] = shellPathCommand("windows", "trash", "C:\\app\\data\\a.txt");
  assertEquals(cmd, "powershell.exe");
  const script = commandScript(args);
  assertResetsFirst(script);
  assertStringIncludes(script, "Add-Type -AssemblyName Microsoft.VisualBasic");
});

Deno.test("secure store on Windows: every op's script resets the module path first", () => {
  for (const op of ["get", "set", "delete"] as const) {
    const c = secureStoreCommand("windows", op, "svc", "key", op === "set" ? "QjY0" : undefined);
    assertEquals(c.cmd, "powershell.exe");
    const script = commandScript(c.args);
    assertResetsFirst(script);
    assertStringIncludes(script, "ConvertFrom-Json");
  }
});

Deno.test("dialogs on Windows: every panel's script resets the module path first", async () => {
  const seen: string[][] = [];
  const cap = dialogsCapability({
    picked: new PickedPaths(),
    os: "windows",
    api: null,
    run: (cmd, args) => {
      assertEquals(cmd, "powershell.exe");
      seen.push(args);
      return Promise.resolve({ code: 1, stdout: "" }); // cancelled
    },
  });
  const ctx: DesktopCapCtx = {
    emit: () => {},
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
    os: "windows",
    signal: new AbortController().signal,
  };
  await cap.methods.openFile.handler({}, ctx);
  await cap.methods.saveFile.handler({ data: "x", suggestedName: "a.txt" }, ctx);
  await cap.methods.pickFolder.handler({}, ctx);
  assertEquals(seen.length, 3);
  for (const args of seen) {
    const script = commandScript(args);
    assertResetsFirst(script);
    assertStringIncludes(script, "Add-Type -AssemblyName System.Windows.Forms");
    assertStringIncludes(script, `$env:${DIALOG_NAME_ENV}`);
  }
});

Deno.test("profiler's listening-pid lookup: Windows resets the module path; elsewhere lsof", () => {
  const [cmd, args] = listeningPidCommand("9222", true);
  assertEquals(cmd, "powershell");
  const script = commandScript(args);
  assertResetsFirst(script);
  assertStringIncludes(script, "Get-NetTCPConnection -LocalPort 9222 -State Listen");
  assertEquals(listeningPidCommand("9222", false), [
    "lsof",
    ["-nP", "-iTCP:9222", "-sTCP:LISTEN", "-t"],
  ]);
});

/** Run a program under `PSModulePath = poisoned` (plus `env`), feeding `stdin` when given. */
async function runPoisoned(
  poisoned: string,
  cmd: string,
  args: readonly string[],
  env: Record<string, string> = {},
  stdin?: string,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(cmd, {
    args: [...args],
    env: { ...env, PSModulePath: poisoned },
    cwd,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const out = await child.output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
}

Deno.test({
  name: "Windows: the generated scripts run under a module path inherited from PowerShell 7",
  ignore: !WINDOWS,
  // sanitizer: real powershell.exe children (stdin written, then closed) on Windows only; the
  // test came from the PSModulePath fix, before the ratchet
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext-psmodulepath-" });
    try {
      // A PSModulePath like the one Windows PowerShell inherits from PowerShell 7: 7's copies of
      // 5.1's own modules, each claiming the commands denext's scripts call, whose .NET Core
      // assemblies 5.1 cannot load.
      const poisoned = join(dir, "modules");
      const modules: Record<string, string[]> = {
        "Microsoft.PowerShell.Utility": ["Add-Type", "New-Object", "ConvertFrom-Json"],
        "Microsoft.PowerShell.Management": ["Get-PSDrive"],
        "NetTCPIP": ["Get-NetTCPConnection"],
      };
      for (const [m, commands] of Object.entries(modules)) {
        const list = commands.map((c) => `'${c}'`).join(",");
        await Deno.mkdir(join(poisoned, m), { recursive: true });
        await Deno.writeTextFile(
          join(poisoned, m, `${m}.psd1`),
          `@{ GUID = '${crypto.randomUUID()}'; ModuleVersion = '7.0.0.0'; ` +
            "CompatiblePSEditions = @('Core'); PowerShellVersion = '3.0'; " +
            `NestedModules = 'missing.dll'; CmdletsToExport = @(${list}); ` +
            `FunctionsToExport = @(${list}); AliasesToExport = @() }`,
        );
      }
      const autoloadFailed = /CouldNotAutoloadMatchingModule/;

      // The fixture bites: without the reset, `Add-Type` cannot load.
      const bare = await runPoisoned(poisoned, "powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName Microsoft.VisualBasic",
      ]);
      assertMatch(bare.stderr, autoloadFailed);

      // The shell trash (`Add-Type`, the same cmdlet the dialogs use): a missing file gets as far
      // as the delete itself.
      const missing = join(dir, "missing.txt");
      const [tcmd, targs] = shellPathCommand("windows", "trash", missing);
      const trash = await runPoisoned(poisoned, tcmd, targs, { [SHELL_PATH_ENV]: missing });
      assert(!autoloadFailed.test(trash.stderr), trash.stderr);
      assertMatch(trash.stderr, /Could not find|FileNotFound/i);

      // The profiler's listening-pid lookup (`Get-NetTCPConnection`) loads, and finds this
      // process wherever the account may query CIM at all (a restricted account is denied
      // either way, which is not a module failure).
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      try {
        const port = String((listener.addr as Deno.NetAddr).port);
        const [pcmd, pargs] = listeningPidCommand(port, true);
        const pid = await runPoisoned(poisoned, pcmd, pargs);
        assert(!autoloadFailed.test(pid.stderr), pid.stderr);
        if (!/denied/i.test(pid.stderr)) assertEquals(pid.stdout.trim(), String(Deno.pid));
      } finally {
        listener.close();
      }

      // The secure store (`ConvertFrom-Json`, `New-Object`): a PasswordVault round trip.
      const service = "denext-psmodulepath-test";
      const key = `k-${crypto.randomUUID()}`;
      const vault = (op: "get" | "set" | "delete", value?: string) => {
        const c = secureStoreCommand("windows", op, service, key, value);
        return runPoisoned(poisoned, c.cmd, c.args, {}, c.stdin);
      };
      try {
        const set = await vault("set", "QjY0");
        assert(!autoloadFailed.test(set.stderr), set.stderr);
        assertEquals(set.code, 0, set.stderr);
        const got = await vault("get");
        assertEquals([got.code, got.stdout], [0, "QjY0"], got.stderr);
      } finally {
        const del = await vault("delete");
        assert(!autoloadFailed.test(del.stderr), del.stderr);
      }
      assertEquals((await vault("get")).code, 1, "deleted");

      // The stack's free-space probe, through the CLI helper itself.
      const root = fromFileUrl(new URL("..", import.meta.url));
      const free = await runPoisoned(
        poisoned,
        Deno.execPath(),
        [
          "eval",
          "import { hostFreeBytes } from './src/cli/commands/stack-io.ts';" +
          "console.log(await hostFreeBytes(Deno.cwd()));",
        ],
        {},
        undefined,
        root,
      );
      assertMatch(free.stdout.trim(), /^\d+$/, free.stderr);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
