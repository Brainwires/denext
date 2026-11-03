// The maintainers' side of the signed revoked-runtimes list (src/build/runtime-revocations.ts):
//
//   deno task revocations keygen [--slot active|backup] [--force]
//       a new ECDSA P-256 key pair: the private key goes straight into the login keychain (a
//       generic password, service `denext-runtime-revocations`, account = the slot) and is never
//       printed or written to disk; the public key is printed, to paste into its slot in
//       src/build/runtime-revocation-keys.ts
//   deno task revocations init [--no-publish]           the first list (nothing revoked)
//   deno task revocations add --component cli|desktop --version <v> --reason <text>
//       [--targets <triple,…>] [--advisory <https url>] [--fixed-in <text>] [--no-publish]
//   deno task revocations sign <payload.json> [--no-publish]   sign a hand-edited list's entries
//   deno task revocations resign [--if-due] [--no-publish]     fresh expiry + sequence, same entries
//   deno task revocations verify [<file>]               a file, or the published copies
//   deno task revocations publish <file>                upload a signed list
//   deno task revocations floor [--file <keys module>]  raise the compiled-in minimum sequence
//       (RUNTIME_REVOCATION_MIN_SEQUENCE in src/build/runtime-revocation-keys.ts) to the published
//       list's: `deno task release` runs it before the release commit, so every release refuses
//       any list older than the one current when it was cut
//
// Every signing command takes the key from the keychain (`security find-generic-password -w`),
// signs a payload with a fresh `issuedAt`, a 21-day `expiresAt` and a `sequence` above the
// published one, verifies the result against the public keys COMPILED INTO this checkout (a key
// that isn't one of them is refused before anything is published), writes it to
// `.denext/runtime-revocations.json` (`--out` changes it) and publishes it unless `--no-publish`:
//
//   1. rsync to `$DENEXT_REVOCATIONS_RSYNC_ROOT/runtime/revocations.json` (the denext.dev web
//      root, `host:/path`), served as https://denext.dev/runtime/revocations.json;
//   2. a commit of `runtime-revocations.json` on the orphan branch `denext-revocations` of
//      Brainwires/deno (the GitHub CLI's git data API; never a force push), the mirror.
//
// `resign --if-due` does nothing while 10 days or more remain: `deno task release` runs it.

import { join } from "@std/path";
import {
  freshRevocationList,
  REVOCATION_URLS,
  type RevocationEnvelope,
  revocationKeys,
  RevocationListError,
  revocationResignDue,
  type RuntimeComponent,
  type RuntimeRevocation,
  type RuntimeRevocationList,
  signRevocationList,
  verifyRevocationDocument,
} from "../src/build/runtime-revocations.ts";
import { fromBase64, toBase64 } from "../src/build/ota-signing.ts";

/** The keychain item's service. */
export const KEYCHAIN_SERVICE = "denext-runtime-revocations";
/** The mirror: the fork and its orphan branch. */
const MIRROR_REPO = "Brainwires/deno";
const MIRROR_BRANCH = "denext-revocations";
const MIRROR_FILE = "runtime-revocations.json";
/** Where the web root to rsync into is named. */
export const RSYNC_ROOT_ENV = "DENEXT_REVOCATIONS_RSYNC_ROOT";
/** The default output file (git-ignored). */
const DEFAULT_OUT = ".denext/runtime-revocations.json";
/** The module the compiled-in floor lives in (`floor`). */
export const KEYS_MODULE = "src/build/runtime-revocation-keys.ts";
const FLOOR_RE = /(export const RUNTIME_REVOCATION_MIN_SEQUENCE: number = )(\d+);/;

/** A finished command: its exit code and standard output. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
}

/** The process seams (tests pass fakes; nothing here reaches a real keychain or host then). */
export interface RevocationsDeps {
  /** Run `cmd` with `args`, `stdin` written to it; stdout captured, stderr inherited. */
  readonly run: (cmd: string, args: string[], stdin?: string) => Promise<RunResult>;
  /** The published list's text, or `null` (default: the primary URL, then the mirror). */
  readonly published: () => Promise<string | null>;
  /** The public keys a signed list must verify with (default: the compiled-in ones). */
  readonly keys: readonly string[];
  readonly now: () => Date;
  readonly env: (name: string) => string | undefined;
  readonly log: (line: string) => void;
}

/** A refusal: printed as one line, exit 1. */
export class RevocationsCommandError extends Error {
  override name = "RevocationsCommandError";
}

const fail = (message: string): never => {
  throw new RevocationsCommandError(message);
};

/** Run a command for real (stderr inherited, so `security` / `gh` can say what failed). */
async function realRun(cmd: string, args: string[], stdin?: string): Promise<RunResult> {
  const piped = stdin !== undefined;
  const child = new Deno.Command(cmd, {
    args,
    stdin: piped ? "piped" : "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  // Fed as a stream, so a secret on stdin never touches a command line.
  if (piped) await ReadableStream.from([new TextEncoder().encode(stdin)]).pipeTo(child.stdin);
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

/** The published list's text: the first URL that answers 200. */
async function realPublished(): Promise<string | null> {
  for (const url of REVOCATION_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return await res.text();
      await res.body?.cancel();
    } catch {
      // the next source
    }
  }
  return null;
}

/** The real process. */
export function realDeps(): RevocationsDeps {
  return {
    run: realRun,
    published: realPublished,
    keys: revocationKeys(),
    now: () => new Date(),
    env: (name) => Deno.env.get(name),
    log: (line) => console.log(line),
  };
}

// ---------------------------------------------------------------------------------------------
// Keys.

/** A keychain slot: `active` signs; `backup` is kept offline for a rotation. */
function slotOf(raw: unknown): string {
  const slot = typeof raw === "string" ? raw : "active";
  if (slot !== "active" && slot !== "backup") fail(`--slot must be active or backup (got ${slot})`);
  return slot;
}

/**
 * Make a key pair: the private key (base64 PKCS#8) into the keychain through `security -i`'s
 * stdin — never on a command line, never printed — and the public key returned.
 *
 * @param deps Seams.
 * @param slot `active` or `backup`.
 * @param force Replace an existing item.
 * @returns The public key (base64 SPKI).
 */
export async function keygen(deps: RevocationsDeps, slot: string, force: boolean): Promise<string> {
  const exists = await deps.run("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    slot,
  ]);
  if (exists.code === 0 && !force) {
    fail(`the keychain already holds ${KEYCHAIN_SERVICE} / ${slot}; --force replaces it`);
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = toBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const spki = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const add = await deps.run(
    "security",
    ["-i"],
    `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${slot} -w ${pkcs8}\n`,
  );
  if (add.code !== 0) fail("storing the key in the keychain failed (security -i)");
  return spki;
}

/** The signing key from the keychain (`active` slot unless `slot`). */
async function signingKey(deps: RevocationsDeps, slot = "active"): Promise<CryptoKey> {
  const got = await deps.run("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    slot,
    "-w",
  ]);
  if (got.code !== 0) {
    fail(
      `no ${KEYCHAIN_SERVICE} / ${slot} key in the keychain (\`deno task revocations keygen\`)`,
    );
  }
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      fromBase64(got.stdout.trim()) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    return fail(`the keychain item ${KEYCHAIN_SERVICE} / ${slot} is not a P-256 private key`);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading and signing.

/**
 * The list `text` holds, verified against `keys` — an expired one too (re-signing it is how it
 * comes back), but never one with a bad signature.
 *
 * @param text The document.
 * @param keys The public keys.
 * @param now The clock.
 * @returns The list.
 */
export async function readSignedList(
  text: string,
  keys: readonly string[],
  now: Date,
): Promise<RuntimeRevocationList> {
  try {
    const list = await verifyRevocationDocument(text, keys, { now: now.getTime() });
    return list ?? fail("the published list has a schema this denext does not know");
  } catch (err) {
    if (err instanceof RevocationListError && err.code === "expired") return err.list!;
    throw err;
  }
}

/** The published list, verified; `null` when none is published (or it can't be read). */
async function publishedList(deps: RevocationsDeps): Promise<RuntimeRevocationList | null> {
  const text = await deps.published();
  return text === null ? null : await readSignedList(text, deps.keys, deps.now());
}

/** Sign `revoked` above `previous`, then verify it against the compiled-in keys. */
export async function signFresh(
  deps: RevocationsDeps,
  revoked: readonly RuntimeRevocation[],
  previous: RuntimeRevocationList | null,
): Promise<{ text: string; list: RuntimeRevocationList }> {
  if (deps.keys.length === 0) {
    fail("no revocation public key is compiled in (src/build/runtime-revocation-keys.ts)");
  }
  const list = freshRevocationList(revoked, deps.now(), previous ?? undefined);
  const envelope: RevocationEnvelope = await signRevocationList(list, await signingKey(deps));
  const text = JSON.stringify(envelope) + "\n";
  try {
    await verifyRevocationDocument(text, deps.keys, { now: deps.now().getTime() });
  } catch (err) {
    fail(
      `the signed list does not verify against the compiled-in public keys (${
        (err as Error).message
      }): the keychain key is not one of them`,
    );
  }
  return { text, list };
}

/** One revocation from `add`'s flags. */
export function entryFromFlags(flags: Record<string, string | boolean>): RuntimeRevocation {
  const component = flags.component;
  if (component !== "cli" && component !== "desktop") fail("--component must be cli or desktop");
  const str = (name: string) => typeof flags[name] === "string" ? flags[name] as string : undefined;
  const version = str("version") ?? fail("--version <runtime version> is required");
  const reason = str("reason") ?? fail("--reason <text> is required");
  const targets = str("targets")?.split(",").map((t) => t.trim()).filter(Boolean);
  return {
    component: component as RuntimeComponent,
    version,
    reason,
    ...(targets?.length ? { targets } : {}),
    ...(str("advisory") ? { advisory: str("advisory") } : {}),
    ...(str("fixed-in") ? { fixedIn: str("fixed-in") } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Publishing.

/** `gh api` with a JSON body; its JSON answer. */
async function ghApi(
  deps: RevocationsDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  const args = ["api", "-X", method, `repos/${MIRROR_REPO}/${path}`];
  const res = await deps.run(
    "gh",
    body === undefined ? args : [...args, "--input", "-"],
    body === undefined ? undefined : JSON.stringify(body),
  );
  if (res.code !== 0) return null;
  return JSON.parse(res.stdout || "{}");
}

/** Commit `text` as the orphan branch's file (a new commit on top of it; created when missing). */
async function publishMirror(deps: RevocationsDeps, text: string, sequence: number): Promise<void> {
  const ref = await ghApi(deps, "GET", `git/ref/heads/${MIRROR_BRANCH}`);
  const parent = (ref?.object as { sha?: string } | undefined)?.sha;
  const blob = await ghApi(deps, "POST", "git/blobs", {
    content: toBase64(new TextEncoder().encode(text)),
    encoding: "base64",
  });
  const tree = blob && await ghApi(deps, "POST", "git/trees", {
    tree: [{ path: MIRROR_FILE, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const commit = tree && await ghApi(deps, "POST", "git/commits", {
    message: `revocations: sequence ${sequence}`,
    tree: tree.sha,
    parents: parent ? [parent] : [],
  });
  if (!commit) fail(`could not commit the list to ${MIRROR_REPO}@${MIRROR_BRANCH} (gh api)`);
  const moved = parent
    ? await ghApi(deps, "PATCH", `git/refs/heads/${MIRROR_BRANCH}`, { sha: commit!.sha })
    : await ghApi(deps, "POST", "git/refs", {
      ref: `refs/heads/${MIRROR_BRANCH}`,
      sha: commit!.sha,
    });
  if (!moved) fail(`could not move ${MIRROR_REPO}@${MIRROR_BRANCH} to the new commit (gh api)`);
}

/** rsync `text` to `<root>/runtime/revocations.json` (world-readable). */
async function publishWeb(deps: RevocationsDeps, text: string): Promise<void> {
  const root = deps.env(RSYNC_ROOT_ENV) ??
    fail(`set ${RSYNC_ROOT_ENV}=<host>:<web root> (where denext.dev is served from)`);
  const tmp = await Deno.makeTempDir({ prefix: "denext-revocations-" });
  try {
    await Deno.mkdir(join(tmp, "runtime"));
    await Deno.writeTextFile(join(tmp, "runtime", "revocations.json"), text);
    // The modes travel with -p: macOS's openrsync has no --chmod.
    await Deno.chmod(join(tmp, "runtime"), 0o755);
    await Deno.chmod(join(tmp, "runtime", "revocations.json"), 0o644);
    const res = await deps.run("rsync", [
      "-rtp",
      `${join(tmp, "runtime")}/`,
      `${root.replace(/\/+$/, "")}/runtime/`,
    ]);
    if (res.code !== 0) fail(`rsync to ${root} failed`);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/**
 * Publish a signed list: denext.dev first, then the mirror. The list is verified against the
 * compiled-in keys first, so nothing unverifiable is ever served.
 *
 * @param deps Seams.
 * @param text The signed document.
 */
export async function publish(deps: RevocationsDeps, text: string): Promise<void> {
  const list = await verifyRevocationDocument(text, deps.keys, { now: deps.now().getTime() });
  if (!list) fail("refusing to publish a list of an unknown schema");
  await publishWeb(deps, text);
  await publishMirror(deps, text, list!.sequence);
  deps.log(`published list #${list!.sequence} (expires ${list!.expiresAt})`);
}

// ---------------------------------------------------------------------------------------------
// The commands.

/** Parsed `--flag value` / `--flag` arguments and the positionals. */
export function parseArgs(args: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = args[i + 1];
    const valued = next !== undefined && !next.startsWith("--");
    flags[name] = valued ? next : true;
    if (valued) i++;
  }
  return { positionals, flags };
}

/** Write the signed list, then publish it unless `--no-publish`. */
async function writeAndPublish(
  deps: RevocationsDeps,
  signed: { text: string; list: RuntimeRevocationList },
  flags: Record<string, string | boolean>,
): Promise<void> {
  const out = typeof flags.out === "string" ? flags.out : DEFAULT_OUT;
  await Deno.mkdir(join(out, ".."), { recursive: true });
  await Deno.writeTextFile(out, signed.text);
  deps.log(
    `wrote ${out}: list #${signed.list.sequence}, ${signed.list.revoked.length} revoked, ` +
      `expires ${signed.list.expiresAt}`,
  );
  if (flags["no-publish"] !== true) await publish(deps, signed.text);
}

/** `init`: the first list, nothing revoked; refused once one is published. */
async function init(deps: RevocationsDeps, flags: Record<string, string | boolean>) {
  const current = await publishedList(deps);
  if (current && flags.force !== true) {
    fail(`a list is already published (#${current.sequence}); use add / resign`);
  }
  await writeAndPublish(deps, await signFresh(deps, [], current), flags);
}

/** `add`: the published list plus one entry (replacing an entry for the same release). */
async function add(deps: RevocationsDeps, flags: Record<string, string | boolean>) {
  const entry = entryFromFlags(flags);
  const current = await publishedList(deps) ??
    fail("no published list to add to (offline, or `deno task revocations init` first)");
  const revoked = [
    ...current.revoked.filter((e) =>
      e.component !== entry.component || e.version !== entry.version
    ),
    entry,
  ];
  await writeAndPublish(deps, await signFresh(deps, revoked, current), flags);
}

/** `resign`: the published entries, fresh expiry and sequence; `--if-due` only near expiry. */
async function resign(deps: RevocationsDeps, flags: Record<string, string | boolean>) {
  if (deps.keys.length === 0) {
    return deps.log("no revocation public key is compiled in: nothing to re-sign");
  }
  const current = await publishedList(deps) ??
    fail("could not read the published list (offline, or none published yet: `init`)");
  if (flags["if-due"] === true && !revocationResignDue(current, deps.now().getTime())) {
    return deps.log(`list #${current.sequence} expires ${current.expiresAt}: not due yet`);
  }
  await writeAndPublish(deps, await signFresh(deps, current.revoked, current), flags);
}

/** `sign <payload.json>`: a hand-edited list's entries, signed above the published one. */
async function sign(deps: RevocationsDeps, file: string, flags: Record<string, string | boolean>) {
  const raw = JSON.parse(await Deno.readTextFile(file));
  const entries = Array.isArray(raw) ? raw : raw?.revoked;
  if (!Array.isArray(entries)) fail(`${file}: expected a list of entries or { revoked: [...] }`);
  const current = await publishedList(deps).catch(() => null);
  await writeAndPublish(deps, await signFresh(deps, entries, current), flags);
}

/** `verify [<file>]`: a file, or the published copy, against the compiled-in keys. */
async function verify(deps: RevocationsDeps, file: string | undefined) {
  const text = file ? await Deno.readTextFile(file) : await deps.published();
  if (text === null) fail("no published list could be read");
  const list = await verifyRevocationDocument(text!, deps.keys, { now: deps.now().getTime() });
  if (!list) fail("the list has a schema this denext does not know");
  deps.log(`list #${list!.sequence}: issued ${list!.issuedAt}, expires ${list!.expiresAt}`);
  for (const e of list!.revoked) {
    deps.log(
      `  ${e.component} ${e.version} (${e.targets?.join(", ") ?? "every target"}): ${e.reason}`,
    );
  }
}

/**
 * The compiled-in minimum sequence `source` (the keys module) declares.
 *
 * @param source The module's text.
 * @returns The sequence.
 */
export function minSequenceIn(source: string): number {
  const m = FLOOR_RE.exec(source) ??
    fail(`${KEYS_MODULE} declares no RUNTIME_REVOCATION_MIN_SEQUENCE`);
  return Number(m[2]);
}

/**
 * `source` (the keys module) with its compiled-in minimum sequence set to `sequence`.
 *
 * @param source The module's text.
 * @param sequence The new floor.
 * @returns The new text.
 */
export function withMinSequence(source: string, sequence: number): string {
  minSequenceIn(source);
  return source.replace(FLOOR_RE, `$1${sequence};`);
}

/** `floor`: raise the compiled-in minimum sequence to the published list's (never lower it). */
async function floor(deps: RevocationsDeps, flags: Record<string, string | boolean>) {
  if (deps.keys.length === 0) {
    return deps.log("no revocation public key is compiled in: the floor stays");
  }
  const current = await publishedList(deps) ??
    fail("could not read the published list (offline, or none published yet: `init`)");
  const file = typeof flags.file === "string" ? flags.file : KEYS_MODULE;
  const source = await Deno.readTextFile(file);
  const was = minSequenceIn(source);
  if (current.sequence <= was) return deps.log(`the compiled-in floor stays at #${was}`);
  await Deno.writeTextFile(file, withMinSequence(source, current.sequence));
  deps.log(`raised the compiled-in floor #${was} → #${current.sequence} (${file})`);
}

const USAGE = "usage: deno task revocations <keygen | init | add | sign | resign | verify | " +
  "publish | floor> (see the header of scripts/runtime-revocations.ts)";

/**
 * The CLI.
 *
 * @param args The command line.
 * @param deps Seams (default the real process).
 */
export async function main(args: string[], deps: RevocationsDeps = realDeps()): Promise<void> {
  const { positionals: [command, arg], flags } = parseArgs(args);
  switch (command) {
    case "keygen": {
      const slot = slotOf(flags.slot);
      const pub = await keygen(deps, slot, flags.force === true);
      deps.log(`stored the ${slot} private key in the keychain (${KEYCHAIN_SERVICE} / ${slot}).`);
      deps.log(
        `public key — paste it into the ${slot} slot of src/build/runtime-revocation-keys.ts:`,
      );
      return deps.log(pub);
    }
    case "init":
      return await init(deps, flags);
    case "add":
      return await add(deps, flags);
    case "resign":
      return await resign(deps, flags);
    case "sign":
      return await sign(deps, arg ?? fail(USAGE), flags);
    case "verify":
      return await verify(deps, arg);
    case "publish":
      return await publish(deps, await Deno.readTextFile(arg ?? fail(USAGE)));
    case "floor":
      return await floor(deps, flags);
    default:
      fail(USAGE);
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (err) {
    console.error(`revocations: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}
