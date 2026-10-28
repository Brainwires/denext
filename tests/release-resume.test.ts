// The release's publish half resumes where it stopped (scripts/lib/release-publish.ts): the JSR
// wait polls meta.json for the exact version with backoff past the old 45-minute limit, a stop
// names the command that resumes it, and a re-run picks up the remaining tags and the PR. Once
// `v<version>` is on JSR the release publishes `@denext/auth` <version> (`auth-v<version>`), which
// pins that denext exactly. Git and jsr.io are faked.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  CORPUS_MODULE,
  CORPUS_PACKAGE,
  corpusVersion,
  moduleSourceHash,
} from "../scripts/lib/docs-corpus-package.ts";
import { memberPin, RUNTIME_MEMBERS } from "../scripts/lib/jsr-pins.ts";
import {
  AUTH_DIR,
  authLockstepRefusal,
  detectResume,
  gateMarkerName,
  gateRefusal,
  type PublishDeps,
  publishFrom,
  readGatePass,
  ReleaseAbort,
  releaseSubject,
  resumeCommand,
  resumeFromArg,
  waitForJsrVersion,
  writeGatePass,
} from "../scripts/lib/release-publish.ts";

const VERSION = await corpusVersion();
const TARGET = { version: VERSION, tag: `v${VERSION}`, branch: "development" };
const LOCAL_HASH = moduleSourceHash(await Deno.readTextFile(CORPUS_MODULE))!;
const AUTH = await memberPin(AUTH_DIR);
const DENEXT = "@denext/denext";

/** A fake jsr.io whose listed versions the test changes as time passes. */
class FakeJsr {
  versions = new Map<string, Set<string>>();
  requests = 0;
  down = false;
  constructor(listed: Record<string, string[]>) {
    for (const [name, vs] of Object.entries(listed)) this.versions.set(name, new Set(vs));
  }
  list(name: string, version: string) {
    if (!this.versions.has(name)) this.versions.set(name, new Set());
    this.versions.get(name)!.add(version);
  }
  fetch = (url: string): Promise<Response> => {
    this.requests++;
    if (this.down) return Promise.reject(new TypeError("network down"));
    const path = new URL(url).pathname;
    const meta = /^\/(@[\w-]+\/[\w-]+)\/meta\.json$/.exec(path);
    if (meta) {
      const list = this.versions.get(meta[1]);
      if (!list) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(Response.json({
        versions: Object.fromEntries([...list].map((v) => [v, {}])),
      }));
    }
    if (path === `/${CORPUS_PACKAGE}/${VERSION}/mod.ts`) {
      return Promise.resolve(
        new Response(`export const CORPUS_SOURCE_HASH: string = "${LOCAL_HASH}";\n`),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  };
}

/** Every runtime member's pinned version, listed (the corpus aside unless `withCorpus`). */
async function pinnedListing(withCorpus: boolean): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const dir of RUNTIME_MEMBERS) {
    const pin = await memberPin(dir);
    if (pin.name === CORPUS_PACKAGE && !withCorpus) continue;
    out[pin.name] = [pin.version];
  }
  return out;
}

/** A fake git: local and remote tags, HEAD's subject, and every command run. */
class FakeGit {
  local = new Set<string>();
  remote = new Set<string>();
  subject = releaseSubject(VERSION);
  calls: string[] = [];
  failPush = false;
  /** A read-only query (`tag --list`, `ls-remote`, `log`), or `null` for a command. */
  query(cmd: string, rest: string[]): string | null {
    if (cmd === "tag" && rest[0] === "--list") return this.local.has(rest[1]) ? rest[1] : "";
    if (cmd === "log") return this.subject;
    if (cmd !== "ls-remote") return null;
    const tag = rest[2].replace("refs/tags/", "");
    return this.remote.has(tag) ? `abc\trefs/tags/${tag}` : "";
  }
  /** A command: record it, apply a tag or a push; a refused push exits 1. */
  command(args: string[]): number {
    this.calls.push(args.join(" "));
    const [cmd, first, second] = args;
    if (cmd === "tag") this.local.add(second);
    if (cmd !== "push") return 0;
    if (this.failPush) return 1;
    if (this.local.has(second)) this.remote.add(second);
    return first === "origin" ? 0 : 1;
  }
  git = (...args: string[]): Promise<{ code: number; out: string }> => {
    const out = this.query(args[0], args.slice(1));
    return Promise.resolve(out === null ? { code: this.command(args), out: "" } : { code: 0, out });
  };
}

/** Deps over the fakes, on a virtual clock that `sleep` advances (calling `onSleep`). */
function deps(git: FakeGit, jsr: FakeJsr, onSleep: (now: number) => void = () => {}) {
  let now = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const d: PublishDeps = {
    git: git.git,
    fetch: jsr.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      onSleep(now);
      return Promise.resolve();
    },
    now: () => now,
    log: (line) => logs.push(line),
  };
  return { d, sleeps, logs, elapsed: () => now };
}

const MINUTE = 60_000;

Deno.test("release JSR wait: polls the exact version with backoff, well past 45 minutes", async () => {
  const jsr = new FakeJsr({ [CORPUS_PACKAGE]: ["0.0.1"] }); // another version is no match
  const { d, sleeps, elapsed } = deps(new FakeGit(), jsr, (now) => {
    if (now >= 70 * MINUTE) jsr.list(CORPUS_PACKAGE, VERSION);
  });
  assert(await waitForJsrVersion(CORPUS_PACKAGE, VERSION, d));
  assert(elapsed() >= 70 * MINUTE, "kept waiting past the old 45-minute limit");
  assertEquals(sleeps.slice(0, 4), [15_000, 30_000, 60_000, 120_000], "backs off");
  assert(sleeps.every((ms) => ms <= 5 * MINUTE), "capped at 5 minutes");
  assert(sleeps.length < 25, `a handful of polls, not one every 30 s (${sleeps.length})`);
});

Deno.test("release JSR wait: a network error is retried; the deadline still ends it", async () => {
  const jsr = new FakeJsr({});
  jsr.down = true;
  const { d, logs, elapsed } = deps(new FakeGit(), jsr, (now) => {
    if (now > 2 * MINUTE) jsr.down = false; // back up, but never lists it
  });
  assertEquals(
    await waitForJsrVersion(CORPUS_PACKAGE, VERSION, { ...d, jsrWaitMs: 30 * MINUTE }),
    false,
  );
  assertEquals(elapsed(), 30 * MINUTE, "stops exactly at the deadline");
  assert(logs.some((l) => l.includes("could not be asked (network down)")), logs.join("\n"));
});

Deno.test("release resume: a stopped corpus wait names the command that resumes it", async () => {
  const git = new FakeGit();
  const jsr = new FakeJsr(await pinnedListing(false));
  const { d } = deps(git, jsr);
  const err = await assertRejects(
    () => publishFrom(TARGET, "corpus", { ...d, jsrWaitMs: 10 * MINUTE }),
    ReleaseAbort,
  );
  assertStringIncludes(err.message, resumeCommand(TARGET, "corpus"));
  const corpus = await memberPin("docs-corpus");
  assertEquals(git.calls, [
    `tag -a ${corpus.tag} -m ${corpus.name} ${corpus.version}`,
    "push origin development",
    `push origin ${corpus.tag}`,
  ]);
  // The re-run sees the release commit with no v-tag yet, and resumes at the corpus step.
  assertEquals(await detectResume(TARGET, d), "corpus");
  // JSR lists the corpus now: the corpus tag is neither made nor pushed again, then the tag,
  // the pushes and the PR hand-over.
  jsr.list(CORPUS_PACKAGE, VERSION);
  git.calls = [];
  // publish.yml lists denext, then (once auth-v is pushed) auth.
  const resumed = deps(git, jsr, () => {
    jsr.list(DENEXT, VERSION);
    if (git.remote.has(AUTH.tag)) jsr.list(AUTH.name, VERSION);
  });
  await publishFrom(TARGET, "corpus", resumed.d);
  assertEquals(git.calls, [
    `tag -a ${TARGET.tag} -m denext ${VERSION}`,
    "push origin development",
    `push origin ${TARGET.tag}`,
    `tag -a ${AUTH.tag} -m ${AUTH.name} ${VERSION} ${TARGET.tag}^{}`,
    `push origin ${AUTH.tag}`,
  ]);
  assert(resumed.logs.some((l) => l.includes(`✓ Released ${VERSION}`)));
  assert(resumed.logs.some((l) => l.includes("gh pr create --base main --head development")));
  // Done: a further run re-checks auth on JSR (no git) and hands over the PR.
  assertEquals(await detectResume(TARGET, d), "auth");
  git.calls = [];
  const again = deps(git, jsr);
  await publishFrom(TARGET, "auth", again.d);
  assertEquals(git.calls, []);
  assertEquals(again.sleeps, [], "auth is on JSR: no wait");
});

Deno.test("release resume: a failed push resumes at the push, with the tag already made", async () => {
  const git = new FakeGit();
  const jsr = new FakeJsr(await pinnedListing(true));
  const { d } = deps(git, jsr);
  git.failPush = true;
  const err = await assertRejects(() => publishFrom(TARGET, "corpus", d), ReleaseAbort);
  assertStringIncludes(err.message, "git push (branch) failed");
  assertStringIncludes(err.message, resumeCommand(TARGET, "push"));
  assertEquals(await detectResume(TARGET, d), "push");
  git.failPush = false;
  git.calls = [];
  jsr.list(DENEXT, VERSION);
  jsr.list(AUTH.name, VERSION); // auth published by hand meanwhile: not tagged again
  await publishFrom(TARGET, "push", d);
  assertEquals(git.calls, ["push origin development", `push origin ${TARGET.tag}`]);
});

Deno.test("release resume: an unpublished pin refuses the tag, resumable at the tag step", async () => {
  const listing = await pinnedListing(true);
  const og = await memberPin("og");
  delete listing[og.name];
  const git = new FakeGit();
  const { d } = deps(git, new FakeJsr(listing));
  const err = await assertRejects(() => publishFrom(TARGET, "tag", d), ReleaseAbort);
  assertStringIncludes(err.message, `${og.name}@${og.version}`);
  assertStringIncludes(err.message, resumeCommand(TARGET, "tag"));
  assertEquals(git.calls, []);
});

/** A git whose `v<version>` is pushed: the release resumes at `auth`. */
function pushedGit(): FakeGit {
  const git = new FakeGit();
  git.local.add(TARGET.tag);
  git.remote.add(TARGET.tag);
  return git;
}

Deno.test("release auth: auth-v waits for denext on JSR, is tagged on the release, then listed", async () => {
  const git = pushedGit();
  const jsr = new FakeJsr({});
  let tagsBeforeDenext: string[] | undefined;
  const { d, elapsed } = deps(git, jsr, (now) => {
    if (now >= 50 * MINUTE && !tagsBeforeDenext) {
      tagsBeforeDenext = [...git.calls];
      jsr.list(DENEXT, VERSION); // publish.yml's gate + publish of v<version>
    }
    if (git.remote.has(AUTH.tag) && now >= 90 * MINUTE) jsr.list(AUTH.name, VERSION);
  });
  await publishFrom(TARGET, "auth", d);
  assertEquals(tagsBeforeDenext, [], "nothing tagged while JSR lacks the denext auth pins");
  assertEquals(git.calls, [
    `tag -a ${AUTH.tag} -m ${AUTH.name} ${VERSION} ${TARGET.tag}^{}`,
    `push origin ${AUTH.tag}`,
  ]);
  assert(elapsed() >= 90 * MINUTE, "waited for JSR to list auth, not just the push");
  assertEquals(AUTH.tag, `auth-v${VERSION}`);
});

Deno.test("release auth: denext never listed stops before tagging, resumable at auth", async () => {
  const git = pushedGit();
  const { d } = deps(git, new FakeJsr({}));
  const err = await assertRejects(
    () => publishFrom(TARGET, "auth", { ...d, jsrWaitMs: 10 * MINUTE }),
    ReleaseAbort,
  );
  assertStringIncludes(err.message, `${DENEXT}@${VERSION}`);
  assertStringIncludes(err.message, resumeCommand(TARGET, "auth"));
  assertEquals(git.calls, []);
});

Deno.test("release auth: an unlisted auth publish stops; the resume neither re-tags nor re-pushes", async () => {
  const git = pushedGit();
  const jsr = new FakeJsr({ [DENEXT]: [VERSION] });
  const { d } = deps(git, jsr);
  const err = await assertRejects(
    () => publishFrom(TARGET, "auth", { ...d, jsrWaitMs: 10 * MINUTE }),
    ReleaseAbort,
  );
  assertStringIncludes(err.message, `${AUTH.tag} is pushed but jsr.io does not list`);
  assertStringIncludes(err.message, resumeCommand(TARGET, "auth"));
  assertEquals(await detectResume(TARGET, d), "auth");
  git.calls = [];
  const resumed = deps(git, jsr, () => jsr.list(AUTH.name, VERSION)); // publish.yml re-run
  await publishFrom(TARGET, "auth", resumed.d);
  assertEquals(git.calls, [], "the tag exists here and on origin");
  assert(resumed.logs.some((l) => l.includes(`${AUTH.name}@${VERSION} is on JSR`)));
  // A failed push of the auth tag names the same resume.
  const failing = pushedGit();
  failing.failPush = true;
  const pushErr = await assertRejects(
    () => publishFrom(TARGET, "auth", deps(failing, new FakeJsr({ [DENEXT]: [VERSION] })).d),
    ReleaseAbort,
  );
  assertStringIncludes(pushErr.message, `git push (${AUTH.tag}) failed`);
  assertStringIncludes(pushErr.message, resumeCommand(TARGET, "auth"));
});

Deno.test("release auth: an auth manifest out of lockstep refuses v<version> before tagging", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-auth-lockstep-" });
  const write = async (manifest: unknown) => {
    await Deno.mkdir(`${root}/packages/${AUTH_DIR}`, { recursive: true });
    await Deno.writeTextFile(`${root}/packages/${AUTH_DIR}/deno.json`, JSON.stringify(manifest));
  };
  try {
    assertEquals(await authLockstepRefusal(VERSION), null, "this checkout is in lockstep");
    await write({
      name: AUTH.name,
      version: "0.0.1",
      imports: { [DENEXT]: `jsr:${DENEXT}@0.0.1` },
    });
    assertStringIncludes((await authLockstepRefusal(VERSION, root))!, `at 0.0.1, not ${VERSION}`);
    await write({
      name: AUTH.name,
      version: VERSION,
      imports: { [DENEXT]: `jsr:${DENEXT}@^${VERSION}` },
    });
    assertStringIncludes((await authLockstepRefusal(VERSION, root))!, "pins the denext");
    const git = new FakeGit();
    const { d } = deps(git, new FakeJsr(await pinnedListing(true)));
    const err = await assertRejects(() => publishFrom(TARGET, "tag", { ...d, root }), ReleaseAbort);
    assertStringIncludes(err.message, `refusing to tag ${TARGET.tag}`);
    assertEquals(git.calls, [], "neither v<version> nor auth-v is tagged");
    const authErr = await assertRejects(
      () => publishFrom(TARGET, "auth", { ...deps(pushedGit(), new FakeJsr({})).d, root }),
      ReleaseAbort,
    );
    assertStringIncludes(authErr.message, "this one cannot ship auth");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("release resume: a fresh tree is not a resume; --resume-from is validated", async () => {
  const git = new FakeGit();
  git.subject = "feat: something else";
  const { d } = deps(git, new FakeJsr({}));
  assertEquals(await detectResume(TARGET, d), null);
  git.local.add(TARGET.tag);
  assertEquals(await detectResume(TARGET, d), "push", "a local v-tag resumes at the push");
  assertEquals(resumeFromArg(["4.6.0", "--resume-from", "tag"]), "tag");
  assertEquals(resumeFromArg(["4.6.0", "--resume-from=pr"]), "pr");
  assertEquals(resumeFromArg(["4.6.0", "--resume-from", "auth"]), "auth");
  git.remote.add(TARGET.tag);
  assertEquals(await detectResume(TARGET, d), "auth", "a pushed v-tag resumes at auth");
  assertEquals(resumeFromArg(["4.6.0", "--confirm"]), undefined);
  assertRejects(
    () => Promise.resolve().then(() => resumeFromArg(["--resume-from", "x"])),
    ReleaseAbort,
  );
});

Deno.test("release resume: no recorded gate pass refuses every resume, naming --regate", () => {
  const current = { version: VERSION, base: "a".repeat(40), tree: "b".repeat(40) };
  for (const step of ["commit", "corpus", "tag", "push", "auth", "pr"] as const) {
    const refusal = gateRefusal(null, current, TARGET, step);
    assert(refusal, `${step} resumed without a gate pass`);
    assertStringIncludes(refusal, "never passed");
    assertStringIncludes(refusal, `--resume-from ${step} --regate`);
  }
});

Deno.test("release resume: a gate pass covers only its own version, base and tree", () => {
  const pass = { version: VERSION, base: "a".repeat(40), tree: "b".repeat(40) };
  assertEquals(gateRefusal(pass, { ...pass }, TARGET, "tag"), null);
  // A release commit made by hand on a tree the gate never saw (the old "commit by hand" hint).
  assertStringIncludes(
    gateRefusal(pass, { ...pass, tree: "c".repeat(40) }, TARGET, "corpus")!,
    "tree changed since the gates passed",
  );
  assertStringIncludes(
    gateRefusal(pass, { ...pass, base: "d".repeat(40) }, TARGET, "push")!,
    "but this release is cut on",
  );
  assertStringIncludes(
    gateRefusal({ ...pass, version: "0.0.1" }, pass, TARGET, "pr")!,
    "is for 0.0.1",
  );
});

Deno.test("release resume: the gate-pass marker round-trips; a missing or bad one reads null", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-gate-marker-" });
  try {
    const path = `${dir}/${gateMarkerName(VERSION)}`;
    assertEquals(await readGatePass(path), null);
    const pass = { version: VERSION, base: "a".repeat(40), tree: "b".repeat(40) };
    await writeGatePass(path, pass);
    assertEquals(await readGatePass(path), pass);
    await Deno.writeTextFile(path, '{"version": 1}');
    assertEquals(await readGatePass(path), null);
    await Deno.writeTextFile(path, "not json");
    assertEquals(await readGatePass(path), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release: the gate pass is recorded after both gates and required by every resume", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/release.ts", import.meta.url));
  const body = (fn: string) => {
    const start = src.indexOf(`async function ${fn}(`);
    assert(start >= 0, fn);
    return src.slice(start, src.indexOf("\n}\n", start));
  };
  const main = body("main");
  // Fresh release: CI gate, then the local gate, then the marker, then (and only then) publish.
  const order = ["checkCi(", "runGate(", "recordGatePass(", "confirmRelease("].map((s) =>
    main.indexOf(s)
  );
  assert(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  // A resume returns before any of that, so it must check the marker itself: on the `commit`
  // path before the commit, on every other path before the publish steps.
  const resume = body("resumeRelease");
  const commitPath = resume.slice(resume.indexOf(`if (step === "commit")`));
  assert(
    commitPath.indexOf("requireGatePass(") < commitPath.indexOf("publish("),
    "commit resume checks the marker before committing",
  );
  assert(
    resume.lastIndexOf("requireGatePass(") < resume.indexOf("publishSteps("),
    "every other resume checks the marker before publishing",
  );
  // The fresh path re-checks the commit it made against the marker before publishing.
  const publish = body("publish");
  assert(publish.indexOf("gateRefusal(") < publish.indexOf("publishSteps("));
  // No "commit by hand" escape hatch, and `deno cache` is fail-stop.
  assert(!src.includes("commit by hand"));
  assert(/if \(await run\("deno", "cache", "mod\.ts"\) !== 0\)/.test(src));
});
