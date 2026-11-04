// Helper programs (src/utils/system-programs.ts) come from fixed install locations, never from PATH:
// the default-route lookup of `denext dev --lan` and the GitHub CLI the desktop runtime's
// provenance check runs.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  ghPath,
  type ProgramFs,
  type ProgramStat,
  systemToolPath,
  trustedProgram,
} from "../src/utils/system-programs.ts";
import { defaultRouteCommand } from "../src/build/dev-server/lan.ts";

/** An `isFile` that knows only `paths`. */
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const env = (vars: Record<string, string>) => (name: string) => vars[name];
/** A trust check that accepts every candidate (the install-location tests). */
const anyOwner = () => true;

Deno.test("systemToolPath: the OS's own directories, in order, never PATH", () => {
  assertEquals(systemToolPath("ip", "linux", only("/sbin/ip", "/bin/ip")), "/sbin/ip");
  assertEquals(systemToolPath("ip", "linux", only("/usr/sbin/ip", "/sbin/ip")), "/usr/sbin/ip");
  assertEquals(systemToolPath("ip", "linux", only("/home/me/bin/ip")), null);
  assertEquals(
    systemToolPath("route", "windows", () => true, env({ SystemRoot: "D:\\WINNT\\" })),
    "D:\\WINNT\\System32\\route.exe",
  );
  // A relative or odd SystemRoot is not followed.
  for (const root of [".", "Windows", "\\\\server\\share", ""]) {
    assertEquals(
      systemToolPath("route", "windows", () => true, env({ SystemRoot: root })),
      "C:\\Windows\\System32\\route.exe",
      root,
    );
  }
});

Deno.test("defaultRouteCommand: ip / route by absolute path, or nothing to run", () => {
  assertEquals(defaultRouteCommand("linux", only("/usr/sbin/ip")), [
    "/usr/sbin/ip",
    "-4",
    "route",
    "show",
    "default",
  ]);
  assertEquals(defaultRouteCommand("darwin", only("/sbin/route")), [
    "/sbin/route",
    "-n",
    "get",
    "default",
  ]);
  assertEquals(defaultRouteCommand("windows", () => true, env({})), [
    "C:\\Windows\\System32\\route.exe",
    "print",
    "-4",
    "0.0.0.0",
  ]);
  assertEquals(defaultRouteCommand("linux", () => false), null);
});

Deno.test("ghPath: where the GitHub CLI's installers put it, never PATH", () => {
  assertEquals(
    ghPath("darwin", only("/opt/homebrew/bin/gh", "/usr/local/bin/gh"), env({}), anyOwner),
    "/opt/homebrew/bin/gh",
  );
  assertEquals(ghPath("linux", only("/usr/bin/gh"), env({}), anyOwner), "/usr/bin/gh");
  assertEquals(ghPath("linux", only("/snap/bin/gh"), env({}), anyOwner), "/snap/bin/gh");
  assertEquals(ghPath("linux", only("/tmp/evil/gh", "./gh"), env({}), anyOwner), null);
  assertEquals(
    ghPath("windows", () => true, env({ ProgramFiles: "D:\\Apps" })),
    "D:\\Apps\\GitHub CLI\\gh.exe",
  );
  // Never the per-user install under %LOCALAPPDATA%\\Programs: any program the user runs can
  // write there, so a planted gh.exe would run.
  assertEquals(
    ghPath(
      "windows",
      only("C:\\Users\\me\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe"),
      env({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
    ),
    null,
  );
  // %ProgramFiles% counts only as an absolute drive path; anything else is the default install.
  assertEquals(
    ghPath(
      "windows",
      only("C:\\Program Files\\GitHub CLI\\gh.exe"),
      env({ ProgramFiles: "..\\evil" }),
    ),
    "C:\\Program Files\\GitHub CLI\\gh.exe",
  );
  assertEquals(ghPath("windows", () => false, env({ LOCALAPPDATA: "relative" })), null);
});

Deno.test("ghPath: a gh that another user could have replaced is skipped", () => {
  // /opt/homebrew/bin and /usr/local/bin are often writable by a user other than root: a gh there
  // runs only when nobody but root and this user can change it or its folders.
  const both = only("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh");
  const refuse = (...paths: string[]) => (path: string) => !paths.includes(path);
  assertEquals(
    ghPath("darwin", both, env({}), refuse("/opt/homebrew/bin/gh")),
    "/usr/local/bin/gh",
  );
  assertEquals(
    ghPath("darwin", both, env({}), refuse("/opt/homebrew/bin/gh", "/usr/local/bin/gh")),
    "/usr/bin/gh",
  );
  assertEquals(ghPath("linux", only("/usr/local/bin/gh"), env({}), () => false), null);
  // Windows keeps its admin-only %ProgramFiles% rule; the POSIX owner check does not apply.
  assertEquals(
    ghPath("windows", () => true, env({ ProgramFiles: "D:\\Apps" }), () => false),
    "D:\\Apps\\GitHub CLI\\gh.exe",
  );
});

/** A file system of fixed entries; a path missing from it does not exist. */
function fakeFs(entries: Record<string, Partial<ProgramStat>>, uid = 501): ProgramFs {
  return {
    stat(path) {
      const entry = entries[path];
      if (!entry) throw new Deno.errors.NotFound(path);
      return { isFile: false, isDirectory: true, uid: 0, gid: 0, mode: 0o755, ...entry };
    },
    realPath: (path) => path === "/opt/homebrew/bin/gh" ? "/opt/homebrew/Cellar/gh/bin/gh" : path,
    uid: () => uid,
  };
}

const HOMEBREW: Record<string, Partial<ProgramStat>> = {
  "/": {},
  "/opt": {},
  "/opt/homebrew": { uid: 501, gid: 80 },
  "/opt/homebrew/bin": { uid: 501, gid: 80, mode: 0o775 },
  "/opt/homebrew/Cellar": { uid: 501, gid: 80, mode: 0o775 },
  "/opt/homebrew/Cellar/gh": { uid: 501, gid: 80 },
  "/opt/homebrew/Cellar/gh/bin": { uid: 501, gid: 80 },
  "/opt/homebrew/Cellar/gh/bin/gh": { isFile: true, isDirectory: false, uid: 501, gid: 80 },
};

Deno.test("trustedProgram: owned by root or this user, writable by no one else", () => {
  const gh = "/opt/homebrew/bin/gh";
  // This user's Homebrew (macOS's admin group may write: its members can become root anyway).
  assert(trustedProgram(gh, "darwin", fakeFs(HOMEBREW)));
  // Another user's Homebrew: they could swap gh for their own program.
  assertEquals(trustedProgram(gh, "darwin", fakeFs(HOMEBREW, 502)), false);
  // A folder on the way (the link's or the real file's) that others may write.
  for (const dir of ["/opt/homebrew/bin", "/opt/homebrew/Cellar/gh", "/opt"]) {
    assertEquals(
      trustedProgram(gh, "darwin", fakeFs({ ...HOMEBREW, [dir]: { uid: 501, mode: 0o777 } })),
      false,
      dir,
    );
  }
  // A group other than admin / wheel may write the file.
  const groupFile = { ...HOMEBREW["/opt/homebrew/Cellar/gh/bin/gh"], gid: 20, mode: 0o775 };
  assertEquals(
    trustedProgram(
      gh,
      "darwin",
      fakeFs({ ...HOMEBREW, "/opt/homebrew/Cellar/gh/bin/gh": groupFile }),
    ),
    false,
  );
  // Off macOS a group-writable folder counts as writable by others, admin's gid included.
  assertEquals(trustedProgram(gh, "linux", fakeFs(HOMEBREW)), false);
  // A sticky world-writable folder (/tmp) lets no one replace another user's entry.
  const sticky = { "/": {}, "/tmp": { mode: 0o1777 }, "/tmp/gh": { isFile: true, uid: 501 } };
  assert(trustedProgram("/tmp/gh", "linux", fakeFs(sticky)));
  // Missing, not a file, or a user id that can't be read: not trusted.
  assertEquals(trustedProgram("/usr/bin/gh", "linux", fakeFs({ "/": {}, "/usr": {} })), false);
  assertEquals(trustedProgram("/usr", "linux", fakeFs({ "/": {}, "/usr": {} })), false);
  const noUid = { ...fakeFs(HOMEBREW), uid: () => null };
  assertEquals(trustedProgram(gh, "darwin", noUid), false);
});

Deno.test({
  name: "trustedProgram: a real file in a folder others may write is refused",
  ignore: Deno.build.os === "windows",
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "denext-gh-trust-" });
    try {
      const gh = join(dir, "gh");
      Deno.writeTextFileSync(gh, "#!/bin/sh\n");
      Deno.chmodSync(gh, 0o755);
      Deno.chmodSync(dir, 0o755);
      assert(trustedProgram(gh));
      Deno.chmodSync(dir, 0o777);
      assertEquals(trustedProgram(gh), false);
      Deno.chmodSync(dir, 0o755);
      Deno.chmodSync(gh, 0o757);
      assertEquals(trustedProgram(gh), false);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
