// scripts/install.ps1 is what `irm https://denext.dev/install.ps1 | iex` runs on a Windows
// machine. On Windows these run the real script against a release served on loopback (an archive,
// its checksums, the "latest" API answer), so every branch that decides whether a binary lands —
// good checksum, wrong checksum, no checksum, uninstall — is exercised end to end, and nothing
// reaches the network. DENEXT_NO_PATH=1 keeps the runner's user Path untouched. The asset-name
// and served-copy checks run everywhere.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { fromFileUrl, join } from "@std/path";

const ROOT = new URL("../", import.meta.url);
const SCRIPT = fromFileUrl(new URL("scripts/install.ps1", ROOT));
const WORKFLOW = fromFileUrl(new URL(".github/workflows/publish.yml", ROOT));
const NOT_WINDOWS = Deno.build.os !== "windows";
const ASSET = "denext-x86_64-pc-windows-msvc.zip";
const ARM_ASSET = "denext-aarch64-pc-windows-msvc.zip";

/** A release on loopback: `/api/repos/…/releases/latest` and `/dl/<tag>/<file>`. */
interface Release {
  readonly base: string;
  readonly hits: string[];
  /** `<path> <Authorization header>` for every request that carried one. */
  readonly auth: string[];
  readonly files: Map<string, Uint8Array>;
  close(): Promise<void>;
}

function serveRelease(tag: string, opts: { rateLimited?: boolean } = {}): Release {
  const files = new Map<string, Uint8Array>();
  const hits: string[] = [];
  const auth: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    const path = new URL(req.url).pathname;
    hits.push(path);
    const authorization = req.headers.get("authorization");
    if (authorization) auth.push(`${path} ${authorization}`);
    if (path.startsWith("/api/") && path.endsWith("/releases/latest")) {
      return opts.rateLimited
        ? Response.json({ message: "API rate limit exceeded" }, { status: 403 })
        : Response.json({ tag_name: tag });
    }
    // The web page's redirect to the latest release's tag page.
    if (path === "/web/Brainwires/denext/releases/latest") {
      return new Response(null, {
        status: 302,
        headers: { location: `/web/Brainwires/denext/releases/tag/${tag}` },
      });
    }
    if (path.startsWith("/web/Brainwires/denext/releases/tag/")) {
      return new Response("<html>release</html>", { headers: { "content-type": "text/html" } });
    }
    const body = files.get(path.replace(`/dl/${tag}/`, ""));
    return body ? new Response(body as BodyInit) : new Response("nope", { status: 404 });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    hits,
    auth,
    files,
    close: () => server.shutdown(),
  };
}

/** A zip holding `denext.exe` (a small system executable stands in for the real binary). */
async function releaseZip(dir: string): Promise<Uint8Array> {
  const stage = join(dir, "stage");
  await Deno.mkdir(stage, { recursive: true });
  const sys = Deno.env.get("SystemRoot") ?? "C:\\Windows";
  await Deno.copyFile(join(sys, "System32", "whoami.exe"), join(stage, "denext.exe"));
  return await zipStage(dir, stage);
}

/** Zip `stage/denext.exe` as the release asset in `dir`; returns its bytes. */
async function zipStage(dir: string, stage: string): Promise<Uint8Array> {
  const sys = Deno.env.get("SystemRoot") ?? "C:\\Windows";
  const zip = join(dir, ASSET);
  // System32's bsdtar writes a zip from `-a`; a CI step run under Git Bash puts GNU tar (which
  // cannot) first on PATH, so name it by path.
  const tar = await new Deno.Command(join(sys, "System32", "tar.exe"), {
    args: ["-a", "-c", "-f", zip, "-C", stage, "denext.exe"],
  }).output();
  assert(tar.success, "tar -a writes the zip");
  return await Deno.readFile(zip);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Whether PowerShell 7 (`pwsh`) is on PATH; Windows PowerShell 5.1 (`powershell`) always is. */
async function hasPwsh(): Promise<boolean> {
  try {
    return (await new Deno.Command("pwsh", { args: ["-v"] }).output()).success;
  } catch {
    return false; // a missing binary throws instead of resolving
  }
}

/** Run the installer; returns its exit code and output. */
async function install(
  release: Release,
  root: string,
  env: Record<string, string> = {},
  args: string[] = [],
): Promise<{ code: number; out: string }> {
  const shell = await hasPwsh() ? "pwsh" : "powershell";
  const r = await new Deno.Command(shell, {
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
    env: {
      DENEXT_DOWNLOAD_BASE: `${release.base}/dl`,
      DENEXT_API_BASE: `${release.base}/api`,
      DENEXT_WEB_BASE: `${release.base}/web`,
      DENEXT_INSTALL: root,
      DENEXT_NO_PATH: "1",
      ...env,
    },
  }).output();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

Deno.test("install.ps1: a good checksum installs the binary; -Uninstall removes it", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    const root = join(dir, "home");
    const { code, out } = await install(release, root);
    assertEquals(code, 0, out);
    assertStringIncludes(out, "checksum verified");
    assert(await exists(join(root, "bin", "denext.exe")));
    assert(release.hits.some((h) => h.endsWith("/releases/latest")), "resolved latest");
    assert(
      await exists(join(root, ".denext-install-manifest")),
      "the manifest names what it wrote",
    );
    const removed = await install(release, root, {}, ["-Uninstall"]);
    assertEquals(removed.code, 0, removed.out);
    assert(!(await exists(root)));
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: -Uninstall waits out a transient lock on denext.exe", {
  ignore: NOT_WINDOWS,
}, async () => {
  // Uninstall runs denext.exe (`toolchain unlink`) and deletes it a moment later; Windows can
  // still hold the file then (a GitHub runner did: "being used by another process"). Here the
  // hold is the stand-in itself, still running when the uninstall starts.
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  let held: Promise<Deno.CommandStatus> | undefined;
  try {
    // A 4.x stand-in that answers `toolchain` at once, and `hold <ms>` by running that long.
    const zip = await stubZip(
      dir,
      `if (Deno.args[0] === "--version") console.log("denext 9.9.9 (binary)");
else if (Deno.args[0] === "hold") await new Promise((r) => setTimeout(r, Number(Deno.args[1])));
`,
    );
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    const root = join(dir, "home");
    assertEquals((await install(release, root, { DENEXT_NO_TOOLCHAIN: "1" })).code, 0);
    // While it runs, Windows refuses to delete its image - as it can for a moment after a run.
    held = new Deno.Command(join(root, "bin", "denext.exe"), { args: ["hold", "3000"] })
      .spawn().status;
    const removed = await install(release, root, {}, ["-Uninstall"]);
    assertEquals(removed.code, 0, removed.out);
    assert(!(await exists(root)), "nothing left behind once the lock is released");
    assert((await held).success, "the stand-in ran (holding its image) and exited");
  } finally {
    await held; // the temp dir can only go once the stand-in has exited
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: Windows on Arm installs the Arm64 binary", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set(ARM_ASSET, zip);
    release.files.set(
      "SHA256SUMS",
      new TextEncoder().encode(
        `${await sha256(zip)}  ${ASSET}\n${await sha256(zip)}  ${ARM_ASSET}\n`,
      ),
    );
    const root = join(dir, "home");
    const run = await install(release, root, { PROCESSOR_ARCHITECTURE: "ARM64" });
    assertEquals(run.code, 0, run.out);
    assertStringIncludes(run.out, "for aarch64-pc-windows-msvc");
    assert(release.hits.includes(`/dl/v9.9.9/${ARM_ASSET}`), release.hits.join());
    assert(!release.hits.includes(`/dl/v9.9.9/${ASSET}`), "never fetches the x64 build");
    assert(await exists(join(root, "bin", "denext.exe")));
    // The stand-in binary's `toolchain install` fails, as a release pinning a toolchain older than
    // 2.9.7-denext.21 does on Windows on Arm (no toolchain build): a note naming the deno it runs
    // instead, not a failure warning.
    assertStringIncludes(run.out, "no Windows on Arm Deno toolchain could be installed");
    assert(!run.out.includes("could not be installed now"), run.out);
    // An x64 machine still gets the x64 build from the same release.
    const x64 = await install(release, join(dir, "x64"), { PROCESSOR_ARCHITECTURE: "AMD64" });
    assertEquals(x64.code, 0, x64.out);
    assertStringIncludes(x64.out, "for x86_64-pc-windows-msvc");
    assertStringIncludes(x64.out, "could not be installed now");
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: a release without an Arm64 build installs x64 on Windows on Arm", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v4.1.0");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    const root = join(dir, "home");
    const run = await install(release, root, { PROCESSOR_ARCHITECTURE: "ARM64" });
    assertEquals(run.code, 0, run.out);
    assertStringIncludes(run.out, "v4.1.0 has no aarch64-pc-windows-msvc build");
    assert(release.hits.includes(`/dl/v4.1.0/${ASSET}`), release.hits.join());
    assertStringIncludes(run.out, "checksum verified");
    assert(await exists(join(root, "bin", "denext.exe")));
    // The same from a local build directory (DENEXT_ARTIFACTS).
    const art = join(dir, "art");
    await Deno.mkdir(art);
    await Deno.writeFile(join(art, ASSET), zip);
    await Deno.writeTextFile(join(art, "SHA256SUMS"), `${await sha256(zip)}  ${ASSET}\n`);
    const local = await install(release, join(dir, "local"), {
      PROCESSOR_ARCHITECTURE: "ARM64",
      DENEXT_ARTIFACTS: art,
    });
    assertEquals(local.code, 0, local.out);
    assertStringIncludes(local.out, `installing ${ASSET} from`);
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: a wrong checksum installs nothing", { ignore: NOT_WINDOWS }, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    release.files.set(ASSET, await releaseZip(dir));
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${"0".repeat(64)}  ${ASSET}\n`));
    const root = join(dir, "home");
    const { code, out } = await install(release, root, { DENEXT_VERSION: "v9.9.9" });
    assert(code !== 0, out);
    assertStringIncludes(out, "checksum verification FAILED");
    assert(!(await exists(join(root, "bin", "denext.exe"))));
    assert(!release.hits.some((h) => h.endsWith("/releases/latest")), "DENEXT_VERSION skips it");
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: no checksum is fatal unless DENEXT_INSECURE=1; .sha256 is the fallback", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    const root = join(dir, "home");
    const refused = await install(release, root);
    assert(refused.code !== 0, refused.out);
    assertStringIncludes(refused.out, "no checksum could be fetched");
    assert(!(await exists(join(root, "bin", "denext.exe"))));
    const insecure = await install(release, root, { DENEXT_INSECURE: "1" });
    assertEquals(insecure.code, 0, insecure.out);
    assertStringIncludes(insecure.out, "UNVERIFIED");
    await Deno.remove(root, { recursive: true });
    release.files.set(
      `${ASSET}.sha256`,
      new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`),
    );
    const fallback = await install(release, root);
    assertEquals(fallback.code, 0, fallback.out);
    assertStringIncludes(fallback.out, "checksum verified");
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: a non-https download base is refused (loopback http only)", {
  ignore: NOT_WINDOWS,
}, async () => {
  const release = serveRelease("v9.9.9");
  const dir = await Deno.makeTempDir();
  try {
    const { code, out } = await install(release, join(dir, "home"), {
      DENEXT_DOWNLOAD_BASE: "http://example.com/dl",
    });
    assert(code !== 0, out);
    assertStringIncludes(out, "refusing a non-https download URL");
    assertEquals(release.hits, []);
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: a GITHUB_TOKEN goes to the API lookup only, never shown", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    const { code, out } = await install(release, join(dir, "home"), {
      GITHUB_TOKEN: "ghs_secret123",
    });
    assertEquals(code, 0, out);
    assertEquals(release.auth, [
      "/api/repos/Brainwires/denext/releases/latest Bearer ghs_secret123",
    ]);
    assert(!out.includes("ghs_secret123"), out);
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: a rate-limited API falls back to the releases/latest redirect", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9", { rateLimited: true });
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    const { code, out } = await install(release, join(dir, "home"));
    assertEquals(code, 0, out);
    assert(release.hits.includes("/web/Brainwires/denext/releases/latest"), release.hits.join());
    assert(release.hits.includes(`/dl/v9.9.9/${ASSET}`), release.hits.join());
    assert(await exists(join(dir, "home", "bin", "denext.exe")));
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: the toolchain step never fails the install; DENEXT_NO_TOOLCHAIN skips it", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    // The stand-in binary cannot run `toolchain install`: one warning, and the install stands.
    const root = join(dir, "home");
    const run = await install(release, root);
    assertEquals(run.code, 0, run.out);
    assertStringIncludes(run.out, "installing denext's Deno toolchain");
    assertStringIncludes(run.out, "could not be installed now");
    assert(await exists(join(root, "bin", "denext.exe")));
    const skipped = await install(release, join(dir, "other"), { DENEXT_NO_TOOLCHAIN: "1" });
    assertEquals(skipped.code, 0, skipped.out);
    assert(!skipped.out.includes("Deno toolchain"), skipped.out);
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install.ps1: DENEXT_ARTIFACTS installs a local build, still checksum-verified", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const art = join(dir, "art");
    await Deno.mkdir(art);
    const zip = await releaseZip(art);
    await Deno.writeTextFile(join(art, "SHA256SUMS"), `${await sha256(zip)}  ${ASSET}\n`);
    const root = join(dir, "home");
    const run = await install(release, root, { DENEXT_ARTIFACTS: art, DENEXT_NO_TOOLCHAIN: "1" });
    assertEquals(run.code, 0, run.out);
    assertStringIncludes(run.out, "checksum verified");
    assertEquals(release.hits, [], "nothing is fetched");
    assert(await exists(join(root, "bin", "denext.exe")));
    await Deno.writeTextFile(join(art, "SHA256SUMS"), `${"0".repeat(64)}  ${ASSET}\n`);
    const bad = await install(release, join(dir, "bad"), { DENEXT_ARTIFACTS: art });
    assert(bad.code !== 0, bad.out);
    assertStringIncludes(bad.out, "checksum verification FAILED");
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

/** A zip holding `denext.exe` compiled from the Deno `source` (a stand-in with chosen answers). */
async function stubZip(dir: string, source: string): Promise<Uint8Array> {
  const stage = join(dir, "stage");
  await Deno.mkdir(stage, { recursive: true });
  const src = join(dir, "stub.ts");
  await Deno.writeTextFile(src, source);
  const compiled = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--quiet",
      "--no-check",
      "--allow-env",
      "--allow-write",
      "--output",
      join(stage, "denext.exe"),
      src,
    ],
  }).output();
  assert(compiled.success, new TextDecoder().decode(compiled.stderr));
  return await zipStage(dir, stage);
}

/**
 * A zip holding a compiled `denext.exe` stand-in that answers `--version` as `denext <version>
 * (binary)` and, like a release before 4.0, refuses every other verb as `unknown command` after
 * logging it to $STUB_LOG.
 */
async function preToolchainZip(dir: string, version: string): Promise<Uint8Array> {
  return await stubZip(
    dir,
    `if (Deno.args[0] === "--version") console.log("denext ${version} (binary)");
else {
  const log = Deno.env.get("STUB_LOG");
  if (log) Deno.writeTextFileSync(log, Deno.args.join(" ") + "\\n", { append: true });
  console.error(\`denext: unknown command "\${Deno.args[0]}"\`);
  Deno.exit(1);
}
`,
  );
}

Deno.test(
  "install.ps1: a release before 4.0 (no `toolchain` verb) installs and uninstalls cleanly",
  {
    ignore: NOT_WINDOWS,
  },
  async () => {
    const dir = await Deno.makeTempDir();
    const release = serveRelease("v3.4.14");
    try {
      const zip = await preToolchainZip(dir, "3.4.14");
      release.files.set(ASSET, zip);
      release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
      const root = join(dir, "home");
      const log = join(dir, "calls.log");
      const run = await install(release, root, { STUB_LOG: log });
      assertEquals(run.code, 0, run.out);
      assertStringIncludes(run.out, "denext 3.4.14 (binary) predates denext's Deno toolchain");
      assert(!run.out.includes("could not be installed"), run.out);
      const removed = await install(release, root, { STUB_LOG: log }, ["-Uninstall"]);
      assertEquals(removed.code, 0, removed.out);
      assert(!removed.out.includes("unknown command"), removed.out);
      assert(!(await exists(root)));
      assert(!(await exists(log)), "never asks a 3.x binary for `toolchain`");
    } finally {
      await release.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("install.ps1 and publish.yml agree on the Windows asset and checksum names", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  const workflow = await Deno.readTextFile(WORKFLOW);
  assertStringIncludes(script, '$asset = "denext-$target.zip"');
  // The native Arm64 build first on Windows on Arm, the x64 one as its fallback.
  assertStringIncludes(
    script,
    "'ARM64' { @('aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc') }",
  );
  assertStringIncludes(script, "'AMD64' { @('x86_64-pc-windows-msvc') }");
  assertStringIncludes(script, "'SHA256SUMS', \"$asset.sha256\"");
  assertStringIncludes(workflow, "target: x86_64-pc-windows-msvc");
  assertStringIncludes(workflow, "target: aarch64-pc-windows-msvc");
  assertStringIncludes(workflow, 'archive="$name.zip"; zip "dist/$archive" denext.exe');
  assertStringIncludes(workflow, "> SHA256SUMS");
  // The release attaches the package-manager manifests generated from the same SHA256SUMS.
  assertStringIncludes(workflow, "scripts/gen-package-manifests.ts");
  // Windows PowerShell 5.1 reads a BOM-less script as the ANSI code page, where the UTF-8 bytes
  // of a typographic dash include a quote character: keep the script pure ASCII.
  const nonAscii = [...script].filter((c) => c.charCodeAt(0) > 0x7e);
  assertEquals(nonAscii, [], "install.ps1 must be pure ASCII");
  // HTTPS by default; the test override is loopback-only.
  assertStringIncludes(script, '"https://github.com/$repo/releases/download"');
  assertStringIncludes(script, "$uri.IsLoopback");
});

Deno.test("install.ps1: -Uninstall removes only what it installed, never a shared root", {
  ignore: NOT_WINDOWS,
}, async () => {
  const dir = await Deno.makeTempDir();
  const release = serveRelease("v9.9.9");
  try {
    const zip = await releaseZip(dir);
    release.files.set(ASSET, zip);
    release.files.set("SHA256SUMS", new TextEncoder().encode(`${await sha256(zip)}  ${ASSET}\n`));
    // DENEXT_INSTALL pointed at a directory that holds other things.
    const root = join(dir, "shared");
    await Deno.mkdir(join(root, "bin"), { recursive: true });
    await Deno.writeTextFile(join(root, "notes.txt"), "keep me");
    await Deno.writeTextFile(join(root, "bin", "other.exe"), "keep me");
    assertEquals((await install(release, root)).code, 0);
    // A manifest edited to name another file is not obeyed.
    await Deno.writeTextFile(
      join(root, ".denext-install-manifest"),
      "bin\\denext.exe\r\nnotes.txt\r\n",
    );
    const removed = await install(release, root, {}, ["-Uninstall"]);
    assertEquals(removed.code, 0, removed.out);
    assert(!(await exists(join(root, "bin", "denext.exe"))));
    assertEquals(await Deno.readTextFile(join(root, "notes.txt")), "keep me");
    assertEquals(await Deno.readTextFile(join(root, "bin", "other.exe")), "keep me");
    // A drive root or the home directory is refused before anything is touched.
    for (const shared of ["C:\\", Deno.env.get("USERPROFILE") ?? "C:\\Users"]) {
      const r = await install(release, shared, {}, ["-Uninstall"]);
      assert(r.code !== 0, shared);
      assertStringIncludes(r.out, "refusing to uninstall");
    }
  } finally {
    await release.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docs: the served install.ps1 matches the one in scripts/", async () => {
  // `irm https://denext.dev/install.ps1 | iex` serves site/public/install.ps1.
  assertEquals(
    await Deno.readTextFile(new URL("site/public/install.ps1", ROOT)),
    await Deno.readTextFile(SCRIPT),
    "site/public/install.ps1 is stale — `cp scripts/install.ps1 site/public/install.ps1`",
  );
});
