// scripts/install.sh is what `curl -fsSL https://denext.dev/install.sh | sh` runs on someone's
// machine. These run the real script with a stub `curl` on PATH that serves a local release
// (an archive, its checksums, the "latest" API answer) and a stub `uname`, so every branch that
// decides whether a binary lands — good checksum, wrong checksum, no checksum, an unsupported
// platform — is exercised end to end, and nothing reaches the network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";

const ROOT = new URL("../", import.meta.url);
const SCRIPT = new URL("scripts/install.sh", ROOT).pathname;
const WORKFLOW = new URL(".github/workflows/publish.yml", ROOT).pathname;

/** The target the stub `uname` (Linux x86_64) makes the script pick. */
const TARGET = "x86_64-unknown-linux-gnu";
const ASSET = `denext-${TARGET}.tar.gz`;

/**
 * A stub `curl`: fails unless every call carries the hardening flags, logs the URL it was
 * asked for, and answers from `$STUB_DIR` by the URL's last path segment (the "latest" API
 * call is answered by `latest.json`). A file that is not there is a 404 — curl's exit 22.
 */
const CURL_STUB = `#!/bin/sh
out=""; url=""; proto=""; tls=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --proto) proto="$2"; shift ;;
    --tlsv1.2) tls=1 ;;
    http*) url="$1" ;;
  esac
  shift
done
[ "$proto" = "=https" ] && [ -n "$tls" ] || { echo "stub curl: unhardened call" >&2; exit 99; }
echo "$url" >> "$STUB_LOG"
name="\${url##*/}"
case "$url" in */releases/latest) name="latest.json" ;; esac
[ -f "$STUB_DIR/$name" ] || exit 22
if [ -n "$out" ]; then cp "$STUB_DIR/$name" "$out"; else cat "$STUB_DIR/$name"; fi
`;

/** A stub `uname` reporting `os` / `arch`. */
const unameStub = (os: string, arch: string) =>
  `#!/bin/sh\ncase "$1" in -m) echo "${arch}" ;; *) echo "${os}" ;; esac\n`;

/** What one installer run produced. */
interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** Every URL the stub curl was asked for, in order. */
  urls: string[];
  /** Where a binary would land. */
  binary: string;
}

/** A local "release" the stub curl serves, and a run of the script against it. */
class Release {
  readonly dir: string;
  readonly stubs: string;
  readonly served: string;
  readonly install: string;
  readonly log: string;

  private constructor(dir: string) {
    this.dir = dir;
    this.stubs = join(dir, "stubs");
    this.served = join(dir, "served");
    this.install = join(dir, "install");
    this.log = join(dir, "curl.log");
  }

  /** The release with `files` published (by name), plus a valid archive and its checksums. */
  static async create(
    opts: { withSums?: boolean; withPerAsset?: boolean; os?: string; arch?: string } = {},
  ): Promise<Release> {
    const r = new Release(await Deno.makeTempDir({ prefix: "denext_install_" }));
    await Deno.mkdir(r.stubs);
    await Deno.mkdir(r.served);
    await Deno.writeTextFile(join(r.stubs, "curl"), CURL_STUB, { mode: 0o755 });
    await Deno.writeTextFile(
      join(r.stubs, "uname"),
      unameStub(opts.os ?? "Linux", opts.arch ?? "x86_64"),
      { mode: 0o755 },
    );
    // The archive holds a `denext` that answers `--version` like the real binary.
    const stage = join(r.dir, "stage");
    await Deno.mkdir(stage);
    await Deno.writeTextFile(
      join(stage, "denext"),
      '#!/bin/sh\necho "denext 9.9.9 (binary)"\n',
      { mode: 0o755 },
    );
    const tar = await new Deno.Command("tar", {
      args: ["czf", join(r.served, ASSET), "-C", stage, "denext"],
    }).output();
    assert(tar.success, new TextDecoder().decode(tar.stderr));
    const digest = encodeHex(
      await crypto.subtle.digest("SHA-256", await Deno.readFile(join(r.served, ASSET))),
    );
    // Both checksum forms the workflow publishes: the combined file lists every platform.
    if (opts.withSums !== false) {
      await Deno.writeTextFile(
        join(r.served, "SHA256SUMS"),
        `${"0".repeat(64)}  denext-aarch64-apple-darwin.tar.gz\n${digest}  ${ASSET}\n` +
          `${"1".repeat(64)}  denext-x86_64-pc-windows-msvc.zip\n`,
      );
    }
    if (opts.withPerAsset !== false) {
      await Deno.writeTextFile(join(r.served, `${ASSET}.sha256`), `${digest}  ${ASSET}\n`);
    }
    // Shaped like the GitHub API's answer: one key per line (the script greps the tag line).
    await Deno.writeTextFile(
      join(r.served, "latest.json"),
      '{\n  "url": "https://api.github.com/repos/Brainwires/denext/releases/1",\n' +
        '  "tag_name": "v9.9.9",\n  "prerelease": false\n}\n',
    );
    return r;
  }

  /** Run the installer with `env` on top of a minimal environment (`deno` NOT on PATH). */
  async run(env: Record<string, string> = {}, extraPath: string[] = []): Promise<Run> {
    await Deno.writeTextFile(this.log, "");
    const out = await new Deno.Command("sh", {
      args: [SCRIPT],
      clearEnv: true,
      env: {
        PATH: [this.stubs, ...extraPath, "/usr/bin", "/bin"].join(":"),
        HOME: this.dir,
        TMPDIR: this.dir,
        STUB_DIR: this.served,
        STUB_LOG: this.log,
        DENEXT_INSTALL: this.install,
        ...env,
      },
    }).output();
    const decoder = new TextDecoder();
    return {
      code: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
      urls: (await Deno.readTextFile(this.log)).split("\n").filter(Boolean),
      binary: join(this.install, "bin", "denext"),
    };
  }

  async installed(): Promise<boolean> {
    try {
      return (await Deno.stat(join(this.install, "bin", "denext"))).isFile;
    } catch {
      return false;
    }
  }

  async remove(): Promise<void> {
    await Deno.remove(this.dir, { recursive: true });
  }
}

Deno.test("install.sh: a good checksum installs the binary", async () => {
  const r = await Release.create();
  try {
    const run = await r.run();
    assertEquals(run.code, 0, run.stderr);
    assert(await r.installed());
    assertStringIncludes(run.stdout, "checksum verified");
    assertStringIncludes(run.stdout, "installed denext 9.9.9 (binary)");
    assertEquals(run.urls, [
      "https://api.github.com/repos/Brainwires/denext/releases/latest",
      `https://github.com/Brainwires/denext/releases/download/v9.9.9/${ASSET}`,
      "https://github.com/Brainwires/denext/releases/download/v9.9.9/SHA256SUMS",
    ], "latest is resolved, the archive fetched, and the combined checksum file is enough");
    // No `deno` on this PATH: a warning, not a failure — the binary's own verbs still work.
    assertStringIncludes(run.stderr, "`deno` is not on your PATH");
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: a wrong checksum installs nothing", async () => {
  const r = await Release.create();
  try {
    const bad = `${"f".repeat(64)}  ${ASSET}\n`;
    await Deno.writeTextFile(join(r.served, "SHA256SUMS"), bad);
    await Deno.writeTextFile(join(r.served, `${ASSET}.sha256`), bad);
    const run = await r.run();
    assertEquals(run.code, 1);
    assertStringIncludes(run.stderr, "checksum verification FAILED");
    assertEquals(await r.installed(), false, "nothing is installed");
    // Even with the insecure escape hatch: it covers a MISSING checksum, never a wrong one.
    const forced = await r.run({ DENEXT_INSECURE: "1" });
    assertEquals(forced.code, 1);
    assertEquals(await r.installed(), false);
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: no checksum at all is fatal unless DENEXT_INSECURE=1", async () => {
  const r = await Release.create({ withSums: false, withPerAsset: false });
  try {
    const run = await r.run();
    assertEquals(run.code, 1);
    assertStringIncludes(run.stderr, "no checksum could be fetched");
    assertStringIncludes(run.stderr, "DENEXT_INSECURE=1");
    assertEquals(await r.installed(), false);
    assert(
      run.urls.includes(
        `https://github.com/Brainwires/denext/releases/download/v9.9.9/${ASSET}.sha256`,
      ),
      "the per-archive checksum is tried after the combined file",
    );
    const forced = await r.run({ DENEXT_INSECURE: "1" });
    assertEquals(forced.code, 0, forced.stderr);
    assertStringIncludes(forced.stderr, "WARNING");
    assertStringIncludes(forced.stderr, "UNVERIFIED");
    assert(await r.installed());
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: the per-archive .sha256 is the fallback when SHA256SUMS is missing", async () => {
  const r = await Release.create({ withSums: false });
  try {
    const run = await r.run();
    assertEquals(run.code, 0, run.stderr);
    assertStringIncludes(run.stdout, "checksum verified");
    assert(await r.installed());
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: DENEXT_VERSION picks the release and skips the latest lookup", async () => {
  const r = await Release.create();
  try {
    const run = await r.run({ DENEXT_VERSION: "v2.5.0-rc.9" });
    assertEquals(run.code, 0, run.stderr);
    assert(run.urls.every((u) => !u.includes("releases/latest")), run.urls.join("\n"));
    assertEquals(
      run.urls[0],
      `https://github.com/Brainwires/denext/releases/download/v2.5.0-rc.9/${ASSET}`,
    );
    assertStringIncludes(run.stdout, "downloading v2.5.0-rc.9");
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: an unsupported platform exits 1 with the JSR alternative", async () => {
  const r = await Release.create({ os: "FreeBSD", arch: "amd64" });
  try {
    const run = await r.run();
    assertEquals(run.code, 1);
    assertStringIncludes(run.stderr, "no prebuilt binary for FreeBSD-amd64");
    assertStringIncludes(run.stderr, "deno install -A -g -n denext jsr:@denext/denext/cli");
    assertEquals(run.urls, [], "nothing is fetched");
    assertEquals(await r.installed(), false);
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: with deno on PATH there is no warning", async () => {
  const r = await Release.create();
  try {
    const withDeno = join(r.dir, "with-deno");
    await Deno.mkdir(withDeno);
    await Deno.writeTextFile(join(withDeno, "deno"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const run = await r.run({}, [withDeno]);
    assertEquals(run.code, 0, run.stderr);
    assert(!run.stderr.includes("not on your PATH"), run.stderr);
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh: a truncated download runs nothing", async () => {
  // `curl … | sh` executes what arrived; everything is inside main(), called on the last line,
  // so a script cut short anywhere before that line does nothing at all.
  const r = await Release.create();
  try {
    const source = await Deno.readTextFile(SCRIPT);
    assert(source.trimEnd().endsWith('\nmain "$@"'), "main is invoked on the last line");
    const cut = source.slice(0, source.lastIndexOf("\nmain "));
    const truncated = join(r.dir, "truncated.sh");
    await Deno.writeTextFile(truncated, cut);
    const out = await new Deno.Command("sh", {
      args: [truncated],
      clearEnv: true,
      env: { PATH: `${r.stubs}:/usr/bin:/bin`, HOME: r.dir, STUB_DIR: r.served, STUB_LOG: r.log },
    }).output();
    assertEquals(out.code, 0);
    assertEquals(new TextDecoder().decode(out.stdout), "");
    assertEquals(await r.installed(), false);
  } finally {
    await r.remove();
  }
});

Deno.test("install.sh and publish.yml agree on the asset names", async () => {
  // The installer fetches names the workflow's Package + release steps produce; a rename on
  // either side would only surface as a failed install after a release went out.
  const script = await Deno.readTextFile(SCRIPT);
  const workflow = await Deno.readTextFile(WORKFLOW);
  assertStringIncludes(script, 'ASSET="denext-$TARGET.tar.gz"');
  assertStringIncludes(script, '"$base/$ASSET.sha256"');
  assertStringIncludes(script, '"$base/SHA256SUMS"');
  assertStringIncludes(workflow, 'name="denext-${{ matrix.target }}"');
  assertStringIncludes(workflow, 'archive="$name.tar.gz"');
  assertStringIncludes(workflow, '"$archive.sha256"');
  assertStringIncludes(workflow, "> SHA256SUMS");
  // Every curl the installer makes is the hardened one.
  const curls = script.split("\n").filter((l) => /^\s*curl\b/.test(l));
  assertEquals(curls.length, 1, "curl is only ever called through fetch()");
  assertStringIncludes(curls[0], "--proto '=https' --tlsv1.2");
});

Deno.test("publish.yml: one release job, prereleases never latest, every action pinned", async () => {
  const workflow = await Deno.readTextFile(WORKFLOW);
  // ONE call creates the release, after every leg, and an rc tag is a prerelease.
  assertEquals(workflow.match(/softprops\/action-gh-release/g)?.length, 1);
  assertStringIncludes(workflow, "prerelease: ${{ contains(github.ref_name, '-') }}");
  assertStringIncludes(workflow, "make_latest: ${{ !contains(github.ref_name, '-') }}");
  assertStringIncludes(workflow, "needs: binaries");
  assertStringIncludes(workflow, "fail_on_unmatched_files: true");
  // Every third-party action is a full commit SHA with the version it is beside it.
  const uses = workflow.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
  assert(uses.length >= 8, `found ${uses.length} uses:`);
  for (const line of uses) {
    assert(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(line.trim()), line);
  }
  // The binary is executed, not merely linked, before it ships.
  assertStringIncludes(workflow, "./denext --version");
  assertStringIncludes(workflow, "pins no denext");
});
