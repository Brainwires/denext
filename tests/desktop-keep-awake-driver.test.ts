// The `keepAwake` capability's default POSIX driver (src/desktop/caps/keep-awake.ts): it holds the
// OS assertion as a child process (`caffeinate` on macOS, `systemd-inhibit` on Linux) for as long
// as any page hold is active, and ends it on release. The program is a stand-in on PATH here, so
// the machine's real sleep settings are never touched; desktop-caps.test.ts covers the ref
// counting with an injected driver.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { keepAwakeCapability, keepAwakeCommand } from "../src/desktop/caps/keep-awake.ts";

/** Run `fn` with PATH set to `path` only, restoring it after. */
async function withPath(path: string, fn: () => Promise<void>): Promise<void> {
  const before = Deno.env.get("PATH");
  Deno.env.set("PATH", path);
  try {
    await fn();
  } finally {
    if (before === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", before);
  }
}

/** Whether `pid` is still running. */
function alive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/** Wait until `done()` holds (at most 5 s). */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

for (const os of ["darwin", "linux"] as const) {
  Deno.test({
    name:
      `keepAwake (${os}): the assertion is a child process held while a page holds, ended on release`,
    ignore: Deno.build.os === "windows", // the stand-in is a POSIX shell script
    async fn() {
      const bin = await Deno.makeTempDir({ prefix: "dnx-keep-awake-" });
      try {
        const [program, args] = keepAwakeCommand(os, Deno.pid);
        const pidFile = join(bin, "pid");
        const argsFile = join(bin, "args");
        // Records its pid and argv, then waits to be killed, as the real assertion holders do.
        await Deno.writeTextFile(
          join(bin, program),
          `#!/bin/sh\necho $$ > "${pidFile}"\necho "$@" > "${argsFile}"\nexec /bin/sleep 30\n`,
        );
        await Deno.chmod(join(bin, program), 0o755);
        const cap = keepAwakeCapability({ os });
        assertEquals(cap.methods.acquire.permissions, { run: [program] });
        await withPath(bin, async () => {
          const { id } = await cap.methods.acquire.handler(undefined, {} as never) as {
            id: string;
          };
          await until(() => {
            try {
              return Deno.readTextFileSync(pidFile).trim() !== "";
            } catch {
              return false;
            }
          });
          const pid = Number(Deno.readTextFileSync(pidFile).trim());
          assert(alive(pid), "the assertion is held");
          await until(() => {
            try {
              return Deno.readTextFileSync(argsFile).trim() === args.join(" ");
            } catch {
              return false;
            }
          });
          await cap.methods.release.handler({ id }, {} as never);
          await until(() => !alive(pid));
          // Releasing again (the child already gone) is not an error.
          await cap.methods.release.handler({ id }, {} as never);
        });
      } finally {
        await Deno.remove(bin, { recursive: true });
      }
    },
  });
}
