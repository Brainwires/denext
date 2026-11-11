// scripts/ci/apt-install.sh, the package install every Linux CI job uses, against stand-in
// dpkg-query / dpkg / apt-get / sudo / timeout / sleep commands: nothing is fetched when every
// package is installed, apt runs with retries and timeouts, a failed try is repeated, the third
// try moves the Ubuntu sources to a fallback mirror, and the workflows never call apt-get to
// fetch packages themselves.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const SCRIPT = fromFileUrl(new URL("../scripts/ci/apt-install.sh", import.meta.url));
const WORKFLOWS = fromFileUrl(new URL("../.github/workflows/", import.meta.url));

const STUBS: Record<string, string> = {
  // Installed packages are listed in $INSTALLED (space separated).
  "dpkg-query": `#!/usr/bin/env bash
pkg="\${@: -1}"
for p in $INSTALLED; do [ "$p" = "$pkg" ] && { printf installed; exit 0; }; done
exit 1
`,
  "dpkg": "#!/usr/bin/env bash\necho amd64\n",
  // Logs every call; \`update\` fails while the counter file $FAIL_UPDATES is above 0.
  "apt-get": `#!/usr/bin/env bash
echo "apt-get $*" >>"$LOG"
for a in "$@"; do
  if [ "$a" = update ]; then
    n=$(cat "$FAIL_UPDATES")
    if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$FAIL_UPDATES"; exit 100; fi
  fi
done
exit 0
`,
  "sudo": '#!/usr/bin/env bash\n"$@"\n',
  "timeout": '#!/usr/bin/env bash\necho "timeout $1" >>"$LOG"\nshift\n"$@"\n',
  "sleep": "#!/usr/bin/env bash\nexit 0\n",
};

const SOURCES = "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\n" +
  "Suites: noble noble-updates\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\n" +
  "Suites: noble-security\n";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  calls: string[];
  sources: string;
  dropIn: string | null;
}

async function run(
  args: string[],
  opts: { installed?: string; failUpdates?: number; tries?: number } = {},
): Promise<Run> {
  const tmp = await Deno.makeTempDir({ prefix: "apt-install-test-" });
  try {
    const bin = join(tmp, "bin");
    await Deno.mkdir(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      await Deno.writeTextFile(join(bin, name), body, { mode: 0o755 });
    }
    const etc = join(tmp, "etc");
    await Deno.mkdir(join(etc, "sources.list.d"), { recursive: true });
    const sources = join(etc, "sources.list.d", "ubuntu.sources");
    await Deno.writeTextFile(sources, SOURCES);
    const log = join(tmp, "log");
    await Deno.writeTextFile(log, "");
    const counter = join(tmp, "fail");
    await Deno.writeTextFile(counter, String(opts.failUpdates ?? 0));
    const env: Record<string, string> = {
      PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
      INSTALLED: opts.installed ?? "",
      LOG: log,
      FAIL_UPDATES: counter,
      APT_ETC: etc,
      APT_INSTALL_DELAY: "1",
    };
    if (opts.tries) env.APT_INSTALL_TRIES = String(opts.tries);
    const out = await new Deno.Command("bash", { args: [SCRIPT, ...args], env, clearEnv: true })
      .output();
    let dropIn: string | null = null;
    try {
      dropIn = await Deno.readTextFile(join(etc, "apt.conf.d", "80-denext-ci-retries"));
    } catch { /* not written */ }
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      calls: (await Deno.readTextFile(log)).split("\n").filter(Boolean),
      sources: await Deno.readTextFile(sources),
      dropIn,
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

const updates = (calls: string[]) => calls.filter((c) => c.endsWith("update -q")).length;

Deno.test("apt-install.sh: every package installed fetches nothing", async () => {
  const r = await run(["cmake", "xvfb"], { installed: "cmake xvfb" });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(r.calls, []);
  assertStringIncludes(r.stdout, "nothing to fetch");
});

Deno.test("apt-install.sh: installs only what is missing, with retries and timeouts", async () => {
  const r = await run(["cmake", "xvfb"], { installed: "cmake" });
  assertEquals(r.code, 0, r.stderr);
  const install = r.calls.filter((c) => / install -y /.test(c));
  assertEquals(install.length, 1, r.calls.join("\n"));
  assert(install[0].endsWith("install -y --no-install-recommends xvfb"), install[0]);
  assertStringIncludes(install[0], "-o Acquire::Retries=5");
  assertStringIncludes(install[0], "-o Acquire::http::Timeout=30");
  assert(r.calls.includes("timeout 600") && r.calls.includes("timeout 1200"), r.calls.join("\n"));
  assertStringIncludes(r.dropIn ?? "", 'Acquire::Retries "5";');
  assertStringIncludes(r.sources, "azure.archive.ubuntu.com");
});

Deno.test("apt-install.sh: a local .deb is always installed", async () => {
  const r = await run(["./dist/app.deb", "weston"], { installed: "weston" });
  assertEquals(r.code, 0, r.stderr);
  assert(
    r.calls.some((c) => c.endsWith("install -y --no-install-recommends ./dist/app.deb")),
    r.calls.join("\n"),
  );
});

Deno.test("apt-install.sh: --with-recommends", async () => {
  const r = await run(["--with-recommends", "cmake"]);
  assertEquals(r.code, 0, r.stderr);
  assert(r.calls.some((c) => c.endsWith("install -y cmake")), r.calls.join("\n"));
});

Deno.test("apt-install.sh: --configure writes the drop-in and fetches nothing", async () => {
  const r = await run(["--configure"]);
  assertEquals(r.code, 0, r.stderr);
  assertEquals(r.calls, []);
  assertStringIncludes(r.dropIn ?? "", 'Acquire::https::Timeout "30";');
});

Deno.test("apt-install.sh: a failed update is retried on the image's mirror", async () => {
  const r = await run(["cmake"], { failUpdates: 1 });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(updates(r.calls), 2);
  assertStringIncludes(r.stdout, "try 1 of 4 failed");
  assertStringIncludes(r.sources, "azure.archive.ubuntu.com");
});

Deno.test("apt-install.sh: the third try uses the fallback mirror, the fourth the next", async () => {
  const third = await run(["cmake"], { failUpdates: 2 });
  assertEquals(third.code, 0, third.stderr);
  assertStringIncludes(third.stdout, "apt sources now use http://archive.ubuntu.com/ubuntu");
  assert(!third.sources.includes("azure.") && !third.sources.includes("security.ubuntu.com"));
  assertStringIncludes(third.sources, "URIs: http://archive.ubuntu.com/ubuntu/\n");
  const fourth = await run(["cmake"], { failUpdates: 3 });
  assertEquals(fourth.code, 0, fourth.stderr);
  assertStringIncludes(fourth.sources, "URIs: http://mirrors.edge.kernel.org/ubuntu/\n");
});

Deno.test("apt-install.sh: gives up after the last try", async () => {
  const r = await run(["cmake"], { failUpdates: 9, tries: 3 });
  assertEquals(r.code, 1);
  assertEquals(updates(r.calls), 3);
  assertStringIncludes(r.stderr, "could not install cmake after 3 tries");
});

Deno.test("workflows: no step fetches packages with a bare apt-get", async () => {
  const bare: string[] = [];
  for (const entry of Deno.readDirSync(WORKFLOWS)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    const lines = (await Deno.readTextFile(join(WORKFLOWS, entry.name))).split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/#.*$/, "");
      // `apt-get update` / `apt-get install` outside apt-install.sh. Inside a `docker run` of a
      // clean distro the install has its own retry loop (apt_retry), which this allows.
      if (/\bapt-get\s+(?:-\S+\s+)*(?:update|install)\b/.test(code) && !/apt_retry/.test(code)) {
        bare.push(`${entry.name}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assertEquals(bare, [], "use scripts/ci/apt-install.sh (retries, timeouts, a fallback mirror)");
});
