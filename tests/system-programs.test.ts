// Helper programs (src/utils/system-programs.ts) come from fixed install locations, never from PATH:
// the default-route lookup of `denext dev --lan` and the GitHub CLI the desktop runtime's
// provenance check runs.

import { assertEquals } from "@std/assert";
import { ghPath, systemToolPath } from "../src/utils/system-programs.ts";
import { defaultRouteCommand } from "../src/build/dev-server/lan.ts";

/** An `isFile` that knows only `paths`. */
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const env = (vars: Record<string, string>) => (name: string) => vars[name];

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
    ghPath("darwin", only("/opt/homebrew/bin/gh", "/usr/local/bin/gh")),
    "/opt/homebrew/bin/gh",
  );
  assertEquals(ghPath("linux", only("/usr/bin/gh")), "/usr/bin/gh");
  assertEquals(ghPath("linux", only("/snap/bin/gh")), "/snap/bin/gh");
  assertEquals(ghPath("linux", only("/tmp/evil/gh", "./gh")), null);
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
