// A permission the least-privilege `start` task does not grant: the server says, once, which
// permission was refused and the `start` task edit that grants it (src/server/permission-hint.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  permissionHint,
  permissionRefusal,
  reportPermissionRefusal,
} from "../src/server/permission-hint.ts";
import { reportRequestError } from "../src/server/app-config.ts";
import type { AppConfig } from "../src/server/app.ts";

/** Deno's refusal, as a least-privilege process throws it. */
function notCapable(name: string, target?: string): Error {
  const to = target === undefined ? "" : ` to "${target}"`;
  return new Deno.errors.NotCapable(
    `Requires ${name} access${to}, run again with the --allow-${name} flag`,
  );
}

Deno.test("permissionRefusal reads Deno's refusal, through a cause, and nothing else", () => {
  assertEquals(permissionRefusal(notCapable("sys", "networkInterfaces")), {
    name: "sys",
    target: "networkInterfaces",
  });
  assertEquals(permissionRefusal(notCapable("run")), { name: "run", target: null });
  const wrapped = new Error("render failed", { cause: notCapable("run", "git") });
  assertEquals(permissionRefusal(wrapped), { name: "run", target: "git" });
  assertEquals(permissionRefusal(new Error("boom")), null);
  assertEquals(permissionRefusal("Requires sys access"), null);
  // An OS-level permission error is the filesystem's, not a missing flag.
  assertEquals(
    permissionRefusal(new Deno.errors.PermissionDenied("Permission denied (os error 13)")),
    null,
  );
});

Deno.test("permissionHint names the permission, the scoped start flag, -A and the checklist", () => {
  const sys = permissionHint({ name: "sys", target: "networkInterfaces" }, false);
  assertStringIncludes(sys, 'refused sys access to "networkInterfaces"');
  assertStringIncludes(sys, "`--allow-sys=networkInterfaces` to the `start` task in deno.json");
  assertStringIncludes(sys, "already has an `--allow-sys=…` list, add `networkInterfaces` to it");
  assertStringIncludes(sys, "`-A`");
  assertStringIncludes(sys, "https://denext.dev/docs/production-checklist");
  // A write keeps `.denext`, which the task already writes.
  assertStringIncludes(
    permissionHint({ name: "write", target: "/srv/uploads" }, false),
    "`--allow-write=.denext,/srv/uploads`",
  );
  assertStringIncludes(permissionHint({ name: "run", target: "git" }, false), "`--allow-run=git`");
  const bare = permissionHint({ name: "ffi", target: null }, false);
  assertStringIncludes(bare, "`--allow-ffi` to the `start` task");
  assert(!bare.includes("already has"), bare);
});

Deno.test("permissionHint in a compiled binary points at compile.permissions", () => {
  const sys = permissionHint({ name: "sys", target: "networkInterfaces" }, true);
  assertStringIncludes(sys, '`compile: { permissions: { sys: ["networkInterfaces"] } }`');
  assertStringIncludes(sys, "`denext build --compile`");
  assert(!sys.includes("deno.json"), sys);
  assertStringIncludes(
    permissionHint({ name: "import", target: "esm.sh" }, true),
    '`compile: { permissions: "all" }`',
  );
});

Deno.test("reportPermissionRefusal prints once per permission and target", () => {
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  assert(reportPermissionRefusal(notCapable("run", "hint-once-a"), log));
  assert(reportPermissionRefusal(notCapable("run", "hint-once-a"), log));
  assert(reportPermissionRefusal(notCapable("run", "hint-once-b"), log));
  assertEquals(reportPermissionRefusal(new Error("other"), log), false);
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "`--allow-run=hint-once-a`");
  assertStringIncludes(lines[1], "`--allow-run=hint-once-b`");
});

Deno.test("a request error that is a refused permission prints the hint", async () => {
  const printed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => printed.push(args.map(String).join(" "));
  try {
    await reportRequestError(
      {} as AppConfig,
      notCapable("sys", "request-path-hint"),
      new Request("http://localhost/x"),
      "/x",
    );
  } finally {
    console.error = original;
  }
  assertEquals(printed.length, 1);
  assertStringIncludes(printed[0], "`--allow-sys=request-path-hint`");
});

Deno.test("the hint reads the refusal a least-privilege process really throws", async () => {
  // `os.networkInterfaces()` is outside the sys set a migrated app's `start` grants.
  const dir = await Deno.makeTempDir({ prefix: "denext_perm_hint_" });
  try {
    const mod = new URL("../src/server/permission-hint.ts", import.meta.url).href;
    const script = join(dir, "probe.ts");
    await Deno.writeTextFile(
      script,
      `import os from "node:os";\n` +
        `const { reportPermissionRefusal } = await import(${JSON.stringify(mod)});\n` +
        `try { os.networkInterfaces(); } catch (e) { reportPermissionRefusal(e, console.log); }\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-prompt", "--allow-read", "--allow-env", "--allow-sys=hostname", script],
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertStringIncludes(stdout, 'refused sys access to "networkInterfaces"');
    assertStringIncludes(stdout, "`--allow-sys=networkInterfaces`");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
