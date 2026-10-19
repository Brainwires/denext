import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { splitWindowsCommandLine } from "../src/cli/windows-command-line.ts";
import { ownCommandLine, type parseRunCommandLine } from "../src/cli/self-exec.ts";

Deno.test("splitWindowsCommandLine: MSVC's quoting and backslash rules", () => {
  // The program takes no escapes; quotes only group.
  assertEquals(
    splitWindowsCommandLine(
      `"C:\\Program Files\\deno\\deno.exe" run -A --config C:\\app\\deno.json C:\\fw\\cli.ts build`,
    ),
    [
      "C:\\Program Files\\deno\\deno.exe",
      "run",
      "-A",
      "--config",
      "C:\\app\\deno.json",
      "C:\\fw\\cli.ts",
      "build",
    ],
  );
  assertEquals(splitWindowsCommandLine(`deno.exe "a b"  c\td`), ["deno.exe", "a b", "c", "d"]);
  // A trailing backslash before a closing quote: 2n backslashes are n, and the quote ends it.
  assertEquals(splitWindowsCommandLine(`x "C:\\dir with space\\\\" next`), [
    "x",
    "C:\\dir with space\\",
    "next",
  ]);
  // 2n+1 backslashes before a quote: n backslashes and a literal quote.
  assertEquals(splitWindowsCommandLine(`x a\\"b "c\\\\\\"d"`), ["x", 'a"b', 'c\\"d']);
  // Backslashes not before a quote are literal; "" inside quotes is a literal quote.
  assertEquals(splitWindowsCommandLine(`x a\\\\b "say ""hi"""`), ["x", "a\\\\b", 'say "hi"']);
  assertEquals(splitWindowsCommandLine(`x "" y`), ["x", "", "y"]);
  assertEquals(splitWindowsCommandLine("   "), []);
});

// The toolchain re-exec reads its parent's `--config` from here. It used to return null on
// Windows, so a CLI started with `--config <app>/deno.json` on a local checkout re-ran with the
// checkout's own config and lost the app's import map.
Deno.test("ownCommandLine: a child reads its own --config and resolution flags, on every OS", async () => {
  assert(await ownCommandLine() !== null, "this process's command line is readable");
  const dir = await Deno.makeTempDir({ prefix: "denext_cmdline_" });
  try {
    // The checkout's config (its import map resolves self-exec.ts's imports), named explicitly:
    // the probe's own directory has none, so only the flag can have said it.
    const config = fromFileUrl(new URL("../deno.json", import.meta.url));
    const script = join(dir, "probe.ts");
    const selfExec = new URL("../src/cli/self-exec.ts", import.meta.url).href;
    await Deno.writeTextFile(
      script,
      `import { ownCommandLine, parseRunCommandLine } from ${JSON.stringify(selfExec)};\n` +
        `const argv = await ownCommandLine();\n` +
        `console.log(JSON.stringify(argv && parseRunCommandLine(argv)));\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", config, "--node-modules-dir=none", script],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    assert(out.success, dec.decode(out.stderr));
    const line = JSON.parse(dec.decode(out.stdout)) as ReturnType<typeof parseRunCommandLine>;
    assert(line !== null, "the command line is readable");
    assertEquals(line.config, config);
    assertEquals(line.resolution, ["--node-modules-dir=none"]);
    assertEquals(line.script, script);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
