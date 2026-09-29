// Pre-2.11 desktop audit regressions: the bridge resolves only OWN capability methods (a
// prototype name is `unavailable`, not a 500), the keep-awake child is tied to the app's pid (so a
// quit/crash that never releases cannot leave the machine awake), and path confinement refuses a
// DANGLING symlink (a write through it would land outside the scope).

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { echoCapability } from "../src/desktop/caps/echo.ts";
import { keepAwakeCommand } from "../src/desktop/caps/keep-awake.ts";
import { confineRelative, confineWithinRoots } from "../src/desktop/path-scope.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "hardening-token";

function rpc(body: unknown): Request {
  return new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-denext-desktop-token": TOKEN,
    },
    body: JSON.stringify(body),
  });
}

Deno.test("bridge: a prototype method name is `unavailable` (404), never a handler crash", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  for (const method of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const req = rpc({ cap: "echo", method, args: null });
    const res = (await bridge.handle(req, new URL(req.url), TOKEN))!;
    assertEquals(res.status, 404, method);
    const body = await res.json();
    assertEquals(body.error.code, "unavailable", method);
  }
});

Deno.test("keepAwake: the assertion child is tied to the app's pid on macOS and Linux", () => {
  assertEquals(keepAwakeCommand("darwin", 4242), ["caffeinate", ["-dimsu", "-w", "4242"]]);
  const [cmd, args] = keepAwakeCommand("linux", 4242);
  assertEquals(cmd, "systemd-inhibit");
  // The inhibitor's held command returns when the pid exits (never an unbounded `sleep`).
  assertEquals(args.slice(-4), ["tail", "--pid=4242", "-f", "/dev/null"]);
  assertEquals(args.includes("sleep"), false);
});

Deno.test("path-scope: a dangling symlink out of the scope is refused (relative and absolute)", async () => {
  if (Deno.build.os === "windows") return; // symlink creation needs privileges on Windows
  const root = await Deno.makeTempDir();
  try {
    const base = join(root, "base");
    const outside = join(root, "outside");
    await Deno.mkdir(base);
    await Deno.mkdir(outside);
    // `link` → a not-yet-existing file OUTSIDE base: realPath fails, so only lstat sees it.
    await Deno.symlink(join(outside, "created.txt"), join(base, "link"));
    const err = await assertRejects(() => confineRelative(base, "link"), DesktopCapError);
    assertEquals(err.code, "forbidden");
    const err2 = await assertRejects(
      () => confineWithinRoots(join(base, "link"), [base]),
      DesktopCapError,
    );
    assertEquals(err2.code, "forbidden");
    // A path BELOW the dangling link is refused too.
    await assertRejects(() => confineRelative(base, "link/deeper.txt"), DesktopCapError);
    // A regular not-yet-existing file is still allowed.
    assertEquals(await confineRelative(base, "new.txt"), join(base, "new.txt"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
