// scripts/runtime-revocations.ts (`deno task revocations`): keygen into the keychain without the
// secret ever reaching a command line or the output, signing that self-verifies against the
// compiled-in keys, and publishing to the web root (rsync) and the fork's orphan branch (gh api).
// Every process is faked: no keychain, host or GitHub is touched.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  entryFromFlags,
  KEYCHAIN_SERVICE,
  KEYS_MODULE,
  main,
  minSequenceIn,
  parseArgs,
  readSignedList,
  type RevocationsDeps,
  RSYNC_ROOT_ENV,
  type RunResult,
  withMinSequence,
} from "../scripts/runtime-revocations.ts";
import { REVOCATION_FLOOR } from "../scripts/release.ts";
import {
  freshRevocationList,
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
    await main(["sign", edited, "--out", out, "--no-publish"], f.deps);
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
    await Deno.writeTextFile(file, real);
    assertEquals(minSequenceIn(real), 0);
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
    assertEquals(minSequenceIn(withMinSequence(real, 42)), 42);
    assertEquals(withMinSequence(real, 42).replace(/= 42;/, "= 0;"), real);
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

/** `fn` throws an error whose message includes `text`. */
function assertThrowsMessage(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (err) {
    return assertStringIncludes((err as Error).message, text);
  }
  throw new Error("did not throw");
}
