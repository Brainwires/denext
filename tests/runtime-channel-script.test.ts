// scripts/runtime-channel.ts (`deno task runtime:*`): keygen into the keychain without the secret
// reaching a command line or the output; publish refusing to sign before the compatibility proof
// is green on both legs, adding the entry, self-verifying against the compiled-in keys and
// publishing the release document before the index (web root + the mirror's orphan branch, one
// commit on top of it); yank, resign, verify on both bases, expiry, floor, pin and release-doc.
// Every process is faked: no keychain, GitHub or host is touched; every key is generated here.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  CHANNEL_KEYCHAIN_SERVICE,
  type ChannelDeps,
  channelMinSequenceIn,
  type CompatLeg,
  compatLegs,
  entriesText,
  main,
  publishedChannelExpiryWarning,
  readEntries,
  refuseDroppedReleases,
  withChannelMinSequence,
  withEntry,
} from "../scripts/runtime-channel.ts";
import { compatLegsFromTags } from "../scripts/ci/runtime-compat-legs.ts";
import { documentOf, releaseDocument } from "../scripts/lib/runtime-release-doc.ts";
import type { RunResult } from "../scripts/runtime-revocations.ts";
import {
  CHANNEL_BASES,
  freshRuntimeChannel,
  releaseEntryFor,
  type RuntimeChannel,
  type RuntimeReleaseDocument,
  signRuntimeChannel,
  verifyReleaseDocument,
  verifyRuntimeChannel,
} from "../src/build/runtime-channel.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };
import desktopPin from "../src/build/desktop-runtime-pin.json" with { type: "json" };

const NOW = new Date("2026-11-20T00:00:00Z");
const T = NOW.getTime();
const DAY = 86_400_000;
const VERSION = toolchainPin.version;
const TAG = toolchainPin.tag;
const ROOT = new URL("..", import.meta.url);

const ok = (stdout = ""): RunResult => ({ code: 0, stdout });

/** The bundled pins as a release document. */
function bundledDocument(): RuntimeReleaseDocument {
  const { rollback: _t, ...toolchain } = structuredClone(toolchainPin) as Record<string, unknown>;
  const { rollback: _d, ...desktop } = structuredClone(desktopPin) as Record<string, unknown>;
  return { toolchain, desktop } as unknown as RuntimeReleaseDocument;
}

/** A document for another version, same archives re-labelled (URLs follow the tag). */
function documentFor(version: string): RuntimeReleaseDocument {
  const doc = bundledDocument();
  const text = JSON.stringify(doc).replaceAll(VERSION, version);
  return JSON.parse(text);
}

/** The fake world. */
interface World {
  deps: ChannelDeps;
  dir: string;
  keychain: Map<string, string>;
  calls: Array<{ cmd: string; args: string[]; stdin?: string }>;
  logged: string[];
  /** url → served text (both bases). */
  served: Map<string, string>;
  /** The rsynced files: path under runtime/ → text, in upload order. */
  web: Array<[string, string]>;
  /** Mirror commits: their base tree, parents and paths. */
  mirror: Array<{ baseTree?: string; parents: string[]; paths: string[] }>;
  compatCalls: string[];
}

function fakeSecurity(keychain: Map<string, string>, args: string[], stdin?: string): RunResult {
  if (args[0] === "-i") {
    const m = /add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n/.exec(stdin ?? "")!;
    keychain.set(`${m[1]}/${m[2]}`, m[3]);
    return ok();
  }
  const key = keychain.get(`${args[2]}/${args[4]}`);
  if (key === undefined) return { code: 44, stdout: "" };
  return ok(args.includes("-w") ? `${key}\n` : "");
}

/** The fake git data API over the mirror branch; trees remember their paths. */
function fakeGh(w: Pick<World, "mirror">) {
  const state = { branch: null as string | null, n: 0 };
  const trees = new Map<string, { base?: string; paths: string[] }>();
  /** A request body: `tree` is a list of entries for git/trees, a tree sha for git/commits. */
  type Body = { sha: string; tree: unknown; base_tree?: string; parents: string[] };
  const routes: Array<
    [(method: string, path: string) => boolean, (body: Body, path: string) => RunResult]
  > = [
    [
      (m, p) => m === "GET" && p.includes("git/ref/"),
      () =>
        state.branch
          ? ok(JSON.stringify({ object: { sha: state.branch } }))
          : { code: 1, stdout: "" },
    ],
    [
      (m, p) => m === "GET" && p.includes("git/commits/"),
      (_b, p) => ok(JSON.stringify({ tree: { sha: `tree-of-${p.split("/").pop()}` } })),
    ],
    [(_m, p) => p.endsWith("git/blobs"), () => ok(JSON.stringify({ sha: `b${++state.n}` }))],
    [(_m, p) => p.endsWith("git/trees"), (b) => {
      const sha = `t${++state.n}`;
      trees.set(sha, {
        base: b.base_tree,
        paths: (b.tree as { path: string }[]).map((t) => t.path),
      });
      return ok(JSON.stringify({ sha }));
    }],
    [(_m, p) => p.endsWith("git/commits"), (b) => {
      const t = trees.get(b.tree as string)!;
      w.mirror.push({ baseTree: t.base, parents: b.parents, paths: t.paths });
      return ok(JSON.stringify({ sha: `c${++state.n}` }));
    }],
    [(_m, p) => p.includes("git/refs"), (b) => {
      state.branch = b.sha;
      return ok("{}");
    }],
  ];
  return (args: string[], stdin?: string): RunResult => {
    const [, , method, path] = args;
    const route = routes.find(([match]) => match(method, path));
    return route ? route[1](stdin ? JSON.parse(stdin) : {}, path) : { code: 1, stdout: "" };
  };
}

/** Walk a staged rsync source and record every file (path relative to it). */
async function staged(dir: string, prefix = ""): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for await (const e of Deno.readDir(dir)) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...await staged(join(dir, e.name), rel));
    else out.push([rel, await Deno.readTextFile(join(dir, e.name))]);
  }
  return out;
}

async function world(over: Partial<ChannelDeps> = {}): Promise<World> {
  const dir = await Deno.makeTempDir({ prefix: "denext-channel-script-" });
  const w: World = {
    deps: undefined as unknown as ChannelDeps,
    dir,
    keychain: new Map(),
    calls: [],
    logged: [],
    served: new Map(),
    web: [],
    mirror: [],
    compatCalls: [],
  };
  const gh = fakeGh(w);
  const run = async (cmd: string, args: string[], stdin?: string): Promise<RunResult> => {
    w.calls.push({ cmd, args, ...(stdin !== undefined ? { stdin } : {}) });
    if (cmd === "security") return fakeSecurity(w.keychain, args, stdin);
    if (cmd === "gh") return gh(args, stdin);
    if (cmd === "rsync") {
      for (const [rel, text] of await staged(args.at(-2)!.replace(/\/$/, ""))) {
        w.web.push([rel, text]);
        // What the web base now serves.
        w.served.set(new URL(rel, CHANNEL_BASES[0]).href, text);
      }
      return ok();
    }
    return { code: 127, stdout: "" };
  };
  const pinFiles = { toolchain: join(dir, "toolchain.json"), desktop: join(dir, "desktop.json") };
  await Deno.writeTextFile(pinFiles.toolchain, JSON.stringify(toolchainPin));
  await Deno.writeTextFile(pinFiles.desktop, JSON.stringify(desktopPin));
  const entriesFile = join(dir, "entries.json");
  await Deno.writeTextFile(entriesFile, '{ "releases": [] }\n');
  w.deps = {
    run,
    fetchText: (url) => Promise.resolve(w.served.get(url) ?? null),
    keys: [],
    now: () => NOW,
    env: (k) => (k === "DENEXT_REVOCATIONS_RSYNC_ROOT" ? "host:/srv/www/" : undefined),
    log: (l) => void w.logged.push(l),
    releaseDocument: (tag) => {
      const version = tag.replace("denext-runtime-v", "");
      return Promise.resolve(version === VERSION ? bundledDocument() : documentFor(version));
    },
    releasedAt: () => Promise.resolve("2026-11-10T12:00:00Z"),
    compat: (tag): Promise<CompatLeg[]> => {
      w.compatCalls.push(tag);
      return Promise.resolve([{ denext: "4.20.1", ok: true }, { denext: "4.19.0", ok: true }]);
    },
    revoked: () => Promise.resolve(false),
    pinFiles,
    entriesFile,
    sleep: () => Promise.resolve(),
    ...over,
  };
  return w;
}

/** keygen the active key and compile it in. */
async function withKey(over: Partial<ChannelDeps> = {}): Promise<World & { pub: string }> {
  const w = await world(over);
  await main(["keygen"], w.deps);
  const pub = w.logged.at(-1)!;
  (w.deps as { keys: readonly string[] }).keys = [pub];
  w.logged.length = 0;
  return { ...w, pub };
}

async function cleanup(w: World) {
  await Deno.remove(w.dir, { recursive: true });
}

/** Mirror the web copy to the mirror base too (both bases serve the same). */
function mirrorWeb(w: World) {
  for (const [url, text] of [...w.served]) {
    if (url.startsWith(CHANNEL_BASES[0])) {
      w.served.set(url.replace(CHANNEL_BASES[0], CHANNEL_BASES[1]), text);
    }
  }
}

const published = (w: World) => w.served.get(new URL("channel.json", CHANNEL_BASES[0]).href);

Deno.test("keygen: the channel key reaches the keychain through stdin only, under its own service", async () => {
  const w = await world();
  try {
    await main(["keygen", "--slot", "backup"], w.deps);
    const secret = w.keychain.get(`${CHANNEL_KEYCHAIN_SERVICE}/backup`)!;
    assert(secret && secret.length > 100);
    assert(![...w.keychain.keys()].some((k) => k.startsWith("denext-runtime-revocations/")));
    for (const c of w.calls) assert(!c.args.join(" ").includes(secret), "never on a command line");
    assert(!w.logged.join("\n").includes(secret), "never printed");
    assertStringIncludes(w.logged.join("\n"), "backup slot of src/build/runtime-channel-keys.ts");
    await assertRejects(() => main(["keygen", "--slot", "backup"], w.deps), Error, "--force");
    await assertRejects(() => main(["keygen", "--slot", "spare"], w.deps), Error, "--slot");
  } finally {
    await cleanup(w);
  }
});

Deno.test("publish: green on both legs → entry, signed index, document before index, one mirror commit", async () => {
  const w = await withKey();
  try {
    const out = join(w.dir, "out");
    await main(["publish", TAG, "--out", out, "--security"], w.deps);
    assertEquals(w.compatCalls, [TAG]);
    const [entry] = readEntries(JSON.parse(await Deno.readTextFile(w.deps.entriesFile!)));
    assertEquals(entry.version, VERSION);
    assertEquals(entry.minDenext, "4.19.0", "the oldest green leg");
    assertEquals(entry.releasedAt, "2026-11-10T12:00:00Z");
    assertEquals(entry.security, true);
    assertEquals(await Deno.readTextFile(w.deps.entriesFile!), entriesText([entry]));
    // The document went up first, the index after it.
    assertEquals(w.web.map(([p]) => p), [`releases/${VERSION}.json`, "channel.json"]);
    const index = await verifyRuntimeChannel(published(w)!, [w.pub], { now: T });
    assertEquals(index?.releases, [entry]);
    await verifyReleaseDocument(w.web[0][1], entry);
    assertEquals(await Deno.readTextFile(join(out, "channel.json")), published(w));
    assertEquals(await Deno.readTextFile(join(out, "releases", `${VERSION}.json`)), w.web[0][1]);
    // rsync of each file into the web root's runtime/ directory.
    const rsyncs = w.calls.filter((c) => c.cmd === "rsync");
    assertEquals(rsyncs.map((c) => c.args.at(-1)), [
      "host:/srv/www/runtime/",
      "host:/srv/www/runtime/",
    ]);
    // The mirror: one orphan commit with both files.
    assertEquals(w.mirror, [{
      baseTree: undefined,
      parents: [],
      paths: [`releases/${VERSION}.json`, "channel.json"],
    }]);
    assertStringIncludes(w.logged.join("\n"), "commit");

    // A second release builds on the branch (the first document is kept by the base tree).
    const next = "3.0.0-denext.28";
    await main(["publish", `denext-runtime-v${next}`, "--out", out], w.deps);
    assertEquals(w.mirror[1].parents.length, 1, "on top of the branch, never a force push");
    assert(w.mirror[1].baseTree?.startsWith("tree-of-"));
    const both = await verifyRuntimeChannel(published(w)!, [w.pub], { now: T });
    assertEquals(both?.releases.map((r) => r.version), [next, VERSION]);
    assert(both!.sequence > index!.sequence);
  } finally {
    await cleanup(w);
  }
});

Deno.test("publish: nothing is signed while the compatibility proof is red or incomplete", async () => {
  for (
    const legs of [
      [{ denext: "4.20.1", ok: true }, { denext: "4.19.0", ok: false }],
      [{ denext: "4.20.1", ok: true }],
      [],
    ]
  ) {
    const w = await withKey({ compat: () => Promise.resolve(legs) });
    try {
      await assertRejects(
        () => main(["publish", TAG, "--out", join(w.dir, "out")], w.deps),
        Error,
        "not green on both legs",
      );
      assert(!w.calls.some((c) => c.args.includes("-w")), "the signing key was never read");
      assertEquals(w.web, []);
    } finally {
      await cleanup(w);
    }
  }
});

Deno.test("publish --bundled: only for the checked-out pin or its rollback, with --min-denext", async () => {
  const w = await withKey();
  try {
    const out = join(w.dir, "out");
    await assertRejects(
      () => main(["publish", TAG, "--bundled", "--out", out, "--no-publish"], w.deps),
      Error,
      "--min-denext",
    );
    await assertRejects(
      () =>
        main(
          ["publish", "denext-runtime-v3.0.0-denext.40", "--bundled", "--min-denext", "4.18.0"],
          w.deps,
        ),
      Error,
      "neither the checked-out pin nor its rollback",
    );
    await assertRejects(
      () => main(["publish", TAG, "--min-denext", "4.18.0", "--no-publish"], w.deps),
      Error,
      "only for --bundled",
    );
    await main([
      "publish",
      TAG,
      "--bundled",
      "--min-denext",
      "4.18.0",
      "--out",
      out,
      "--no-publish",
    ], w.deps);
    assertEquals(w.compatCalls, [], "no compat run for a bundled release");
    assertEquals(
      readEntries(JSON.parse(await Deno.readTextFile(w.deps.entriesFile!)))[0].minDenext,
      "4.18.0",
    );
    assertEquals(w.web, [], "--no-publish");
    // The rollback release qualifies too.
    const rb = toolchainPin.rollback!.version;
    await main([
      "publish",
      `denext-runtime-v${rb}`,
      "--bundled",
      "--min-denext",
      "4.17.0",
      "--out",
      out,
      "--no-publish",
    ], w.deps);
    const versions = readEntries(JSON.parse(await Deno.readTextFile(w.deps.entriesFile!))).map((
      e,
    ) => e.version);
    assertEquals(versions, [VERSION, rb]);
  } finally {
    await cleanup(w);
  }
});

Deno.test("publish: a listed version keeps its document; another document for it is refused", async () => {
  const w = await withKey();
  try {
    const out = join(w.dir, "out");
    await main(["publish", TAG, "--out", out, "--no-publish"], w.deps);
    await main(["publish", TAG, "--out", out, "--no-publish"], w.deps);
    assertStringIncludes(w.logged.join("\n"), `kept ${VERSION}`);
    const changed = await withKey();
    try {
      await Deno.copyFile(w.deps.entriesFile!, changed.deps.entriesFile!);
      const other = bundledDocument();
      (other.desktop as { laufeySha: string }).laufeySha = "0".repeat(40);
      (changed.deps as { releaseDocument: ChannelDeps["releaseDocument"] }).releaseDocument = () =>
        Promise.resolve(other);
      await assertRejects(
        () => main(["publish", TAG, "--out", out, "--no-publish"], changed.deps),
        Error,
        "never changes",
      );
    } finally {
      await cleanup(changed);
    }
  } finally {
    await cleanup(w);
  }
});

Deno.test("publish: an entries file that drops a published release is refused", async () => {
  const w = await withKey();
  try {
    await main(["publish", TAG, "--out", join(w.dir, "out")], w.deps);
    await Deno.writeTextFile(w.deps.entriesFile!, '{ "releases": [] }\n');
    await assertRejects(
      () => main(["publish", "denext-runtime-v3.0.0-denext.28", "--no-publish"], w.deps),
      Error,
      "leaves out",
    );
  } finally {
    await cleanup(w);
  }
});

Deno.test("signing: a keychain key that is not compiled in is refused; --with-backup signs twice", async () => {
  const w = await withKey();
  try {
    const stranger = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", stranger.publicKey));
    const other = btoa(String.fromCharCode(...spki));
    await assertRejects(
      () =>
        main(["publish", TAG, "--out", join(w.dir, "out"), "--no-publish"], {
          ...w.deps,
          keys: [other],
        }),
      Error,
      "not one of them",
    );
    await assertRejects(
      () => main(["publish", TAG, "--no-publish"], { ...w.deps, keys: [] }),
      Error,
      "no runtime channel public key",
    );
    await assertRejects(
      () => main(["publish", TAG, "--with-backup", "--no-publish"], w.deps),
      Error,
      "backup key in the keychain",
    );
    await main(["keygen", "--slot", "backup"], w.deps);
    const backup = w.logged.at(-1)!;
    const out = join(w.dir, "out");
    await main(["publish", TAG, "--with-backup", "--out", out, "--no-publish"], {
      ...w.deps,
      keys: [w.pub, backup],
    });
    const env = JSON.parse(await Deno.readTextFile(join(out, "channel.json")));
    assertEquals(env.signatures.length, 2);
    assert(await verifyRuntimeChannel(JSON.stringify(env), [backup], { now: T }));
  } finally {
    await cleanup(w);
  }
});

Deno.test("yank marks a release and re-signs; resign --if-due waits until 15 days remain", async () => {
  const w = await withKey();
  try {
    const out = join(w.dir, "out");
    await main(["publish", TAG, "--out", out], w.deps);
    await assertRejects(() => main(["yank", VERSION], w.deps), Error, "--reason");
    await assertRejects(
      () => main(["yank", "3.0.0-denext.99", "--reason", "x"], w.deps),
      Error,
      "is not listed",
    );
    w.web.length = 0;
    await main(["yank", VERSION, "--reason", "crashes on start", "--out", out], w.deps);
    assertEquals(w.web.map(([p]) => p), ["channel.json"], "only the index changes");
    const yanked = await verifyRuntimeChannel(published(w)!, [w.pub], { now: T });
    assertEquals(yanked?.releases[0].yanked, { reason: "crashes on start" });
    assertEquals(
      readEntries(JSON.parse(await Deno.readTextFile(w.deps.entriesFile!)))[0].yanked?.reason,
      "crashes on start",
    );

    w.logged.length = 0;
    await main(["resign", "--if-due", "--out", out], w.deps);
    assertStringIncludes(w.logged.join("\n"), "not due yet");
    const later = { ...w.deps, now: () => new Date(T + 31 * DAY) };
    await main(["resign", "--if-due", "--out", out], later);
    const resigned = await verifyRuntimeChannel(published(w)!, [w.pub], { now: T + 31 * DAY });
    assert(resigned!.sequence > yanked!.sequence);
    assertEquals(resigned?.releases, yanked?.releases);
    // No key compiled in: nothing to re-sign; nothing published: refused.
    w.logged.length = 0;
    await main(["resign"], { ...w.deps, keys: [] });
    assertStringIncludes(w.logged.join("\n"), "nothing to re-sign");
    w.served.clear();
    await assertRejects(() => main(["resign"], w.deps), Error, "could not read");
  } finally {
    await cleanup(w);
  }
});

Deno.test("verify: every base's index and every document it lists; a tampered copy names its URL", async () => {
  const w = await withKey();
  try {
    await main(["publish", TAG, "--out", join(w.dir, "out")], w.deps);
    await assertRejects(
      () => main(["verify"], w.deps),
      Error,
      `${CHANNEL_BASES[1]}: no index served`,
    );
    mirrorWeb(w);
    w.logged.length = 0;
    await main(["verify"], w.deps);
    assertEquals(w.logged.length, 2);
    for (const base of CHANNEL_BASES) assert(w.logged.some((l) => l.startsWith(base)), base);
    const docUrl = new URL(`releases/${VERSION}.json`, CHANNEL_BASES[1]).href;
    w.served.set(docUrl, w.served.get(docUrl)!.replace("2.9.8", "2.9.9"));
    await assertRejects(() => main(["verify"], w.deps), Error, docUrl);
    w.served.delete(docUrl);
    await assertRejects(() => main(["verify"], w.deps), Error, "not served");
    // A file: the index and its entries.
    const file = join(w.dir, "out", "channel.json");
    w.logged.length = 0;
    await main(["verify", file], w.deps);
    assertStringIncludes(w.logged.join("\n"), `${VERSION} (deno 2.9.8, denext ≥ 4.19.0)`);
    await assertRejects(
      () => main(["verify"], { ...w.deps, keys: [] }),
      Error,
      "no runtime channel public key",
    );
    // A base serving an index that does not verify.
    w.served.set(new URL("channel.json", CHANNEL_BASES[1]).href, "{}");
    await assertRejects(() => main(["verify"], w.deps), Error, "envelope");
  } finally {
    await cleanup(w);
  }
});

Deno.test("expiry: the release gate's warning, never a throw", async () => {
  const w = await withKey();
  try {
    assertEquals(await publishedChannelExpiryWarning({ ...w.deps, keys: [] }), null);
    assertStringIncludes((await publishedChannelExpiryWarning(w.deps))!, "could be read");
    await main(["publish", TAG, "--out", join(w.dir, "out")], w.deps);
    assertEquals(await publishedChannelExpiryWarning(w.deps), null);
    const soon = await publishedChannelExpiryWarning({
      ...w.deps,
      now: () => new Date(T + 40 * DAY),
    });
    assertStringIncludes(soon!, "in 5 days");
    const gone = await publishedChannelExpiryWarning({
      ...w.deps,
      now: () => new Date(T + 50 * DAY),
    });
    assertStringIncludes(gone!, "EXPIRED");
    w.served.set(new URL("channel.json", CHANNEL_BASES[0]).href, "{}");
    assertStringIncludes((await publishedChannelExpiryWarning(w.deps))!, "could not be verified");
    w.logged.length = 0;
    await main(["expiry"], w.deps);
    assertStringIncludes(w.logged[0], "warning");
  } finally {
    await cleanup(w);
  }
});

Deno.test("floor: raises the compiled-in minimum sequence to the published index's, never lowers it", async () => {
  const w = await withKey();
  try {
    const keysModule = join(w.dir, "keys.ts");
    const source = await Deno.readTextFile(new URL("src/build/runtime-channel-keys.ts", ROOT));
    assertEquals(channelMinSequenceIn(source), 0);
    await Deno.writeTextFile(keysModule, source);
    await main(["publish", TAG, "--out", join(w.dir, "out")], w.deps);
    await main(["floor", "--file", keysModule], w.deps);
    const raised = channelMinSequenceIn(await Deno.readTextFile(keysModule));
    assertEquals(raised, T / 1000);
    await Deno.writeTextFile(keysModule, withChannelMinSequence(source, raised + 10));
    w.logged.length = 0;
    await main(["floor", "--file", keysModule], w.deps);
    assertStringIncludes(w.logged.join("\n"), "stays");
    assert(!w.calls.some((c) => c.args.join(" ").includes(keysModule)));
    let threw = false;
    try {
      channelMinSequenceIn("export const X = 1;");
    } catch {
      threw = true;
    }
    assert(threw);
    w.logged.length = 0;
    await main(["floor"], { ...w.deps, keys: [] });
    assertStringIncludes(w.logged.join("\n"), "the floor stays");
  } finally {
    await cleanup(w);
  }
});

Deno.test("pin: a published document becomes the bundled pin, the old pin kept as rollback", async () => {
  const w = await withKey();
  try {
    const next = "3.0.0-denext.28";
    await main(["publish", `denext-runtime-v${next}`, "--out", join(w.dir, "out")], w.deps);
    await main(["pin", next], w.deps);
    const toolchain = JSON.parse(await Deno.readTextFile(w.deps.pinFiles!.toolchain));
    const desktop = JSON.parse(await Deno.readTextFile(w.deps.pinFiles!.desktop));
    assertEquals([toolchain.version, desktop.version], [next, next]);
    assertEquals([toolchain.rollback.version, desktop.rollback.version], [VERSION, VERSION]);
    assertEquals(toolchain.rollback.rollback, undefined, "a rollback never nests");
    await assertRejects(() => main(["pin", "3.0.0-denext.99"], w.deps), Error, "does not list");
    // A yanked release needs --allow-yanked.
    await main(["yank", next, "--reason", "broken", "--out", join(w.dir, "out")], w.deps);
    await assertRejects(() => main(["pin", next], w.deps), Error, "--allow-yanked");
    await main(["pin", next, "--allow-yanked"], w.deps);
    // No served copy verifies: refused.
    for (const url of [...w.served.keys()]) if (url.includes("/releases/")) w.served.delete(url);
    await assertRejects(
      () => main(["pin", next, "--allow-yanked"], w.deps),
      Error,
      "no served copy",
    );
  } finally {
    await cleanup(w);
  }
});

Deno.test("release-doc writes the document and the candidate toolchain pin", async () => {
  const w = await world();
  try {
    const out = join(w.dir, "doc.json");
    const pin = join(w.dir, "pin.json");
    await main(
      ["release-doc", TAG, "--out", out, "--toolchain-pin-out", pin, "--unverified"],
      w.deps,
    );
    const { entry } = await releaseEntryFor(bundledDocument(), {
      releasedAt: "2026-11-10T00:00:00Z",
      minDenext: "4.19.0",
    });
    await verifyReleaseDocument(await Deno.readTextFile(out), entry);
    assertEquals(JSON.parse(await Deno.readTextFile(pin)).version, VERSION);
    assertStringIncludes(w.logged.join("\n"), "(unverified)");
    w.logged.length = 0;
    await main(["release-doc", TAG], w.deps);
    assertStringIncludes(w.logged[0], '"toolchain"');
    await assertRejects(() => main(["nope"], w.deps), Error, "usage");
    await assertRejects(() => main(["publish"], w.deps), Error, "usage");
  } finally {
    await cleanup(w);
  }
});

Deno.test("releaseDocument: built from the release files, attested unless --unverified, without rollback", async () => {
  // A release without a cli section cannot be a channel release.
  const dir = await Deno.makeTempDir();
  try {
    const manifest = join(dir, "manifest.json");
    const sums = join(dir, "SHA256SUMS");
    await Deno.writeTextFile(manifest, "{}");
    await Deno.writeTextFile(sums, "");
    await assertRejects(
      () => releaseDocument(TAG, { manifest, sums, attest: () => Promise.resolve() }),
      Error,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const doc = documentOf(
    { ...structuredClone(toolchainPin), rollback: toolchainPin.rollback } as never,
    { ...structuredClone(desktopPin) } as never,
  );
  assertEquals("rollback" in doc.toolchain, false);
  assertEquals("rollback" in doc.desktop, false);
});

Deno.test("compatLegs reads the run's `compat (denext <v>)` jobs", () => {
  assertEquals(
    compatLegs([
      { name: "pick legs and runners", conclusion: "success" },
      { name: "compat (denext 4.20.1)", conclusion: "success" },
      { name: "compat (denext 4.19.0)", conclusion: "failure" },
      { name: "compat (denext 5.0.0-rc.1)", conclusion: null },
      { conclusion: "success" },
    ]),
    [
      { denext: "4.20.1", ok: true },
      { denext: "4.19.0", ok: false },
      { denext: "5.0.0-rc.1", ok: false },
    ],
  );
});

Deno.test("compatLegsFromTags: the latest stable release and the previous minor's last patch", () => {
  assertEquals(
    compatLegsFromTags([
      "v4.18.0",
      "v4.19.0",
      "v4.19.2",
      "v4.20.0",
      "v4.20.1",
      "v4.21.0-rc.1",
      "x",
      "",
    ]),
    [
      { denext: "4.20.1", tag: "v4.20.1", slot: "compat_0" },
      { denext: "4.19.2", tag: "v4.19.2", slot: "compat_1" },
    ],
  );
  assertEquals(compatLegsFromTags(["v5.0.0", "v4.20.1", "v4.9.0"]).map((l) => l.denext), [
    "5.0.0",
    "4.20.1",
  ]);
  assertEquals(compatLegsFromTags(["v4.20.0", "v4.20.1"]).map((l) => l.denext), ["4.20.1"]);
  assertEquals(compatLegsFromTags([]), []);
});

Deno.test("entries: canonical text, one per version, and the committed file is canonical", async () => {
  const { entry: a } = await releaseEntryFor(bundledDocument(), {
    releasedAt: "2026-11-10T00:00:00Z",
    minDenext: "4.19.0",
  });
  const { entry: b } = await releaseEntryFor(documentFor("3.0.0-denext.28"), {
    releasedAt: "2026-11-11T00:00:00Z",
    minDenext: "4.20.0",
  });
  assertEquals(readEntries({ releases: [a, b] }).map((e) => e.version), [b.version, a.version]);
  assertEquals(entriesText([a, b]), entriesText([b, a]));
  let msg = "";
  try {
    readEntries({ releases: [a, a] }, "f.json");
  } catch (err) {
    msg = (err as Error).message;
  }
  assertStringIncludes(msg, "listed twice");
  for (const bad of [null, {}, { releases: [{ version: "x" }] }]) {
    let threw = false;
    try {
      readEntries(bad, "f.json");
    } catch (err) {
      threw = (err as Error).message.startsWith("f.json:");
    }
    assert(threw, JSON.stringify(bad));
  }
  assertEquals(withEntry([a], b).added, true);
  assertEquals(withEntry([a], a).added, false);
  const committed = await Deno.readTextFile(new URL("security/runtime-channel.json", ROOT));
  assertEquals(committed, entriesText(readEntries(JSON.parse(committed))));
  // A published release the entries leave out is refused; with no published index nothing is.
  const channel: RuntimeChannel = freshRuntimeChannel([a], NOW);
  refuseDroppedReleases(null, []);
  refuseDroppedReleases(channel, [a, b]);
  let dropped = "";
  try {
    refuseDroppedReleases(channel, [b]);
  } catch (err) {
    dropped = (err as Error).message;
  }
  assertStringIncludes(dropped, a.version);
  // An index signed elsewhere is what readEntries would sign again.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  assert((await signRuntimeChannel(channel, [pair.privateKey])).signatures.length === 1);
});
