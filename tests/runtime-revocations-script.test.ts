// scripts/runtime-revocations.ts (`deno task revocations`): keygen into the keychain without the
// secret ever reaching a command line or the output, signing that self-verifies against the
// compiled-in keys, and publishing to the web root (rsync) and the fork's orphan branch (gh api).
// Every process is faked: no keychain, host or GitHub is touched.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  canonicalEntries,
  canonicalEntriesText,
  checkedOutPins,
  entryFromFlags,
  KEYCHAIN_SERVICE,
  KEYS_MODULE,
  main,
  minSequenceIn,
  parseArgs,
  pinImpact,
  publishedExpiryWarning,
  readSignedList,
  type RevocationsDeps,
  RSYNC_ROOT_ENV,
  type RunResult,
  withMinSequence,
} from "../scripts/runtime-revocations.ts";
import { REVOCATION_FLOOR, warnRevocationExpiry } from "../scripts/release.ts";
import {
  decideRevocation,
  freshRevocationList,
  REVOCATION_MAX_BYTES,
  RevocationListError,
  type RuntimeRevocation,
  type RuntimeRevocationList,
  signRevocationList,
  verifyRevocationDocument,
} from "../src/build/runtime-revocations.ts";
import { toBase64 } from "../src/build/ota-signing.ts";

const NOW = new Date("2026-10-30T00:00:00Z");

/** A fake world: a keychain, the published copy, and every command run. */
interface Fake {
  deps: RevocationsDeps;
  calls: Array<{ cmd: string; args: string[]; stdin?: string }>;
  keychain: Map<string, string>;
  published: { text: string | null };
  logged: string[];
  /** The rsynced files' text. */
  web: string[];
  /** Mirror commits' parents. */
  mirror: Array<{ parents: unknown }>;
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout });

/** The fake `security`: `-i` stores an item from stdin, `find-generic-password` reads one. */
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

/** The fake GitHub git data API over one branch. */
function fakeGh(state: { branch: string | null; mirror: Fake["mirror"] }) {
  return (args: string[], stdin?: string): RunResult => {
    const [, , method, path] = args;
    const body = stdin ? JSON.parse(stdin) : undefined;
    if (method === "GET") {
      return state.branch
        ? ok(JSON.stringify({ object: { sha: state.branch } }))
        : { code: 1, stdout: "" };
    }
    if (path.endsWith("git/commits")) {
      state.mirror.push({ parents: body.parents });
      return ok(JSON.stringify({ sha: `c${state.mirror.length}` }));
    }
    if (path.includes("git/refs")) state.branch = body.sha;
    return ok(JSON.stringify({ sha: "s" }));
  };
}

function fake(over: Partial<RevocationsDeps> = {}, compiled?: string[]): Promise<Fake> {
  const keychain = new Map<string, string>();
  const calls: Fake["calls"] = [];
  const web: string[] = [];
  const published = { text: null as string | null };
  const logged: string[] = [];
  const gh = { branch: null as string | null, mirror: [] as Fake["mirror"] };
  const ghRun = fakeGh(gh);
  const rsync = async (args: string[]): Promise<RunResult> => {
    web.push(await Deno.readTextFile(join(args.at(-2)!.replace(/\/$/, ""), "revocations.json")));
    return ok();
  };
  const run = (cmd: string, args: string[], stdin?: string): Promise<RunResult> => {
    calls.push({ cmd, args, ...(stdin !== undefined ? { stdin } : {}) });
    if (cmd === "security") return Promise.resolve(fakeSecurity(keychain, args, stdin));
    if (cmd === "rsync") return rsync(args);
    if (cmd === "gh") return Promise.resolve(ghRun(args, stdin));
    return Promise.resolve({ code: 127, stdout: "" });
  };
  const deps: RevocationsDeps = {
    run,
    published: () => Promise.resolve(published.text),
    keys: compiled ?? [],
    now: () => NOW,
    env: (k) => (k === RSYNC_ROOT_ENV ? "host:/srv/www/" : undefined),
    log: (l) => void logged.push(l),
    ...over,
  };
  return Promise.resolve({ deps, calls, keychain, published, logged, web, mirror: gh.mirror });
}

/** keygen into the fake keychain; the public key printed is what verifies. */
async function withKey(over: Partial<RevocationsDeps> = {}): Promise<Fake & { pub: string }> {
  const f = await fake(over);
  await main(["keygen"], f.deps);
  const pub = f.logged.at(-1)!;
  // The key is compiled in from here on (what the maintainer pastes into the keys module).
  (f.deps as { keys: readonly string[] }).keys = [pub];
  f.logged.length = 0;
  return { ...f, pub };
}

Deno.test("keygen: the private key reaches the keychain through stdin only, never argv or output", async () => {
  const f = await fake();
  await main(["keygen", "--slot", "backup"], f.deps);
  const secret = f.keychain.get(`${KEYCHAIN_SERVICE}/backup`)!;
  assert(secret && secret.length > 100, "a PKCS#8 key stored");
  for (const c of f.calls) assert(!c.args.join(" ").includes(secret), "never on a command line");
  assert(!f.logged.join("\n").includes(secret), "never printed");
  const add = f.calls.find((c) => c.args[0] === "-i")!;
  assertStringIncludes(add.stdin!, secret);
  assertStringIncludes(f.logged.join("\n"), "backup slot of src/build/runtime-revocation-keys.ts");
  // A second keygen refuses to overwrite; --force replaces.
  await assertRejects(() => main(["keygen", "--slot", "backup"], f.deps), Error, "--force");
  await main(["keygen", "--slot", "backup", "--force"], f.deps);
  assert(f.keychain.get(`${KEYCHAIN_SERVICE}/backup`) !== secret);
  await assertRejects(() => main(["keygen", "--slot", "spare"], f.deps), Error, "--slot");
  // A keychain that refuses the item fails clearly.
  const broken = await fake({ run: () => Promise.resolve({ code: 1, stdout: "" }) });
  await assertRejects(() => main(["keygen"], broken.deps), Error, "storing the key");
});

Deno.test("init signs an empty list, writes it and publishes it to the web root and the mirror", async () => {
  const f = await withKey();
  const dir = await Deno.makeTempDir();
  try {
    const out = join(dir, "list.json");
    await main(["init", "--out", out], f.deps);
    const text = await Deno.readTextFile(out);
    const list = await verifyRevocationDocument(text, [f.pub], { now: NOW.getTime() });
    assertEquals(list?.revoked, []);
    assertEquals(list?.sequence, NOW.getTime() / 1000);
    assertEquals(f.web, [text], "rsynced as runtime/revocations.json");
    const rsync = f.calls.find((c) => c.cmd === "rsync")!;
    assertEquals(rsync.args.at(-1), "host:/srv/www/runtime/");
    assert(rsync.args.includes("-rtp"));
    assert(!rsync.args.some((arg) => arg.startsWith("--chmod")));
    assertEquals(f.mirror, [{ parents: [] }], "an orphan commit the first time");
    assertStringIncludes(f.logged.join("\n"), `published list #${list!.sequence}`);
    // Once published, init refuses (add / resign extend it).
    f.published.text = text;
    await assertRejects(() => main(["init", "--out", out], f.deps), Error, "already published");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A published list signed with the fake keychain's active key. */
async function publishedWith(f: Fake, list: RuntimeRevocationList): Promise<void> {
  const raw = f.keychain.get(`${KEYCHAIN_SERVICE}/active`)!;
  const der = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  f.published.text = JSON.stringify(await signRevocationList(list, key));
}

Deno.test("add appends (or replaces) an entry above the published sequence; resign --if-due waits", async () => {
  const f = await withKey();
  const dir = await Deno.makeTempDir();
  try {
    const out = join(dir, "list.json");
    const earlier = freshRevocationList([], new Date(NOW.getTime() - 86_400_000));
    await publishedWith(f, { ...earlier, sequence: NOW.getTime() / 1000 + 50 });
    await main([
      "add",
      "--component",
      "cli",
      "--version",
      "3.0.0-denext.3",
      "--targets",
      "x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu",
      "--reason",
      "crashes on start",
      "--advisory",
      "https://example.test/a",
      "--fixed-in",
      "denext 4.10.3",
      "--out",
      out,
      "--no-publish",
    ], f.deps);
    const list = (await verifyRevocationDocument(await Deno.readTextFile(out), [f.pub], {
      now: NOW.getTime(),
    }))!;
    assertEquals(list.sequence, NOW.getTime() / 1000 + 51, "above the published one");
    assertEquals(list.revoked, [{
      component: "cli",
      version: "3.0.0-denext.3",
      targets: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
      reason: "crashes on start",
      advisory: "https://example.test/a",
      fixedIn: "denext 4.10.3",
    }]);
    assertEquals(f.web, [], "--no-publish");
    // resign --if-due: 21 days left → nothing; past the 10-day mark → re-signed with the same entries.
    await publishedWith(f, list);
    await main(["resign", "--if-due", "--out", out], f.deps);
    assertStringIncludes(f.logged.at(-1)!, "not due yet");
    const late = { ...f.deps, now: () => new Date(NOW.getTime() + 40 * 86_400_000) };
    await main(["resign", "--if-due", "--out", out, "--no-publish"], late);
    const resigned = (await verifyRevocationDocument(await Deno.readTextFile(out), [f.pub], {
      now: late.now().getTime(),
    }))!;
    assertEquals(resigned.revoked, list.revoked);
    assert(resigned.sequence > list.sequence);
    // An EXPIRED published list is still re-signed (that is how it comes back).
    const lapsed = { ...f.deps, now: () => new Date(NOW.getTime() + 90 * 86_400_000) };
    await main(["resign", "--out", out, "--no-publish"], lapsed);
    // `sign` takes a hand-edited entries file.
    const edited = join(dir, "edited.json");
    await Deno.writeTextFile(edited, JSON.stringify({ revoked: [] }));
    // It replaces the published entries wholesale: leaving one out (un-revoking it) needs --force.
    await assertRejects(
      () => main(["sign", edited, "--out", out, "--no-publish"], f.deps),
      Error,
      "cli 3.0.0-denext.3, which the entries file leaves out",
    );
    await main(["sign", edited, "--out", out, "--no-publish", "--force"], f.deps);
    assertEquals(
      (await verifyRevocationDocument(await Deno.readTextFile(out), [f.pub], {
        now: NOW.getTime(),
      }))
        ?.revoked,
      [],
    );
    await Deno.writeTextFile(edited, "{}");
    await assertRejects(() => main(["sign", edited, "--no-publish"], f.deps), Error, "expected");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signing refuses a keychain key that is not compiled in, and nothing is published", async () => {
  const f = await withKey();
  const other = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const otherPub = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", other.publicKey)));
  const wrong = { ...f.deps, keys: [otherPub] };
  await assertRejects(
    () => main(["init", "--out", join(Deno.makeTempDirSync(), "x.json")], wrong),
    Error,
    "not one of them",
  );
  assertEquals(f.web, []);
  await assertRejects(() => main(["init"], { ...f.deps, keys: [] }), Error, "compiled in");
  // No key in the keychain at all.
  const empty = await fake({}, [f.pub]);
  await assertRejects(() => main(["init", "--no-publish"], empty.deps), Error, "keygen");
  // A keychain item that is not a key.
  empty.keychain.set(`${KEYCHAIN_SERVICE}/active`, "bm9wZQ==");
  await assertRejects(() => main(["init", "--no-publish"], empty.deps), Error, "not a P-256");
});

Deno.test("verify / publish / errors", async () => {
  const f = await withKey();
  const dir = await Deno.makeTempDir();
  try {
    const out = join(dir, "list.json");
    await main(["init", "--out", out, "--no-publish"], f.deps);
    f.published.text = await Deno.readTextFile(out);
    await main(["verify"], f.deps);
    assertStringIncludes(f.logged.at(-1)!, "list #");
    await main(["verify", out], f.deps);
    await main(["publish", out], f.deps);
    assertEquals(f.web.length, 1);
    // The second publish commits on top of the branch, never a force.
    await main(["publish", out], f.deps);
    assertEquals(f.mirror.at(-1), { parents: ["c1"] });
    // No rsync root configured: refused before anything moves.
    const noRoot = { ...f.deps, env: () => undefined };
    await assertRejects(() => main(["publish", out], noRoot), Error, RSYNC_ROOT_ENV);
    const rsyncFails = {
      ...f.deps,
      run: (cmd: string, args: string[], stdin?: string) =>
        cmd === "rsync" ? Promise.resolve({ code: 1, stdout: "" }) : f.deps.run(cmd, args, stdin),
    };
    await assertRejects(() => main(["publish", out], rsyncFails), Error, "rsync");
    const ghFails = {
      ...f.deps,
      run: (cmd: string, args: string[], stdin?: string) =>
        cmd === "gh" ? Promise.resolve({ code: 1, stdout: "" }) : f.deps.run(cmd, args, stdin),
    };
    await assertRejects(() => main(["publish", out], ghFails), Error, "could not commit");
    // Nothing published: verify, add and resign say so.
    f.published.text = null;
    await assertRejects(() => main(["verify"], f.deps), Error, "no published list");
    await assertRejects(
      () => main(["add", "--component", "cli", "--version", "1", "--reason", "r"], f.deps),
      Error,
      "no published list",
    );
    await assertRejects(() => main(["resign"], f.deps), Error, "could not read");
    await main(["resign"], { ...f.deps, keys: [] });
    assertStringIncludes(f.logged.at(-1)!, "nothing to re-sign");
    await assertRejects(() => main(["nope"], f.deps), Error, "usage");
    await assertRejects(() => main(["sign"], f.deps), Error, "usage");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entryFromFlags / parseArgs / readSignedList", async () => {
  assertEquals(parseArgs(["add", "--x", "1", "--y", "--z", "v", "pos"]), {
    positionals: ["add", "pos"],
    flags: { x: "1", y: true, z: "v" },
  });
  for (
    const [flags, msg] of [
      [{}, "--component"],
      [{ component: "cli" }, "--version"],
      [{ component: "cli", version: "1" }, "--reason"],
    ] as const
  ) {
    let caught = "";
    try {
      entryFromFlags(flags as Record<string, string>);
    } catch (err) {
      caught = (err as Error).message;
    }
    assertStringIncludes(caught, msg);
  }
  assertEquals(entryFromFlags({ component: "desktop", version: "1", reason: "r" }), {
    component: "desktop",
    version: "1",
    reason: "r",
  });
  // readSignedList: a list of an unknown schema is refused.
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const signed = JSON.stringify({ ...freshRevocationList([], NOW), schema: 2 });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode("denext-runtime-revocations-v1\n" + signed),
  );
  const doc = JSON.stringify({ signed, signature: toBase64(new Uint8Array(sig)) });
  await assertRejects(() => readSignedList(doc, [pub], NOW), Error, "schema");
  await assertRejects(() => readSignedList("{}", [pub], NOW));
});

Deno.test("floor raises the compiled-in minimum sequence to the published list's, never lowers it", async () => {
  const f = await withKey();
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "keys.ts");
    // The real module declares it in the shape `floor` rewrites.
    const real = await Deno.readTextFile(new URL(`../${KEYS_MODULE}`, import.meta.url));
    assert(minSequenceIn(real) >= 0);
    // From a floor of 0 whatever a past release raised it to.
    const unraised = real.replace(/(MIN_SEQUENCE: number = )\d+/, (_, head) => `${head}0`);
    await Deno.writeTextFile(file, unraised);
    assertEquals(minSequenceIn(unraised), 0);
    const list = freshRevocationList([], NOW);
    await publishedWith(f, list);
    await main(["floor", "--file", file], f.deps);
    assertEquals(minSequenceIn(await Deno.readTextFile(file)), list.sequence);
    assertStringIncludes(f.logged.at(-1)!, `#0 → #${list.sequence}`);
    // An older published copy (a stale mirror) never lowers it.
    await publishedWith(f, { ...list, sequence: list.sequence - 10 });
    await main(["floor", "--file", file], f.deps);
    assertEquals(minSequenceIn(await Deno.readTextFile(file)), list.sequence);
    assertStringIncludes(f.logged.at(-1)!, "stays");
    // Nothing published: an error (the release warns and keeps the previous floor).
    f.published.text = null;
    await assertRejects(() => main(["floor", "--file", file], f.deps), Error, "published list");
    // No key compiled in: nothing to do.
    const keyless = await fake();
    await main(["floor", "--file", file], keyless.deps);
    assertStringIncludes(keyless.logged.at(-1)!, "floor stays");
    // The rewrite is exact; a module without the constant is refused.
    assertEquals(minSequenceIn(withMinSequence(unraised, 42)), 42);
    assertEquals(withMinSequence(unraised, 42).replace(/= 42;/, "= 0;"), unraised);
    assertThrowsMessage(
      () => minSequenceIn("export const X = 1;"),
      "RUNTIME_REVOCATION_MIN_SEQUENCE",
    );
    // `deno task release` runs exactly this command at step 1c.
    assertEquals(REVOCATION_FLOOR.slice(-2), ["scripts/runtime-revocations.ts", "floor"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The repository's entries file: the list a maintainer signs. */
const COMMITTED = fromFileUrl(new URL("../security/runtime-revocations.json", import.meta.url));

Deno.test("canonical: one byte form for the same entries; malformed, unknown and duplicate entries refused", async () => {
  const f = await fake();
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "entries.json");
    const a = {
      fixedIn: "denext 9",
      reason: "r",
      version: "3.0.0-rc.2",
      component: "desktop",
      targets: ["z-target", "a-target", "z-target"],
      extra: "dropped",
    };
    const b = { component: "cli", version: "3.0.0-denext.1", reason: "r" };
    const c = { component: "cli", version: "3.0.0-denext.10", reason: "r" };
    const d = { component: "cli", version: "3.0.0-rc.6", reason: "r" };
    await Deno.writeTextFile(file, JSON.stringify([a, b, d, c]));
    await assertRejects(() => main(["canonical", file, "--check"], f.deps), Error, "canonical");
    await main(["canonical", file], f.deps);
    const text = await Deno.readTextFile(file);
    // cli before desktop, the newest first (denext.N above every rc), fields in a fixed order.
    assertEquals(JSON.parse(text).revoked, [
      { component: "cli", version: "3.0.0-denext.10", reason: "r" },
      { component: "cli", version: "3.0.0-denext.1", reason: "r" },
      { component: "cli", version: "3.0.0-rc.6", reason: "r" },
      {
        component: "desktop",
        version: "3.0.0-rc.2",
        targets: ["a-target", "z-target"],
        reason: "r",
        fixedIn: "denext 9",
      },
    ]);
    assertEquals(Object.keys(JSON.parse(text).revoked[3]), [
      "component",
      "version",
      "targets",
      "reason",
      "fixedIn",
    ]);
    assertEquals(canonicalEntriesText(canonicalEntries({ revoked: [c, d, a, b] })), text);
    await main(["canonical", file, "--check"], f.deps);
    assertStringIncludes(f.logged.at(-1)!, "is in canonical form");
    const refused: Array<[unknown, string]> = [
      [{}, "expected a list"],
      [[{ component: "cli", reason: "r" }], "no version"],
      [[{ component: "cli", version: "1" }], "no reason"],
      [[{ component: "cli", version: "1", reason: "r", advisory: "http://x" }], "bad advisory"],
      [[{ component: "browser", version: "1", reason: "r" }], "cli or desktop"],
      [[b, { ...b, reason: "again" }], "listed twice"],
    ];
    for (const [raw, msg] of refused) assertThrowsMessage(() => canonicalEntries(raw), msg);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** The published advisories each committed entry must cite, by version (fork GHSAs). */
function committedAdvisory(e: RuntimeRevocation): string {
  const n = /^3\.0\.0-denext\.(\d+)$/.exec(e.version)?.[1];
  const denext = n === undefined ? 0 : Number(n);
  if (denext === 8) return "GHSA-v7wx-2v39-pxcf";
  if (e.component === "desktop") return "GHSA-fp5v-5vcj-35wj";
  return denext >= 3 ? "GHSA-6p3v-hr2g-w4hx" : "GHSA-qr84-w8xw-f7r4";
}

Deno.test("the committed list: canonical, every release through 3.0.0-denext.8, and no pin loses its footing", async () => {
  const text = await Deno.readTextFile(COMMITTED);
  const entries = canonicalEntries(JSON.parse(text), COMMITTED);
  assertEquals(canonicalEntriesText(entries), text, "`deno task revocations canonical` leaves it");
  // Both components of every released runtime before 3.0.0-denext.12 (no 9-11 were released).
  const versions = [
    ...Array.from({ length: 22 }, (_, i) => `2.9.7-denext.${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `3.0.0-rc.${i + 1}`),
    ...[1, 2, 3, 5, 6, 7, 8].map((n) => `3.0.0-denext.${n}`),
  ];
  for (const component of ["cli", "desktop"] as const) {
    assertEquals(
      entries.filter((e) => e.component === component).map((e) => e.version).sort(),
      [...versions].sort(),
      component,
    );
  }
  for (const e of entries) {
    assertEquals(e.targets, undefined, `${e.version}: every target`);
    assertEquals(e.fixedIn, "denext 4.13.0 (runtime 3.0.0-denext.12)");
    assertEquals(
      e.advisory,
      `https://github.com/Brainwires/deno/security/advisories/${committedAdvisory(e)}`,
      `${e.component} ${e.version}`,
    );
  }
  // The checked-out pins and their rollbacks stay runnable: none is revoked.
  const pins = checkedOutPins();
  const impact = pinImpact(entries, pins);
  assert(impact.ok, impact.lines.join("\n"));
  for (const line of impact.lines) assert(!line.includes("is revoked"), line);
  const list = { ...freshRevocationList(entries, NOW) };
  for (const p of pins) {
    assertEquals(decideRevocation(list, [{ ...p, triple: "x86_64-unknown-linux-gnu" }]).hit, null);
  }
  // The released denexts that read the list (4.11.8 and later): 4.13.x keep running their pin;
  // 4.11.8-4.12.0 (pins 3.0.0-denext.7 / .8, rollbacks .6 / .7) warn, with no fallback — the fix
  // is `denext upgrade`.
  const released: Array<[string, string, string, boolean]> = [
    ["4.13.1", "3.0.0-denext.13", "3.0.0-denext.12", true],
    ["4.13.0", "3.0.0-denext.12", "3.0.0-denext.8", true],
    ["4.12.0", "3.0.0-denext.8", "3.0.0-denext.7", false],
    ["4.11.13", "3.0.0-denext.7", "3.0.0-denext.6", false],
  ];
  for (const [denext, version, rollback, runs] of released) {
    for (const component of ["cli", "desktop"] as const) {
      const d = decideRevocation(list, [{ component, version, rollback, triple: undefined }]);
      assertEquals(d.hit === null, runs, `denext ${denext} ${component}`);
      assertEquals(d.useRollback, false, `denext ${denext} ${component}: no revoked fallback`);
    }
  }
});

Deno.test("sign: the committed list signed with a test key — the shipped verifier takes it, and refuses it tampered, expired or replayed", async () => {
  const f = await withKey();
  const dir = await Deno.makeTempDir();
  try {
    const out = join(dir, "signed.json");
    await main(["sign", COMMITTED, "--out", out, "--no-publish"], f.deps);
    assertStringIncludes(f.logged.join("\n"), "70 revoked; the checked-out pins:");
    assert(!f.logged.some((l) => l.includes("WARNING")), f.logged.join("\n"));
    assertEquals(f.web, [], "--no-publish publishes nothing");
    const text = await Deno.readTextFile(out);
    assert(new TextEncoder().encode(text).byteLength < REVOCATION_MAX_BYTES / 2, "room to grow");
    const now = NOW.getTime();
    const list = (await verifyRevocationDocument(text, [f.pub], { now }))!;
    assertEquals(list.revoked, canonicalEntries(JSON.parse(await Deno.readTextFile(COMMITTED))));
    assertEquals(list.sequence, now / 1000);
    // Not under the compiled-in keys: the test key signs nothing a user would take.
    await refusedAs(text, [], { now }, "signature");
    // Tampered: one revocation dropped, or the signature's bytes changed.
    const envelope = JSON.parse(text);
    const payload = JSON.parse(envelope.signed);
    const dropped = JSON.stringify({ ...payload, revoked: payload.revoked.slice(1) });
    await refusedAs(
      JSON.stringify({ ...envelope, signed: dropped }),
      [f.pub],
      { now },
      "signature",
    );
    const sig = envelope.signature as string;
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await refusedAs(
      JSON.stringify({ ...envelope, signature: flipped }),
      [f.pub],
      { now },
      "signature",
    );
    // Expired at its expiresAt; replayed below a sequence already seen.
    await refusedAs(text, [f.pub], { now: Date.parse(list.expiresAt) }, "expired");
    await refusedAs(text, [f.pub], { now, minSequence: list.sequence + 1 }, "replayed");
    // And a re-sign of the same file is a fresh, higher sequence the old one can't replay.
    f.published.text = text;
    const later = { ...f.deps, now: () => new Date(now + 3600_000) };
    await main(["sign", COMMITTED, "--out", out, "--no-publish"], later);
    const next = (await verifyRevocationDocument(await Deno.readTextFile(out), [f.pub], {
      now: now + 3600_000,
      minSequence: list.sequence,
    }))!;
    assert(next.sequence > list.sequence);
    await refusedAs(text, [f.pub], { now: now + 3600_000, minSequence: next.sequence }, "replayed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pinImpact: a revoked pin rolls back, or warns when its rollback is revoked or absent", () => {
  const e = (component: "cli" | "desktop", version: string): RuntimeRevocation => ({
    component,
    version,
    reason: "r",
  });
  const pins = [
    { component: "cli" as const, version: "b", rollback: "a" },
    { component: "desktop" as const, version: "b", rollback: null },
  ];
  assertEquals(pinImpact([e("cli", "a")], pins), {
    ok: true,
    lines: ["  cli pin b: not revoked (its rollback a is revoked)", "  desktop pin b: not revoked"],
  });
  const one = pinImpact([e("cli", "b")], pins);
  assertEquals(one.ok, false);
  assertStringIncludes(one.lines[0], "denext runs its rollback a");
  const none = pinImpact([e("cli", "b"), e("cli", "a"), e("desktop", "b")], pins);
  assertStringIncludes(none.lines[0], "so is its rollback (a)");
  assertStringIncludes(none.lines[1], "so is its rollback (none)");
});

/** `text` is refused by the shipped verifier with `code`. */
async function refusedAs(
  text: string,
  keys: string[],
  options: { now: number; minSequence?: number },
  code: string,
): Promise<void> {
  const err = await assertRejects(() => verifyRevocationDocument(text, keys, options));
  assert(err instanceof RevocationListError, String(err));
  assertEquals(err.code, code);
}

/** `fn` throws an error whose message includes `text`. */
function assertThrowsMessage(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (err) {
    return assertStringIncludes((err as Error).message, text);
  }
  throw new Error("did not throw");
}

Deno.test("expiry: the release gate warns before the published list lapses, never throws", async () => {
  const DAY = 86_400_000;
  const f = await withKey();
  // No key compiled in: nothing to keep fresh.
  assertEquals(await publishedExpiryWarning({ ...f.deps, keys: [] }), null);
  // Nothing readable (offline, or none published).
  assertStringIncludes((await publishedExpiryWarning(f.deps))!, "list could be read");
  // Signed 5 days ago: 16 days left, quiet.
  const at = (daysAgo: number) => freshRevocationList([], new Date(NOW.getTime() - daysAgo * DAY));
  await publishedWith(f, at(5));
  assertEquals(await publishedExpiryWarning(f.deps), null);
  await main(["expiry"], f.deps);
  assertEquals(f.logged.at(-1), "the published list is not near expiry");
  // Signed 15 days ago: 6 days left, inside the 10-day margin.
  const due = at(15);
  await publishedWith(f, due);
  const soon = (await publishedExpiryWarning(f.deps))!;
  assertStringIncludes(soon, `list #${due.sequence} expires ${due.expiresAt} (in 6 days)`);
  assertStringIncludes(soon, "deno task revocations resign");
  await main(["expiry"], f.deps);
  assertStringIncludes(f.logged.at(-1)!, "warning — the published revoked-runtimes list");
  // Signed 22 days ago: lapsed.
  const lapsed = at(22);
  await publishedWith(f, lapsed);
  assertStringIncludes(
    (await publishedExpiryWarning(f.deps))!,
    `list #${lapsed.sequence} EXPIRED at ${lapsed.expiresAt}`,
  );
  // A list signed by a key this checkout doesn't carry: reported, not thrown.
  f.published.text = f.published.text!.replace(/"signature":"[^"]+"/, '"signature":"AAAA"');
  assertStringIncludes((await publishedExpiryWarning(f.deps))!, "could not be verified");
  // The release step prints the warning and carries on.
  const warned: string[] = [];
  assertEquals(await warnRevocationExpiry(() => Promise.resolve("x"), (l) => warned.push(l)), "x");
  assertEquals(warned, ["0b. revoked-runtimes list: warning — x"]);
  assertEquals(
    await warnRevocationExpiry(() => Promise.reject(new Error("boom")), (l) => warned.push(l)),
    "could not check its expiry (Error: boom)",
  );
  assertEquals(
    await warnRevocationExpiry(() => Promise.resolve(null), (l) => warned.push(l)),
    null,
  );
  assertEquals(warned.length, 2);
});
