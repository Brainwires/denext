// src/build/safe-extract.ts: tar.gz / zip extraction for the pinned Deno Desktop runtime. The happy
// path (files, dirs, modes, internal links, hashes) and every refusal: tar-slip / zip-slip,
// absolute paths, backslashes, escaping symlinks (lexically and through another link), writes
// through a link, hard links, devices, FIFOs, duplicates, truncation and the size cap.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { extractArchive, safeEntryPath, UnsafeArchiveError } from "../src/build/safe-extract.ts";
import { sha256Hex, type TarEntry, tarGz, zip, type ZipEntry } from "./_archive-fixtures.ts";

const posix = Deno.build.os !== "windows";

/** Write `bytes` as an archive in a fresh temp dir; returns the archive and an unused dest path. */
async function stage(bytes: Uint8Array, ext: string) {
  const base = await Deno.makeTempDir({ prefix: "denext-extract-" });
  const archive = join(base, `a.${ext}`);
  await Deno.writeFile(archive, bytes);
  return { base, archive, dest: join(base, "sub", "out") };
}

async function exists(path: string): Promise<boolean> {
  return (await Deno.lstat(path).catch(() => null)) !== null;
}

async function tgzRefused(entries: TarEntry[], match: RegExp | string) {
  const { base, archive, dest } = await stage(await tarGz(entries), "tar.gz");
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    const err = await assertRejects(() => extractArchive(archive, "tar.gz", dest));
    assert(String(err).match(match), `unexpected error: ${err}`);
    // Nothing escaped the destination.
    for (const p of ["evil", "sub/evil", "../evil"]) assert(!await exists(join(base, p)), p);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("safeEntryPath normalizes ./ and refuses traversal, absolute, backslash, ':' and NUL", () => {
  assertEquals(safeEntryPath("./laufey/webview/x"), "laufey/webview/x");
  assertEquals(safeEntryPath("./"), "");
  assertEquals(safeEntryPath("a//b/./c/"), "a/b/c");
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "a\\..\\x", "C:/x", "a:b", "a\0b"]) {
    let threw = false;
    try {
      safeEntryPath(bad);
    } catch (e) {
      threw = e instanceof UnsafeArchiveError;
    }
    assert(threw, bad);
  }
});

Deno.test("extractArchive(tar.gz): files, dirs, modes, an internal symlink and per-file hashes", async () => {
  const lib = "runtime-lib-bytes";
  const { base, archive, dest } = await stage(
    await tarGz([
      { name: "./", type: "5", mode: 0o755 },
      { name: "./libdenort.so", data: lib, mode: 0o755 },
      { name: "./laufey/", type: "5", mode: 0o755 },
      { name: "./laufey/webview/build/laufey_webview", data: "host", mode: 0o4755 },
      { name: "./laufey/webview/build/current", type: "2", link: "laufey_webview" },
      { name: "./BUILD_INFO.json", data: "{}" },
    ]),
    "tar.gz",
  );
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    const r = await extractArchive(archive, "tar.gz", dest);
    assertEquals(Object.keys(r.files).sort(), [
      "BUILD_INFO.json",
      "laufey/webview/build/laufey_webview",
      "libdenort.so",
    ]);
    assertEquals(r.files["libdenort.so"].sha256, await sha256Hex(new TextEncoder().encode(lib)));
    assertEquals(r.files["libdenort.so"].size, lib.length);
    assertEquals(await Deno.readTextFile(join(dest, "libdenort.so")), lib);
    assertEquals(r.symlinks, { "laufey/webview/build/current": "laufey_webview" });
    if (posix) {
      assertEquals((await Deno.stat(join(dest, "libdenort.so"))).mode! & 0o7777, 0o755);
      // setuid is dropped: only permission bits survive.
      assertEquals(
        (await Deno.stat(join(dest, "laufey/webview/build/laufey_webview"))).mode! & 0o7777,
        0o755,
      );
      assertEquals(
        await Deno.readTextFile(join(dest, "laufey/webview/build/current")),
        "host",
      );
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("extractArchive(tar.gz): pax and GNU long names / link targets, and a hostile pax path", async () => {
  const long = `deep/${"d".repeat(120)}/file.txt`;
  const paxRecord = (k: string, v: string) => {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len++;
    return `${len}${body}`;
  };
  const { base, archive, dest } = await stage(
    await tarGz([
      { name: "PaxHeader", type: "x", data: paxRecord("path", long) + paxRecord("mtime", "1.5") },
      { name: "short-name-ignored", data: "pax" },
      { name: "././@LongLink", type: "L", data: "gnu/long/name.txt\0" },
      { name: "trunc", data: "gnu" },
      { name: "g", type: "g", data: paxRecord("comment", "global") },
      { name: "././@LongLink", type: "K", data: "gnu/long/name.txt\0" },
      { name: "lnk", type: "2", link: "x" },
    ]),
    "tar.gz",
  );
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    const r = await extractArchive(archive, "tar.gz", dest);
    assertEquals(await Deno.readTextFile(join(dest, long)), "pax");
    assertEquals(await Deno.readTextFile(join(dest, "gnu/long/name.txt")), "gnu");
    assertEquals(r.symlinks, { lnk: "gnu/long/name.txt" });
  } finally {
    await Deno.remove(base, { recursive: true });
  }
  await tgzRefused(
    [{ name: "PaxHeader", type: "x", data: paxRecord("path", "../evil") }, {
      name: "ok",
      data: "x",
    }],
    /escapes/,
  );
  await tgzRefused([{ name: "PaxHeader", type: "x", data: "99 path=x\n" }, {
    name: "ok",
    data: "x",
  }], /malformed pax/);
});

Deno.test("extractArchive(tar.gz) refuses tar-slip and absolute entries", async () => {
  await tgzRefused([{ name: "../evil", data: "x" }], /escapes/);
  await tgzRefused([{ name: "ok/../../evil", data: "x" }], /escapes/);
  await tgzRefused([{ name: "/tmp/denext-evil", data: "x" }], /absolute/);
  await tgzRefused([{ name: "a\\..\\..\\evil", data: "x" }], /backslash/);
});

Deno.test("extractArchive(tar.gz) refuses escaping symlinks and writes through a link", async () => {
  await tgzRefused([{ name: "l", type: "2", link: "../../evil" }], /outside/);
  await tgzRefused([{ name: "l", type: "2", link: "/etc" }], /outside/);
  await tgzRefused([{ name: "d/l", type: "2", link: "../../x" }], /outside/);
  if (!posix) return;
  // `p -> .` is inside, and `q -> p/..` is lexically inside too, but really resolves to the
  // destination's PARENT: the real-path pass refuses it.
  await tgzRefused(
    [{ name: "p", type: "2", link: "." }, { name: "q", type: "2", link: "p/.." }],
    /resolves outside|dangling/,
  );
  // A link under another link (would be created through it).
  await tgzRefused(
    [{ name: "dir", type: "5" }, { name: "a", type: "2", link: "dir" }, {
      name: "a/b",
      type: "2",
      link: "x",
    }],
    /under/,
  );
  // A file "through" a link: the file's parent becomes a real dir, so the link can't be created.
  await tgzRefused(
    [{ name: "a", type: "2", link: "dir" }, { name: "a/x", data: "y" }, { name: "dir", type: "5" }],
    /exists|File exists|os error/i,
  );
  // A link to something that isn't there.
  await tgzRefused([{ name: "l", type: "2", link: "missing" }], /dangling/);
});

Deno.test("extractArchive(tar.gz) refuses hard links, devices, FIFOs and duplicates", async () => {
  await tgzRefused([{ name: "f", data: "x" }, { name: "h", type: "1", link: "f" }], /hard link/);
  await tgzRefused([{ name: "c", type: "3" }], /character device/);
  await tgzRefused([{ name: "b", type: "4" }], /block device/);
  await tgzRefused([{ name: "p", type: "6" }], /FIFO/);
  await tgzRefused([{ name: "f", data: "x" }, { name: "./f", data: "y" }], /duplicate/);
});

Deno.test("extractArchive(tar.gz) refuses a truncated archive and enforces the size cap", async () => {
  const full = await tarGz([{ name: "big", data: "z".repeat(5000) }]);
  const { base, archive, dest } = await stage(full.subarray(0, full.byteLength - 30), "tar.gz");
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    await assertRejects(() => extractArchive(archive, "tar.gz", dest));
    const capped = join(base, "capped");
    await Deno.writeFile(archive, full);
    await assertRejects(
      () => extractArchive(archive, "tar.gz", capped, { maxBytes: 1000 }),
      UnsafeArchiveError,
      "expands past",
    );
    await assertRejects(
      () => extractArchive(archive, "tar.gz", join(base, "n"), { maxEntries: 0 }),
      UnsafeArchiveError,
      "more than",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("extractArchive(zip): stored + deflated files and directories", async () => {
  const big = "deflate me ".repeat(500);
  const { base, archive, dest } = await stage(
    await zip([
      { name: "denort.dll", data: "dll" },
      { name: "laufey/", unixMode: 0o040755 },
      { name: "laufey/webview/build/laufey_webview.exe", data: big, deflate: true },
    ]),
    "zip",
  );
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    const r = await extractArchive(archive, "zip", dest);
    assertEquals(
      await Deno.readTextFile(join(dest, "laufey/webview/build/laufey_webview.exe")),
      big,
    );
    assertEquals(r.files["denort.dll"].size, 3);
    assert(r.dirs.includes("laufey"));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

async function zipRefused(entries: ZipEntry[], match: RegExp) {
  const { base, archive, dest } = await stage(await zip(entries), "zip");
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    const err = await assertRejects(() => extractArchive(archive, "zip", dest));
    assert(String(err).match(match), `unexpected error: ${err}`);
    assert(!await exists(join(base, "evil")));
    assert(!await exists(join(base, "sub", "evil")));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("extractArchive(zip) refuses zip-slip, backslash paths, escaping links and specials", async () => {
  await zipRefused([{ name: "../evil", data: "x" }], /escapes/);
  await zipRefused([{ name: "..\\evil", data: "x" }], /backslash/);
  await zipRefused([{ name: "/evil", data: "x" }], /absolute/);
  await zipRefused([{ name: "C:/evil", data: "x" }], /':'/);
  await zipRefused([{ name: "l", data: "../../evil", unixMode: 0o120777 }], /outside/);
  await zipRefused([{ name: "fifo", data: "", unixMode: 0o010644 }], /special/);
  await zipRefused([{ name: "a", data: "1" }, { name: "a", data: "2" }], /duplicate/);
});

Deno.test("extractArchive(zip) refuses a file that isn't a zip", async () => {
  const { base, archive, dest } = await stage(new TextEncoder().encode("not a zip"), "zip");
  await Deno.mkdir(dirname(dest), { recursive: true });
  try {
    await assertRejects(
      () => extractArchive(archive, "zip", dest),
      UnsafeArchiveError,
      "not a zip",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
