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

/** A release on loopback: `/api/repos/…/releases/latest` and `/dl/<tag>/<file>`. */
interface Release {
  readonly base: string;
  readonly hits: string[];
  readonly files: Map<string, Uint8Array>;
  close(): Promise<void>;
}

function serveRelease(tag: string): Release {
  const files = new Map<string, Uint8Array>();
  const hits: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    const path = new URL(req.url).pathname;
    hits.push(path);
    if (path.endsWith("/releases/latest")) return Response.json({ tag_name: tag });
    const body = files.get(path.replace(`/dl/${tag}/`, ""));
    return body ? new Response(body as BodyInit) : new Response("nope", { status: 404 });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    hits,
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
    const removed = await install(release, root, {}, ["-Uninstall"]);
    assertEquals(removed.code, 0, removed.out);
    assert(!(await exists(root)));
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

Deno.test("install.ps1 and publish.yml agree on the Windows asset and checksum names", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  const workflow = await Deno.readTextFile(WORKFLOW);
  assertStringIncludes(script, '$asset = "denext-$target.zip"');
  assertStringIncludes(script, "$target = 'x86_64-pc-windows-msvc'");
  assertStringIncludes(script, "'SHA256SUMS', \"$asset.sha256\"");
  assertStringIncludes(workflow, "target: x86_64-pc-windows-msvc");
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

Deno.test("docs: the served install.ps1 matches the one in scripts/", async () => {
  // `irm https://denext.dev/install.ps1 | iex` serves apps/web/public/install.ps1.
  assertEquals(
    await Deno.readTextFile(new URL("apps/web/public/install.ps1", ROOT)),
    await Deno.readTextFile(SCRIPT),
    "apps/web/public/install.ps1 is stale — `cp scripts/install.ps1 apps/web/public/install.ps1`",
  );
});
