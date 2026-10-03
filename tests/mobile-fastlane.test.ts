// `denext mobile add fastlane` (src/build/mobile-fastlane.ts + fastlane-templates.ts): the files it
// writes (Appfile from capacitor.config, lanes per platform over `denext mobile build`, Matchfile,
// Gemfile, .gitignore, the --ci workflow), idempotency / --force / --dry-run through
// `mobile add`, and what `denext mobile doctor --release` reports about a fastlane/ folder.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  formatCapabilityTable,
} from "../src/build/mobile-capabilities.ts";
import { addFastlaneToProject, fastlaneFindings } from "../src/build/mobile-fastlane.ts";
import {
  appfileTemplate,
  fastfileTemplate,
  FASTLANE_VERSION,
  rubyString,
  workflowTemplate,
} from "../src/build/fastlane-templates.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";

/** A Capacitor 8 project with `files` added (a null value leaves a default file out). */
async function project(files: Record<string, string | null> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_fastlane_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts":
      "export default { appId: 'com.example.notes', appName: 'Notes', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "ios/App/App/Info.plist": "<plist><dict></dict></plist>\n",
    "android/app/build.gradle": "android {}\n",
    // The repository root (bounds the workflow's repository lookup to this folder).
    ".git/HEAD": "ref: refs/heads/main\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await project(files);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));
const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);
/** A runner that fails the test if anything runs (fastlane installs nothing, syncs nothing). */
const noRun: CommandRunner = (command) => {
  throw new Error(`unexpected command: ${command.cmd} ${command.args.join(" ")}`);
};

const FILES = [
  "fastlane/Appfile",
  "fastlane/Fastfile",
  "fastlane/Matchfile",
  "fastlane/.gitignore",
  "Gemfile",
];

Deno.test("add fastlane: the files, marked, with the Appfile and Matchfile from capacitor.config", async () => {
  await inProject({}, async (dir) => {
    const report = await addFastlaneToProject({ dir });
    assertEquals(report.written, FILES);
    for (const file of FILES) {
      assert(
        (await read(dir, file)).startsWith("# denext-fastlane-template: 1 sha256="),
        `${file} carries the marker`,
      );
    }
    const appfile = await read(dir, "fastlane/Appfile");
    assertStringIncludes(appfile, 'app_identifier("com.example.notes")');
    assertStringIncludes(appfile, 'package_name("com.example.notes")');
    // Credentials are environment lookups, never values.
    assertStringIncludes(appfile, 'env.call("DENEXT_IOS_TEAM")');
    assertStringIncludes(appfile, 'env.call("SUPPLY_JSON_KEY")');
    assertStringIncludes(
      await read(dir, "fastlane/Matchfile"),
      'app_identifier(["com.example.notes"])',
    );
    assertStringIncludes(await read(dir, "fastlane/Matchfile"), 'type("appstore")');
    assertStringIncludes(await read(dir, "Gemfile"), `gem "fastlane", "~> ${FASTLANE_VERSION}"`);
    assertStringIncludes(await read(dir, "Gemfile"), "Pluginfile");
    const ignore = await read(dir, "fastlane/.gitignore");
    for (const line of ["report.xml", "README.md", "*.p8", "*.jks", "*.json", ".env"]) {
      assertStringIncludes(ignore, `\n${line}\n`);
    }
    // No workflow without --ci; Gemfile.lock and match are left to do.
    assert(!(await exists(join(dir, ".github"))));
    assert(report.manual.some((m) => m.includes("bundle install")));
    assert(report.manual.some((m) => m.includes("fastlane match appstore")));
  });
});

Deno.test("add fastlane: the Fastfile's lanes build with `denext mobile build` and pass flavor / versions through", () => {
  const fastfile = fastfileTemplate();
  for (const platform of ["ios", "android"]) {
    assertStringIncludes(fastfile, `platform :${platform} do`);
  }
  // Three lanes per platform.
  assertEquals(fastfile.match(/^\s+lane :build do/gm)?.length, 2);
  assertEquals(fastfile.match(/^\s+lane :beta do/gm)?.length, 2);
  assertEquals(fastfile.match(/^\s+lane :release do/gm)?.length, 2);
  // denext's pipeline, its artifact record, never gym / gradle.
  assertStringIncludes(fastfile, '["mobile", "build", platform.to_s, "--release", "--dir"');
  assertStringIncludes(fastfile, '"--json"');
  assert(!/^\s*(gym|build_app|gradle)\b/m.test(fastfile));
  for (
    const [option, flag] of [
      ["flavor", "--flavor"],
      ["build_number", "--build-number"],
      ["version_name", "--version-name"],
      ["bump", "--bump"],
      ["skip_export", "--skip-export"],
      ["export_options", "--export-options"],
      ["apk", "--apk"],
    ]
  ) {
    assertStringIncludes(fastfile, `options[:${option}]`);
    assertStringIncludes(fastfile, `"${flag}"`);
  }
  // The store steps, with the app id the build carries (a flavor's own).
  assertStringIncludes(fastfile, "upload_to_testflight(");
  assertStringIncludes(fastfile, "upload_to_app_store(");
  assertStringIncludes(fastfile, "upload_to_play_store(");
  assertStringIncludes(fastfile, 'app_identifier: artifact["appId"]');
  assertStringIncludes(fastfile, 'package_name: artifact["appId"]');
  assertStringIncludes(fastfile, '(options[:track] || "internal")');
  assertStringIncludes(fastfile, '(options[:track] || "production")');
  // match, read-only; the CI keychain; the store's next build number.
  assertStringIncludes(fastfile, "readonly: true");
  assertStringIncludes(fastfile, "setup_ci if");
  assertStringIncludes(fastfile, "latest_testflight_build_number(");
  assertStringIncludes(fastfile, "google_play_track_version_codes(");
  // An unset CI secret is an empty string: every lookup goes through env_value.
  assert(!/ENV\["(MATCH_GIT_URL|SUPPLY_JSON_KEY|DENEXT_IOS_TEAM)"\]/.test(fastfile));
});

Deno.test("add fastlane: Ruby string escaping and a missing appId", async () => {
  assertEquals(rubyString('a"b\\c#{x}'), '"a\\"b\\\\c\\#{x}"');
  // The short interpolation forms are escaped too; a plain `#` is left alone.
  assertEquals(rubyString("a#@b#@@c#$d#e"), '"a\\#@b\\#@@c\\#$d#e"');
  assertStringIncludes(
    appfileTemplate('evil"); system("x'),
    'app_identifier("evil\\"); system(\\"x")',
  );
  await inProject({ "capacitor.config.ts": "export default { webDir: 'out' };\n" }, async (dir) => {
    const report = await addFastlaneToProject({ dir });
    assertStringIncludes(await read(dir, "fastlane/Appfile"), 'app_identifier("com.example.app")');
    assert(report.manual.some((m) => m.includes("capacitor.config has no appId")));
  });
});

Deno.test("add fastlane: idempotent; an edited file is kept, --force replaces it, an unedited one follows the config", async () => {
  await inProject({}, async (dir) => {
    await addFastlaneToProject({ dir });
    const again = await addFastlaneToProject({ dir });
    assertEquals(again.written, []);
    assertEquals(again.unchanged, FILES);
    // A team's own lane is kept.
    const fastfile = await read(dir, "fastlane/Fastfile");
    const edited = fastfile + "\nlane :mine do\nend\n";
    await Deno.writeTextFile(join(dir, "fastlane/Fastfile"), edited);
    const kept = await addFastlaneToProject({ dir });
    assertEquals(kept.kept, ["fastlane/Fastfile"]);
    assert(kept.manual.some((m) => m.includes("fastlane/Fastfile was edited")));
    assertEquals(await read(dir, "fastlane/Fastfile"), edited);
    // A new appId flows into the unedited Appfile and Matchfile.
    await Deno.writeTextFile(
      join(dir, "capacitor.config.ts"),
      "export default { appId: 'com.example.notes2', webDir: 'out' };\n",
    );
    const upgraded = await addFastlaneToProject({ dir });
    assertEquals(upgraded.upgraded, ["fastlane/Appfile", "fastlane/Matchfile"]);
    assertStringIncludes(await read(dir, "fastlane/Appfile"), '"com.example.notes2"');
    assertEquals(await read(dir, "fastlane/Fastfile"), edited);
    // --force puts denext's back.
    const forced = await addFastlaneToProject({ dir, force: true });
    assert(forced.written.includes("fastlane/Fastfile"));
    assertEquals(await read(dir, "fastlane/Fastfile"), fastfile);
  });
});

Deno.test("add fastlane: a project's own Gemfile is kept, with the line to add", async () => {
  const own = 'source "https://rubygems.org"\ngem "cocoapods"\n';
  await inProject({ Gemfile: own, "Gemfile.lock": "GEM\n" }, async (dir) => {
    const report = await addFastlaneToProject({ dir });
    assertEquals(report.kept, ["Gemfile"]);
    assertEquals(await read(dir, "Gemfile"), own);
    assert(report.manual.some((m) => m.includes(`gem "fastlane", "~> ${FASTLANE_VERSION}"`)));
    // A lock exists: no `bundle install` step.
    assert(!report.manual.some((m) => m.includes("bundle install")));
  });
});

Deno.test("mobile add fastlane: no install, no sync; --dry-run lists the files and writes none", async () => {
  await inProject({}, async (dir) => {
    const plan = await addMobileCapabilities({
      capabilities: ["fastlane"],
      cwd: dir,
      dryRun: true,
      ci: true,
    });
    assertEquals(plan.plan.install, undefined);
    assertEquals(plan.plan.sync, undefined);
    const text = formatCapabilityPlan(plan.plan);
    for (const file of [...FILES, ".github/workflows/mobile-release.yml"]) {
      assertStringIncludes(text, file);
    }
    assert(!(await exists(join(dir, "fastlane"))));
    assert(!(await exists(join(dir, "Gemfile"))));

    const done = await addMobileCapabilities({ capabilities: ["fastlane"], cwd: dir, run: noRun });
    assertEquals(done.ran, []);
    assertEquals(done.written, FILES);
    // The Info.plist and manifest are not touched.
    assertEquals(await read(dir, "ios/App/App/Info.plist"), "<plist><dict></dict></plist>\n");
  });
  assertStringIncludes(
    formatCapabilityTable(),
    "fastlane         (fastlane: Ruby tooling, no plugin)",
  );
});

Deno.test("mobile add: --ci is only for fastlane", async () => {
  await inProject({}, async (dir) => {
    await assertRejects(
      () => addMobileCapabilities({ capabilities: ["haptics"], cwd: dir, dryRun: true, ci: true }),
      Error,
      "--ci is only for fastlane",
    );
  });
});

Deno.test("add fastlane --ci: the workflow at the repository root, secrets by name, the project's package manager", async () => {
  const repo = await Deno.makeTempDir({ prefix: "denext_fastlane_repo_" });
  try {
    await Deno.mkdir(join(repo, ".git"));
    const dir = join(repo, "apps", "mobile");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "com.example.app", webDir: "out" }),
    );
    await Deno.writeTextFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const report = await addFastlaneToProject({ dir, ci: true });
    assert(report.written.includes("../../.github/workflows/mobile-release.yml"));
    const yml = await Deno.readTextFile(join(repo, ".github/workflows/mobile-release.yml"));
    assertStringIncludes(yml, 'working-directory: "apps/mobile"');
    assertStringIncludes(yml, "pnpm install --frozen-lockfile");
    assertStringIncludes(yml, "uses: ruby/setup-ruby@v1");
    assertStringIncludes(yml, "bundler-cache: true");
    assertStringIncludes(yml, 'bundle exec fastlane android "$LANE"');
    assertStringIncludes(yml, 'bundle exec fastlane ios "$LANE"');
    assertStringIncludes(yml, "runs-on: macos-15");
    for (
      const secret of [
        "MATCH_PASSWORD",
        "APP_STORE_CONNECT_API_KEY_KEY_ID",
        "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
        "APP_STORE_CONNECT_API_KEY_KEY",
        "SUPPLY_JSON_KEY_DATA",
      ]
    ) {
      assertStringIncludes(yml, `${secret}: \${{ secrets.${secret} }}`);
    }
    // Workflow inputs reach the shell through env (no `${{ inputs.* }}` inside a run line).
    for (const line of yml.split("\n").filter((l) => l.trim().startsWith("run:"))) {
      assert(!line.includes("${{"), line);
    }
    assert(report.manual.some((m) => m.includes("repository secrets")));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
  // npm with and without a lockfile.
  // A directory name is YAML text, never markup or an expression.
  assertStringIncludes(
    workflowTemplate({ workingDirectory: "a #b: *c", install: "npm", locked: true, cli: "x" }),
    'working-directory: "a #b: *c"',
  );
  for (const bad of ["x${{ github.token }}", "a\nb"]) {
    let threw = false;
    try {
      workflowTemplate({ workingDirectory: bad, install: "npm", locked: true, cli: "x" });
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
  const npm = workflowTemplate({ workingDirectory: ".", install: "npm", locked: true, cli: "x" });
  assertStringIncludes(npm, "npm ci --no-audit --no-fund");
  assertStringIncludes(
    workflowTemplate({ workingDirectory: ".", install: "npm", locked: false, cli: "x" }),
    "npm install --no-audit --no-fund",
  );
});

// ---- doctor ------------------------------------------------------------------------------------

/** The `fastlane` findings `mobile doctor --release` reports for a project with `files`. */
async function doctorFindings(files: Record<string, string | null>) {
  const dir = await project(files);
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    return {
      listed: report.checks.includes("fastlane"),
      findings: report.findings.filter((f) => f.check === "fastlane"),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("doctor --release: no fastlane/ folder, no fastlane check", async () => {
  const { listed, findings } = await doctorFindings({});
  assertEquals(listed, false);
  assertEquals(findings, []);
  assertEquals(await fastlaneFindings(await Deno.makeTempDir(), "x"), undefined);
});

Deno.test("doctor --release: denext's fastlane files with a Gemfile.lock pass", async () => {
  await inProject({ "Gemfile.lock": "GEM\n" }, async (dir) => {
    await addFastlaneToProject({ dir });
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    assert(report.checks.includes("fastlane"));
    assertEquals(report.findings.filter((f) => f.check === "fastlane"), []);
    // The store profile does not run it.
    const store = await runMobileDoctor({ root: dir, profile: "store" });
    assert(!store.checks.includes("fastlane"));
  });
});

Deno.test("doctor --release: Appfile, Gemfile, Fastfile and secret problems, each with a fix", async () => {
  const { listed, findings } = await doctorFindings({
    "fastlane/Appfile": 'app_identifier("com.other.app")\n',
    "fastlane/Fastfile":
      'lane :beta do\n  gym(scheme: "App")\n  match(git_url: "https://me:ghp_secret@github.com/x/certs")\nend\n',
    "fastlane/Matchfile": 'ENV["MATCH_PASSWORD"] = "hunter2"\n',
    "fastlane/play-key.json": '{"type":"service_account","private_key":"-----BEGIN"}',
    "fastlane/AuthKey_ABC.p8": "-----BEGIN PRIVATE KEY-----",
    "fastlane/.env": "MATCH_PASSWORD=hunter2\n",
    Gemfile: 'source "https://rubygems.org"\ngem "fastlane"\n',
  });
  assert(listed);
  const messages = findings.map((f) => `${f.level}: ${f.message}`);
  const has = (re: RegExp) =>
    assert(messages.some((m) => re.test(m)), `${re} in ${messages.join("\n")}`);
  has(
    /^error: fastlane\/Appfile app_identifier is "com\.other\.app" but capacitor\.config appId is "com\.example\.notes"/,
  );
  has(/^warning: fastlane\/Appfile does not set package_name/);
  has(/^warning: Gemfile has no Gemfile\.lock/);
  has(/^warning: fastlane\/Fastfile builds with gym/);
  has(/^error: fastlane\/Fastfile has a credential in a URL/);
  has(/^error: fastlane\/Matchfile assigns a password literal/);
  has(/^warning: fastlane\/\.env holds a signing or service-account secret/);
  has(/^warning: fastlane\/AuthKey_ABC\.p8 holds/);
  has(/^warning: fastlane\/play-key\.json holds/);
  assert(findings.every((f) => f.fix.length > 0));
});

Deno.test("doctor --release: fastlane/ without an Appfile, a Fastfile or a Gemfile", async () => {
  const { findings } = await doctorFindings({ "fastlane/Pluginfile": "" });
  const messages = findings.map((f) => f.message).join("\n");
  assertStringIncludes(messages, "fastlane/ has no Appfile");
  assertStringIncludes(messages, "fastlane/ has no Fastfile");
  assertStringIncludes(messages, "no Gemfile next to fastlane/");
  assert(findings.every((f) => f.level === "warning"));
  const noFastlaneGem = await doctorFindings({
    "fastlane/Fastfile": "",
    Gemfile: 'gem "cocoapods"\n',
  });
  assertStringIncludes(
    noFastlaneGem.findings.map((f) => f.message).join("\n"),
    "the Gemfile does not list fastlane",
  );
});
