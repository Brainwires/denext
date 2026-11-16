// `denext ui`'s browser opener (src/ui/open.ts): the platform matrix, argv only, and every
// failure degrading to `false` so the caller prints the URL. The opener is a stand-in on PATH
// here, so no browser ever opens.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openBrowser, openCommand } from "../src/ui/open.ts";

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

const URL_WITH_SHELL = "http://127.0.0.1:5177/?t=a&b=$(touch pwned);`x`";

Deno.test("openCommand: one opener per platform, the URL a single argv entry", () => {
  assertEquals(openCommand(URL_WITH_SHELL, "darwin"), ["open", URL_WITH_SHELL]);
  assertEquals(openCommand(URL_WITH_SHELL, "windows"), ["cmd", "/c", "start", "", URL_WITH_SHELL]);
  assertEquals(openCommand(URL_WITH_SHELL, "linux"), ["xdg-open", URL_WITH_SHELL]);
  assertEquals(openCommand(URL_WITH_SHELL, "freebsd"), ["xdg-open", URL_WITH_SHELL]);
  assertEquals(openCommand(URL_WITH_SHELL, "android"), null, "no known opener");
  assertEquals(openCommand("http://x")?.at(-1), "http://x", "the host's own platform");
});

Deno.test({
  name: "openBrowser: the host's opener gets the URL verbatim, and its exit status is the answer",
  ignore: Deno.build.os === "windows" || Deno.build.os === "android", // a POSIX stand-in
  async fn() {
    const bin = await Deno.makeTempDir({ prefix: "dnx-fake-opener-" });
    try {
      const program = openCommand("x")![0];
      const record = join(bin, "argv.txt");
      // Writes each argument on its own line (no shell evaluation of the URL), then exits 0.
      await Deno.writeTextFile(
        join(bin, program),
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${record}"\n`,
      );
      await Deno.chmod(join(bin, program), 0o755);
      await withPath(bin, async () => {
        assertEquals(await openBrowser(URL_WITH_SHELL), true);
      });
      assertEquals(await Deno.readTextFile(record), `${URL_WITH_SHELL}\n`);
      assertEquals(
        await Deno.stat(join(bin, "pwned")).then(() => true, () => false),
        false,
        "nothing in the URL was evaluated",
      );
      // An opener that fails (no display) is `false`: the caller prints the URL instead.
      await Deno.writeTextFile(join(bin, program), "#!/bin/sh\nexit 3\n");
      await withPath(bin, async () => {
        assertEquals(await openBrowser("http://127.0.0.1:1/"), false);
      });
    } finally {
      await Deno.remove(bin, { recursive: true });
    }
  },
});

Deno.test("openBrowser: no opener installed is false, not a throw", async () => {
  const empty = await Deno.makeTempDir({ prefix: "dnx-no-opener-" });
  try {
    await withPath(empty, async () => {
      // `cmd` on Windows is found by its own lookup rules even with an empty PATH; elsewhere the
      // opener is simply missing.
      if (Deno.build.os !== "windows") {
        assertEquals(await openBrowser("http://127.0.0.1:1/"), false);
      }
    });
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});
