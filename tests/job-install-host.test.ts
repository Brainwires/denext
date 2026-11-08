// `denext job install`'s real scheduler host, against a temp directory and stand-in tools: the
// "tool" a run reaches is this test's own Deno (`deno eval`) or a path that isn't there, never
// launchctl / systemctl / crontab / schtasks, so nothing is installed into a real scheduler.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  dryRunHost,
  type DryRunStep,
  realSchedulerHost,
  type SchedulerTool,
  schedulerToolPath,
} from "../src/cli/job-install/host.ts";
import { systemToolPath } from "../src/utils/system-programs.ts";

/** A real host whose every tool is `path`. */
function hostWithTool(path: string | null) {
  return realSchedulerHost({ toolPath: () => path });
}

/** A `deno eval` script's arguments (no config: the project's deno.json stays out of it). */
function evalArgs(script: string): string[] {
  return ["eval", "--no-config", script];
}

Deno.test("schedulerToolPath: launchd's own launchctl, else the OS's system directories", () => {
  assertEquals(schedulerToolPath("launchctl"), "/bin/launchctl");
  for (const tool of ["systemctl", "crontab", "schtasks"] as SchedulerTool[]) {
    assertEquals(schedulerToolPath(tool), systemToolPath(tool));
  }
});

Deno.test("the real host reads, writes and removes files in a temp directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_job_host_" });
  try {
    const host = realSchedulerHost();
    assertEquals(host.os, Deno.build.os);
    assertEquals(host.uid, Deno.uid());
    assert(host.home);
    assertEquals(host.env("DENEXT_JOB_HOST_UNSET_VARIABLE"), undefined);
    // A write creates the directory; text and bytes both land as given.
    const text = join(dir, "a", "b", "entry.txt");
    await host.writeFile(text, "hello");
    assertEquals(await host.readTextFile(text), "hello");
    const bytes = join(dir, "c", "entry.bin");
    await host.writeFile(bytes, new Uint8Array([104, 105]));
    assertEquals(await host.readTextFile(bytes), "hi");
    // A missing file reads as null; a directory read as a file is an error, not "missing".
    assertEquals(await host.readTextFile(join(dir, "missing.txt")), null);
    await assertRejects(() => host.readTextFile(join(dir, "a")));
    // A directory lists sorted; a missing one lists nothing; a file listed is an error.
    await host.ensureDir(join(dir, "z-dir"));
    assertEquals(await host.readDir(dir), ["a", "c", "z-dir"]);
    assertEquals(await host.readDir(join(dir, "nope")), []);
    await assertRejects(() => host.readDir(text));
    // A remove of a gone file is fine; a non-empty directory is an error.
    await host.remove(text);
    await host.remove(text);
    assertEquals(await host.readTextFile(text), null);
    await assertRejects(() => host.remove(join(dir, "c")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the real host needs HOME or USERPROFILE", () => {
  const saved = { HOME: Deno.env.get("HOME"), USERPROFILE: Deno.env.get("USERPROFILE") };
  try {
    Deno.env.delete("HOME");
    Deno.env.delete("USERPROFILE");
    let message = "";
    try {
      realSchedulerHost();
    } catch (err) {
      message = String(err);
    }
    assertStringIncludes(message, "neither HOME nor USERPROFILE is set");
    // USERPROFILE alone (Windows) is enough.
    Deno.env.set("USERPROFILE", "/profile/u");
    assertEquals(realSchedulerHost().home, "/profile/u");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("the real host runs a tool by its path, with and without stdin", async () => {
  const host = hostWithTool(Deno.execPath());
  const plain = await host.run("crontab", evalArgs("console.log('listed')"));
  assertEquals(plain.code, 0);
  assertEquals(plain.stdout.trim(), "listed");
  const piped = await host.run(
    "crontab",
    evalArgs("console.log((await new Response(Deno.stdin.readable).text()).toUpperCase())"),
    { stdin: "0 3 * * * job\n", mutates: true },
  );
  assertEquals(piped.code, 0);
  assertEquals(piped.stdout.trim(), "0 3 * * * JOB");
  const failed = await host.run(
    "systemctl",
    evalArgs("console.error('Failed to connect to bus'); Deno.exit(3)"),
  );
  assertEquals(failed.code, 3);
  assertStringIncludes(failed.stderr, "Failed to connect to bus");
});

Deno.test("a tool that isn't installed answers 127", async () => {
  const none = await hostWithTool(null).run("schtasks", ["/Query"]);
  assertEquals(none, { code: 127, stdout: "", stderr: "schtasks: not found" });
  const dir = await Deno.makeTempDir({ prefix: "denext_job_host_" });
  try {
    const gone = await hostWithTool(join(dir, "no-such-tool")).run("crontab", ["-l"]);
    assertEquals(gone, { code: 127, stdout: "", stderr: "crontab: not found" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "a tool that can't be started for another reason is an error, not 'not installed'",
  // A directory spawned on POSIX is EACCES; Windows reports it in its own way.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_job_host_" });
    try {
      await assertRejects(() => hostWithTool(dir).run("launchctl", ["list"]));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("a dry run records bytes as text (UTF-16 with a BOM, else UTF-8) and stdin", async () => {
  const steps: DryRunStep[] = [];
  const host = dryRunHost(hostWithTool(null), steps);
  await host.writeFile("/x/utf8.bin", new TextEncoder().encode("plain"));
  await host.writeFile("/x/one.bin", new Uint8Array([0x41]));
  await host.writeFile("/x/utf16.xml", new Uint8Array([0xff, 0xfe, 0x41, 0x00]));
  await host.ensureDir("/x/logs");
  await host.remove("/x/old");
  assertEquals(
    await host.run("crontab", ["-"], { stdin: "new\n", mutates: true }),
    { code: 0, stdout: "", stderr: "" },
  );
  // A read-only run still reaches the host (here: no such tool).
  assertEquals((await host.run("crontab", ["-l"])).code, 127);
  assertEquals(steps, [
    { kind: "write", path: "/x/utf8.bin", content: "plain" },
    { kind: "write", path: "/x/one.bin", content: "A" },
    { kind: "write", path: "/x/utf16.xml", content: "A" },
    { kind: "mkdir", path: "/x/logs" },
    { kind: "remove", path: "/x/old" },
    { kind: "run", tool: "crontab", args: ["-"], stdin: "new\n" },
  ]);
});
