// `denext runtime` (src/cli/commands/runtime.ts) driven in-process over a signed fixture channel:
// test keys through the keys file (honourChannelKeysFileForTests), an index and release documents
// served by a fake network, a temp toolchain cache, user default and project. Each verb: `upgrade`
// (the hold, a release that needs a newer denext, --project, --dry-run, offline, a bad signature),
// `use` (a version, latest, bundled, --project, offline with a known lock, refusals), `install
// <version>`, `version` / `info` and `list` (--json shapes, the channel's verdicts, offline), the
// unknown action, and the retired `denext toolchain` verb's did-you-mean. Nothing reaches the
// network and no toolchain is downloaded (the installer is a recording seam).

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  runtimeAction,
  type RuntimeCliDeps,
  type ToolsStatus,
} from "../src/cli/commands/runtime.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { buildRegistry } from "../src/cli/register.ts";
import {
  BUNDLED_RUNTIME,
  lockOfPins,
  readUserRuntimeDefaultFile,
  releaseDocumentOf,
  releaseIntegrity,
  resolveRuntimeReleaseSync,
  RUNTIME_DEFAULT_FILE_ENV,
  userRuntimeDefaultFile,
  writeUserRuntimeDefault,
} from "../src/build/runtime-select.ts";
import {
  CHANNEL_BASES,
  CHANNEL_KEYS_FILE_ENV,
  freshRuntimeChannel,
  honourChannelKeysFileForTests,
  releaseDocumentText,
  releaseDocumentUrls,
  releaseEntryFor,
  type RuntimeChannelRelease,
  type RuntimeReleaseDocument,
  signRuntimeChannel,
} from "../src/build/runtime-channel.ts";
import {
  freshRevocationList,
  loadRuntimeRevocations,
  REVOCATION_URLS,
  type RuntimeRevocation,
  signRevocationList,
} from "../src/build/runtime-revocations.ts";
import type { DenoToolchainPin } from "../src/build/deno-toolchain.ts";
import { toBase64 } from "../src/build/ota-signing.ts";
import { sha256Hex, spkiSha256 } from "../src/build/signed-envelope.ts";

const BUNDLED = BUNDLED_RUNTIME.toolchain.version!;
const V31 = "3.0.0-denext.31";
const V32 = "3.0.0-denext.32";
const V33 = "3.0.0-denext.33";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TARGET = "test-target";

honourChannelKeysFileForTests();

/** The bundled release document with its version replaced by `version`. */
function docFor(
  version: string,
  edit?: (doc: RuntimeReleaseDocument) => void,
): RuntimeReleaseDocument {
  const text = JSON.stringify(releaseDocumentOf(BUNDLED_RUNTIME)).replaceAll(BUNDLED, version);
  const doc = JSON.parse(text) as RuntimeReleaseDocument;
  edit?.(doc);
  return doc;
}

/** One fixture release: its document, entry and served text. */
interface Fixture {
  readonly doc: RuntimeReleaseDocument;
  readonly entry: RuntimeChannelRelease;
  readonly text: string;
  readonly integrity: string;
}

async function release(
  version: string,
  over: {
    ageMs?: number;
    minDenext?: string;
    yanked?: string;
    edit?: (doc: RuntimeReleaseDocument) => void;
  } = {},
): Promise<Fixture> {
  const doc = docFor(version, over.edit);
  const { entry, text } = await releaseEntryFor(doc, {
    releasedAt: new Date(Date.now() - (over.ageMs ?? 10 * DAY)).toISOString(),
    minDenext: over.minDenext ?? "4.0.0",
  });
  const withYank = over.yanked ? { ...entry, yanked: { reason: over.yanked } } : entry;
  return { doc, entry: withYank, text, integrity: releaseIntegrity(await sha256Hex(text)) };
}

/** A P-256 key pair; the public key as the keys file holds it. */
async function keyPair(): Promise<{ priv: CryptoKey; pub: string }> {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    priv: k.privateKey,
    pub: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", k.publicKey))),
  };
}

/** The test world: dirs, keys, the served channel and the recorded installs. */
interface World {
  readonly root: string;
  readonly cacheRoot: string;
  readonly project: string;
  readonly defaultFile: string;
  readonly installed: string[];
  readonly out: string[];
  readonly err: string[];
  /** URL → body; absent answers 404. `offline` makes every request fail. */
  readonly served: Map<string, string>;
  offline: boolean;
  deps(over?: Partial<RuntimeCliDeps>): RuntimeCliDeps;
  serve(fixtures: Fixture[], signer?: CryptoKey): Promise<void>;
  /** The channel's own public key (as the keys file holds it). */
  readonly channelKey: string;
  /**
   * Serve a revoked-runtimes list signed now: the `revoked` releases, and the withdrawn channel
   * keys `withdrawn` (SPKI SHA-256 hex).
   */
  serveRevocations(
    list?: { revoked?: RuntimeRevocation[]; withdrawn?: string[] },
  ): Promise<void>;
  /** Stop serving the revoked-runtimes list. */
  dropRevocations(): void;
}

const TOOLS: ToolsStatus = {
  toolchain: {
    mode: "pinned",
    version: BUNDLED,
    target: TARGET,
    state: "cached",
    path: "/cache/deno",
    active: false,
    running: "2.9.8",
    ok: true,
    detail: "toolchain cached",
    esbuild: { state: "ok", version: "0.25.5", path: null, detail: "esbuild" },
    tsgo: { state: "ok", version: "7", path: null, detail: "tsgo" },
    tsgoLsp: { state: "ok", version: "7", path: null, detail: "tsgo lsp" },
  },
  revocation: {
    configured: false,
    pinned: BUNDLED,
    revoked: false,
    reason: null,
    advisory: null,
    fixedIn: null,
    runningRollback: false,
    running: BUNDLED,
    listSequence: null,
    listExpiresAt: null,
    expiredAt: null,
  },
  esbuildBinary: { ok: true, detail: "esbuild ok", path: null, source: "toolchain" },
  gleam: { ok: true, state: "missing", detail: "gleam missing", path: "/g", version: "1" },
  fastlane: { ok: true, state: "missing", detail: "fastlane missing", path: "/f", version: "2" },
} as unknown as ToolsStatus;

/**
 * Run `fn` in a fresh world. The revoked-runtimes list is served (signed by the world's own
 * revocation key, naming nothing) and, unless `fresh`, already cached: a machine that has run
 * denext before. `fresh` is a machine with no cached list.
 */
async function withWorld(
  fn: (w: World) => Promise<void>,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "denext-cli-runtime-" });
  const cacheRoot = join(root, "deno-dir", "denext-deno");
  const project = join(root, "app");
  await Deno.mkdir(join(project, ".git"), { recursive: true });
  await Deno.writeTextFile(join(project, "deno.json"), "{}\n");
  const keys = await keyPair();
  const revocationKeys = await keyPair();
  let lastList: { sequence: number } | undefined;
  const keysFile = join(root, "keys.json");
  await Deno.writeTextFile(keysFile, JSON.stringify([keys.pub]));
  const vars: Record<string, string> = {
    DENO_DIR: join(root, "deno-dir"),
    [CHANNEL_KEYS_FILE_ENV]: keysFile,
  };
  const served = new Map<string, string>();
  const w: World = {
    root,
    cacheRoot,
    project,
    defaultFile: join(cacheRoot, "default.json"),
    installed: [],
    out: [],
    err: [],
    served,
    offline: false,
    deps(over = {}) {
      const fetchFake = ((input: string | URL | Request) => {
        if (w.offline) return Promise.reject(new TypeError("offline"));
        const body = served.get(String(input instanceof Request ? input.url : input));
        return Promise.resolve(
          body === undefined ? new Response("no", { status: 404 }) : new Response(body),
        );
      }) as typeof fetch;
      return {
        env: (k) => vars[k],
        cacheRoot,
        target: TARGET,
        rule: () => Promise.resolve({ cutoff: new Date(Date.now() - DAY) }),
        channel: {
          fetch: fetchFake,
          netGranted: () => Promise.resolve(true),
          revocations: { keys: [revocationKeys.pub] },
        },
        ensure: (pin: DenoToolchainPin, at: string) => {
          w.installed.push(pin.version!);
          return Promise.resolve({
            deno: join(at, pin.version!, "deno"),
            version: pin.version!,
            cached: false,
          });
        },
        tools: () => Promise.resolve(TOOLS),
        log: (line) => w.out.push(line),
        warn: (line) => w.err.push(line),
        ...over,
      };
    },
    async serve(fixtures, signer = keys.priv) {
      const channel = freshRuntimeChannel(fixtures.map((f) => f.entry), new Date());
      const index = JSON.stringify(await signRuntimeChannel(channel, [signer]));
      for (const base of CHANNEL_BASES) served.set(new URL("channel.json", base).href, index);
      for (const f of fixtures) {
        for (const url of releaseDocumentUrls(f.entry.version)) served.set(url, f.text);
      }
    },
    channelKey: keys.pub,
    async serveRevocations({ revoked = [], withdrawn = [] } = {}) {
      // A sequence above the last one, whatever the clock's second says.
      const list = freshRevocationList(revoked, new Date(), lastList, withdrawn);
      lastList = list;
      const text = JSON.stringify(await signRevocationList(list, revocationKeys.priv));
      for (const url of REVOCATION_URLS) served.set(url, text);
    },
    dropRevocations() {
      for (const url of REVOCATION_URLS) served.delete(url);
    },
  };
  await w.serveRevocations();
  if (!fresh) {
    const { fetch, netGranted } = w.deps().channel!;
    const primed = await loadRuntimeRevocations({
      mode: "force",
      env: (k) => vars[k],
      cacheRoot,
      keys: [revocationKeys.pub],
      fetch,
      netGranted,
    });
    assertEquals(primed.source, "network");
  }
  try {
    await fn(w);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** `runtime <positionals…>` in the project, with `flags`. */
function ctxOf(
  w: World,
  positionals: string[],
  flags: Record<string, unknown> = {},
  json = false,
): CommandContext {
  return {
    positionals: ["", ...positionals].slice(1),
    flags,
    rest: [],
    global: { cwd: w.project, json },
  } as unknown as CommandContext;
}

/** Run one action; its exit code (output lands in `w.out` / `w.err`). */
async function run(
  w: World,
  positionals: string[],
  flags: Record<string, unknown> = {},
  json = false,
  over: Partial<RuntimeCliDeps> = {},
): Promise<number> {
  w.out.length = 0;
  w.err.length = 0;
  return await runtimeAction(ctxOf(w, positionals, flags, json), w.deps(over));
}

const text = (lines: string[]) => lines.join("\n");

/** Cache a release document where the channel loader would, so its lock resolves offline. */
async function cacheDoc(w: World, f: Fixture): Promise<void> {
  await Deno.mkdir(join(w.cacheRoot, "releases"), { recursive: true });
  await Deno.writeTextFile(join(w.cacheRoot, "releases", `${f.entry.version}.json`), f.text);
}

/** The project pin as the config holds it. */
async function projectPin(w: World): Promise<{ version: string; integrity: string } | undefined> {
  const config = JSON.parse(await Deno.readTextFile(join(w.project, "deno.json")));
  return config?.denext?.runtime;
}

// ---------------------------------------------------------------------------------------------
// upgrade

Deno.test("runtime upgrade: takes the newest compatible release past the hold, installs it, makes it the default", async () => {
  await withWorld(async (w) => {
    const fresh = await release(V33, { ageMs: HOUR });
    const old = await release(V31);
    await w.serve([fresh, old]);
    assertEquals(await run(w, ["upgrade"]), 0, text(w.err));
    assertEquals(w.installed, [V31]);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), {
      version: V31,
      integrity: old.integrity,
      held: false,
    });
    const out = text(w.out);
    assertStringIncludes(out, `runtime ${V31} is now your default (was ${BUNDLED})`);
    // The held release is explained the way `denext upgrade` explains a held version.
    assertMatch(out, /runtime 3\.0\.0-denext\.33 was published 1 h ago; your dependency-age rule/);
    assertStringIncludes(out, `Took ${V31} for now — run "denext runtime upgrade" after that.`);
    // The document is cached where the resolver reads a lock's document from.
    const selected = resolveRuntimeReleaseSync({
      env: () => undefined,
      cacheRoot: w.cacheRoot,
      projectDir: w.project,
    });
    assertEquals([selected.source, selected.version], ["default", V31]);
    // A second run has nothing newer to take.
    assertEquals(await run(w, ["upgrade"]), 0);
    assertStringIncludes(text(w.out), `runtime ${V31} is the newest release this denext takes`);
    assertEquals(w.installed, [V31]);
  });
});

Deno.test("runtime upgrade --json: the record of what moved; --dry-run writes and installs nothing", async () => {
  await withWorld(async (w) => {
    const fresh = await release(V33, { ageMs: HOUR });
    const old = await release(V31);
    await w.serve([fresh, old]);
    assertEquals(await run(w, ["upgrade"], { "dry-run": true }, true), 0);
    const dry = JSON.parse(text(w.out));
    assertEquals(dry, {
      scope: "user",
      from: BUNDLED,
      to: V31,
      changed: true,
      dryRun: true,
      held: { version: V33, releasedAt: fresh.entry.releasedAt },
      needsDenext: null,
    });
    assertEquals(w.installed, []);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), null);
    assertEquals(await run(w, ["upgrade"], { "dry-run": true }), 0);
    assertStringIncludes(text(w.out), `would install runtime ${V31} and make it your default`);

    assertEquals(await run(w, ["upgrade"], {}, true), 0);
    const done = JSON.parse(text(w.out));
    assertEquals([done.to, done.changed, done.dryRun, done.integrity], [
      V31,
      true,
      false,
      old.integrity,
    ]);
    assertEquals(done.deno, join(w.cacheRoot, V31, "deno"));
  });
});

Deno.test("runtime upgrade --project: pins version + integrity in deno.json, comments kept", async () => {
  await withWorld(async (w) => {
    const old = await release(V31);
    await w.serve([old]);
    await Deno.writeTextFile(
      join(w.project, "deno.json"),
      '{\n  // the app\n  "tasks": { "dev": "denext dev" }\n}\n',
    );
    // A hard link to the old file: an in-place write would change it too; the pin is written to a
    // temp file renamed over deno.json, so the link keeps the old text (never a half-written file).
    const before = join(w.project, "deno.json.before");
    await Deno.link(join(w.project, "deno.json"), before);
    assertEquals(await run(w, ["upgrade"], { project: true }), 0, text(w.err));
    assert(!(await Deno.readTextFile(before)).includes("integrity"), "written by rename");
    assertEquals(
      [...Deno.readDirSync(w.project)].filter((e) => e.name.endsWith(".tmp")),
      [],
      "no temp file is left",
    );
    const raw = await Deno.readTextFile(join(w.project, "deno.json"));
    assertStringIncludes(raw, "// the app");
    const { parse } = await import("@std/jsonc");
    const config = parse(raw) as { denext: { runtime: unknown } };
    assertEquals(config.denext.runtime, { version: V31, integrity: old.integrity });
    assertStringIncludes(text(w.out), `pinned runtime ${V31} in ${join(w.project, "deno.json")}`);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), null, "the default is untouched");
    // Pinned already: nothing to do.
    assertEquals(await run(w, ["upgrade"], { project: true }), 0);
    assertStringIncludes(text(w.out), "nothing to do");
  });
});

Deno.test("runtime upgrade: a newer release that needs a newer denext is named with its fix", async () => {
  await withWorld(async (w) => {
    await w.serve([await release(V33, { minDenext: "99.0.0" }), await release(V31)]);
    assertEquals(await run(w, ["upgrade"]), 0);
    assertEquals(w.installed, [V31]);
    assertStringIncludes(
      text(w.out),
      `runtime ${V33} needs denext 99.0.0 or newer: run "denext upgrade".`,
    );
    assertEquals(await run(w, ["upgrade"], { "dry-run": true }, true), 0);
    assertEquals(JSON.parse(text(w.out)).needsDenext, { version: V33, minDenext: "99.0.0" });
  });
});

Deno.test("runtime upgrade: only a held release (exit 0, said why); none at all (exit 1)", async () => {
  await withWorld(async (w) => {
    await w.serve([await release(V33, { ageMs: HOUR })]);
    assertEquals(await run(w, ["upgrade"]), 0);
    assertEquals(w.installed, []);
    assertStringIncludes(text(w.out), "Staying on " + BUNDLED);
    // A yanked or incompatible-only channel offers nothing.
    await w.serve([
      await release(V32, { yanked: "broken" }),
      await release(V31, { edit: (d) => setEsbuild(d, "0.99.0") }),
    ]);
    assertEquals(await run(w, ["upgrade"]), 1);
    assertStringIncludes(text(w.out), "lists no release this denext runs on");
  });
});

Deno.test("runtime upgrade: offline, unsigned or signed by another key — fails with the reason, changes nothing", async () => {
  await withWorld(async (w) => {
    await w.serve([await release(V31)]);
    w.offline = true;
    assertEquals(await run(w, ["upgrade"]), 1);
    assertStringIncludes(text(w.err), "runtime upgrade needs the runtime channel");
    assertStringIncludes(text(w.err), "unavailable");
    w.offline = false;
    const stranger = await keyPair();
    await w.serve([await release(V31)], stranger.priv);
    assertEquals(await run(w, ["upgrade"]), 1);
    assertStringIncludes(text(w.err), "unavailable (offline, or no copy verifies)");
    // No key at all: the channel is absent, and says so.
    const noKey = { channel: { ...w.deps().channel, keys: [] } };
    assertEquals(await run(w, ["upgrade"], {}, false, noKey), 1);
    assertStringIncludes(text(w.err), "carries no runtime channel key");
    assertEquals(w.installed, []);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), null);
  });
});

Deno.test("runtime upgrade / use latest: a release the revoked-runtimes list names is never the pick; choosing it by name is refused", async () => {
  await withWorld(async (w) => {
    const newest = await release(V33);
    const older = await release(V32);
    await w.serve([newest, older]);
    await w.serveRevocations({
      revoked: [{ component: "cli", version: V33, reason: "a bad build", advisory: "https://x/a" }],
    });
    // The floating pick passes over the revoked newest release.
    assertEquals(await run(w, ["upgrade"], { "dry-run": true }), 0, text(w.err));
    assertStringIncludes(text(w.out), V32);
    assert(!text(w.out).includes(V33), text(w.out));
    assertEquals(await run(w, ["upgrade"], { project: true }), 0, text(w.err));
    assertEquals((await projectPin(w))?.version, V32);
    assertEquals(await run(w, ["use", "latest"]), 0, text(w.err));
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile)?.version, V32);
    assertEquals(w.installed.includes(V33), false);
    // Named outright it is refused, with the reason and the way round; nothing is written.
    for (const verb of [["use", V33], ["use", V33, "--project"], ["install", V33]]) {
      const flags = verb.includes("--project") ? { project: true } : {};
      assertEquals(await run(w, verb.filter((a) => !a.startsWith("--")), flags), 1, verb.join(" "));
      assertStringIncludes(text(w.err), `runtime ${V33} is revoked for`);
      assertStringIncludes(text(w.err), "a bad build; https://x/a");
      assertStringIncludes(text(w.err), `DENEXT_ALLOW_REVOKED_RUNTIME=${V33}`);
    }
    assertEquals(w.installed.includes(V33), false);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile)?.version, V32);
    assertEquals((await projectPin(w))?.version, V32);
    // The documented override takes it, with a warning.
    const allow = w.deps();
    const env = (k: string) => k === "DENEXT_ALLOW_REVOKED_RUNTIME" ? V33 : allow.env!(k);
    assertEquals(await run(w, ["install", V33], {}, false, { env }), 0, text(w.err));
    assertStringIncludes(text(w.err), "taking it anyway");
    assertEquals(w.installed.includes(V33), true);
    // A release revoked for other targets only is taken by name, with a warning.
    await w.serveRevocations({
      revoked: [{
        component: "desktop",
        version: V32,
        targets: ["no-such-target-triple"],
        reason: "elsewhere",
      }],
    });
    assertEquals(await run(w, ["upgrade"], { "dry-run": true }), 0, text(w.err)); // re-reads the list
    assertStringIncludes(text(w.out), V33); // V33 is no longer revoked; V32 is, somewhere
    assertEquals(await run(w, ["use", V32]), 0, text(w.err));
    assertStringIncludes(text(w.err), `runtime ${V32} is revoked for other targets`);
  });
});

Deno.test("runtime upgrade on a machine with no cached revoked-runtimes list: the list comes first; a withdrawn channel key or no list changes nothing", async () => {
  // The channel's key was withdrawn: its index is not taken, on the very first run.
  await withWorld(async (w) => {
    await w.serve([await release(V31)]);
    await w.serveRevocations({ withdrawn: [(await spkiSha256(w.channelKey))!] });
    for (const verb of [["upgrade"], ["use", "latest"], ["use", V31], ["install", V31]]) {
      assertEquals(await run(w, verb), 1, verb.join(" "));
      assertStringIncludes(text(w.err), "the runtime channel's key was withdrawn", verb.join(" "));
    }
    assertEquals(w.installed, []);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), null);
  }, { fresh: true });
  // No list to be had: nothing is taken from the channel either, and the reason is said.
  await withWorld(async (w) => {
    await w.serve([await release(V31)]);
    w.dropRevocations();
    for (const verb of [["upgrade"], ["use", "latest"], ["use", V31], ["install", V31]]) {
      assertEquals(await run(w, verb), 1, verb.join(" "));
      assertStringIncludes(text(w.err), "the revoked-runtimes list can't be had", verb.join(" "));
    }
    assertEquals(w.installed, []);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), null);
    // Once the list is served, the same machine upgrades.
    await w.serveRevocations();
    assertEquals(await run(w, ["upgrade"]), 0, text(w.err));
    assertEquals(w.installed, [V31]);
  }, { fresh: true });
});

/** Give every toolchain target of `doc` another esbuild. */
function setEsbuild(doc: RuntimeReleaseDocument, version: string): void {
  for (const a of Object.values(doc.toolchain.targets)) {
    if (a.esbuild) (a as { esbuild: unknown }).esbuild = { ...a.esbuild, version };
  }
}

// ---------------------------------------------------------------------------------------------
// use

Deno.test("runtime use <version>: installs it and makes it the held default; --project pins it", async () => {
  await withWorld(async (w) => {
    const fresh = await release(V33, { ageMs: HOUR });
    await w.serve([fresh]);
    // An explicit version is the user's own choice: the hold does not apply.
    assertEquals(await run(w, ["use", V33]), 0, text(w.err));
    assertEquals(w.installed, [V33]);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), {
      version: V33,
      integrity: fresh.integrity,
      held: true,
    });
    assertEquals(await run(w, ["use", V33], { project: true }, true), 0);
    const json = JSON.parse(text(w.out));
    assertEquals([json.scope, json.to, json.integrity], ["project", V33, fresh.integrity]);
    assertEquals(await projectPin(w), { version: V33, integrity: fresh.integrity });
  });
});

Deno.test("runtime use bundled: removes the default (or pins the bundled release with --project)", async () => {
  await withWorld(async (w) => {
    assertEquals(await run(w, ["use", "bundled"]), 0);
    assertStringIncludes(text(w.out), "no default runtime is set");
    await writeUserRuntimeDefault(w.cacheRoot, {
      version: V31,
      integrity: "sha256-" + "a".repeat(64),
      held: true,
    });
    assertEquals(await run(w, ["use", "bundled"], {}, true), 0);
    assertEquals(JSON.parse(text(w.out)).removedDefault, true);
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), null);
    assertEquals(await run(w, ["use", "bundled"], { project: true }), 0);
    assertEquals(await projectPin(w), lockOfPins(BUNDLED_RUNTIME));
    assertEquals(w.installed, [], "the bundled release needs no install here");
    // The bundled pin resolves with no channel, offline.
    const selected = resolveRuntimeReleaseSync({
      env: () => undefined,
      cacheRoot: w.cacheRoot,
      projectDir: w.project,
    });
    assertEquals([selected.source, selected.version], ["project", BUNDLED]);
  });
});

Deno.test("runtime use latest: the floating pick, held", async () => {
  await withWorld(async (w) => {
    const old = await release(V31);
    await w.serve([await release(V33, { ageMs: HOUR }), old]);
    assertEquals(await run(w, ["use", "latest"]), 0, text(w.err));
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile), {
      version: V31,
      integrity: old.integrity,
      held: true,
    });
    assertStringIncludes(text(w.out), `runtime ${V31} is now your default`);
  });
});

Deno.test("runtime use: offline, an installed release a lock names still works; anything else fails", async () => {
  await withWorld(async (w) => {
    const old = await release(V31);
    await cacheDoc(w, old);
    await Deno.writeTextFile(
      join(w.project, "deno.json"),
      JSON.stringify({ denext: { runtime: { version: V31, integrity: old.integrity } } }),
    );
    w.offline = true;
    assertEquals(await run(w, ["use", V31]), 0, text(w.err));
    assertEquals(readUserRuntimeDefaultFile(w.defaultFile)?.version, V31);
    assertEquals(await run(w, ["use", V32]), 1);
    assertStringIncludes(text(w.err), `runtime ${V32} can't be found`);
    assertStringIncludes(text(w.err), "unavailable");
  });
});

Deno.test("runtime use: refuses an unlisted or incompatible release and bad usage; warns on a withdrawn one", async () => {
  await withWorld(async (w) => {
    await w.serve([
      await release(V33, { edit: (d) => setEsbuild(d, "0.99.0") }),
      await release(V32, { yanked: "crashes on start" }),
    ]);
    assertEquals(await run(w, ["use", V31]), 1);
    assertStringIncludes(text(w.err), "the runtime channel does not list it");
    assertEquals(await run(w, ["use", V33]), 1);
    assertStringIncludes(text(w.err), "carries esbuild 0.99.0");
    assertEquals(await run(w, ["use", V32]), 0);
    assertStringIncludes(text(w.err), `runtime ${V32} was withdrawn (crashes on start)`);
    assertEquals(await run(w, ["use"]), 1);
    assertStringIncludes(text(w.err), "name one release");
    assertEquals(await run(w, ["use", V31, V32]), 1);
  });
});

Deno.test("runtime use --project: a directory with no deno.json is refused with the reason", async () => {
  await withWorld(async (w) => {
    await Deno.remove(join(w.project, "deno.json"));
    assertEquals(await run(w, ["use", "bundled"], { project: true }), 1);
    assertStringIncludes(text(w.err), "no deno.json");
  });
});

// ---------------------------------------------------------------------------------------------
// install

Deno.test("runtime install <version>: fetches and verifies the document, installs that release", async () => {
  await withWorld(async (w) => {
    const fresh = await release(V33, { ageMs: HOUR });
    await w.serve([fresh]);
    assertEquals(await run(w, ["install", V33]), 0, text(w.err));
    assertEquals(w.installed, [V33]);
    assertStringIncludes(text(w.out), `denext's runtime ${V33}`);
    // The document is cached: a lock on it resolves offline now.
    assertEquals(
      await Deno.readTextFile(join(w.cacheRoot, "releases", `${V33}.json`)),
      fresh.text,
    );
    // The bundled release installs from its own pin, with no channel.
    assertEquals(await run(w, ["install", BUNDLED]), 0);
    assertEquals(w.installed, [V33, BUNDLED]);
  });
});

Deno.test("runtime install: a tampered document, offline, an unknown --with tool, two versions — exit 1", async () => {
  await withWorld(async (w) => {
    const fresh = await release(V33);
    await w.serve([fresh]);
    for (const url of releaseDocumentUrls(V33)) w.served.set(url, fresh.text.replace("2", "3"));
    assertEquals(await run(w, ["install", V33]), 1);
    assertStringIncludes(text(w.err), "release document can't be had");
    w.offline = true;
    assertEquals(await run(w, ["install", V31]), 1);
    assertStringIncludes(text(w.err), `runtime ${V31} can't be found`);
    assertEquals(await run(w, ["install", V31], { with: "nope" }), 1);
    assertStringIncludes(text(w.err), "unknown --with tool nope");
    assertEquals(await run(w, ["install", V31, V32]), 1);
    assertStringIncludes(text(w.err), "takes one release");
    assertEquals(w.installed, []);
  });
});

Deno.test("runtime install: an installer failure is one line and exit 1", async () => {
  await withWorld(async (w) => {
    await w.serve([await release(V31)]);
    const code = await run(w, ["install", V31], {}, false, {
      ensure: () => Promise.reject(new Error("denext: no build for this host")),
    });
    assertEquals(code, 1);
    assertEquals(w.err, ["denext: no build for this host"]);
  });
});

// ---------------------------------------------------------------------------------------------
// version / info

Deno.test("runtime version --json: the selection, its source and integrity, the channel's offer, the tools", async () => {
  await withWorld(async (w) => {
    const pinned = await release(V31);
    const newer = await release(V33);
    await w.serve([newer, pinned]);
    await cacheDoc(w, pinned);
    await Deno.writeTextFile(
      join(w.project, "deno.json"),
      JSON.stringify({ denext: { runtime: { version: V31, integrity: pinned.integrity } } }),
    );
    // `version` reads the cached index only: with test keys nothing is cached, so the channel is
    // absent there, and the offer comes from the index the loader hands it.
    assertEquals(await run(w, ["version"], {}, true), 0, text(w.err));
    const json = JSON.parse(text(w.out));
    assertEquals(json.runtime.version, V31);
    assertEquals(json.runtime.source, "project");
    assertEquals(json.runtime.integrity, pinned.integrity);
    assertEquals(json.runtime.configPath, join(w.project, "deno.json"));
    assertEquals(json.bundled.version, BUNDLED);
    assertEquals(typeof json.minRuntime, "string");
    assertEquals(json.default, null);
    assertEquals(json.toolchain.mode, "pinned");
    assertEquals(json.esbuildBinary.ok, true);
    assertEquals(json.channel.state, "absent");

    // `info` is the same action; the channel's offer shows when the index is in hand.
    const offered = await run(w, ["info"], {}, false, {
      channel: {
        ...w.deps().channel,
        mode: "force",
      },
    });
    assertEquals(offered, 0, text(w.err));
    const out = text(w.out);
    assertStringIncludes(out, `${V31}: the project pin (${join(w.project, "deno.json")})`);
    assertStringIncludes(out, `integrity  ${pinned.integrity}`);
    assertStringIncludes(out, `runtime ${V33} is available: denext runtime upgrade`);
    assertStringIncludes(out, "your default    none");
  });
});

Deno.test("runtime version: a malformed project pin is reported (exit 1); a held default is named", async () => {
  await withWorld(async (w) => {
    await writeUserRuntimeDefault(w.cacheRoot, {
      version: V31,
      integrity: "sha256-" + "b".repeat(64),
      held: true,
    });
    assertEquals(await run(w, ["version"]), 0);
    assertStringIncludes(text(w.out), `your default    ${V31} (held)`);
    // Not installed: skipped with the notice, the bundled release runs.
    assertStringIncludes(text(w.out), `your default runtime ${V31} is not installed`);
    await Deno.writeTextFile(
      join(w.project, "deno.json"),
      JSON.stringify({ denext: { runtime: { version: "nope" } } }),
    );
    assertEquals(await run(w, ["version"], {}, true), 1);
    assertStringIncludes(JSON.parse(text(w.out)).runtime.error, "is malformed");
    assertEquals(await run(w, ["version"]), 1);
    assertStringIncludes(text(w.out), "✖ runtime");
  });
});

Deno.test("runtime version: a broken tool cache is exit 1", async () => {
  await withWorld(async (w) => {
    const broken = { ...TOOLS, gleam: { ...TOOLS.gleam, ok: false } } as ToolsStatus;
    assertEquals(await run(w, ["version"], {}, false, { tools: () => Promise.resolve(broken) }), 1);
  });
});

// ---------------------------------------------------------------------------------------------
// list

Deno.test("runtime list --json: installed releases and the channel's verdict on each", async () => {
  await withWorld(async (w) => {
    await w.serve([
      await release(V33, { ageMs: HOUR }),
      await release(V32, { yanked: "broken" }),
      await release(V31),
      await release("3.0.0-denext.30", { minDenext: "99.0.0" }),
    ]);
    for (const v of [V31, "3.0.0-denext.29"]) {
      await Deno.mkdir(join(w.cacheRoot, v, TARGET), { recursive: true });
      await Deno.writeTextFile(join(w.cacheRoot, v, TARGET, ".denext-toolchain.json"), "{}");
    }
    // Another host's install does not count here.
    await Deno.mkdir(join(w.cacheRoot, "3.0.0-denext.28", "other"), { recursive: true });
    await Deno.writeTextFile(
      join(w.cacheRoot, "3.0.0-denext.28", "other", ".denext-toolchain.json"),
      "{}",
    );

    assertEquals(await run(w, ["list"], {}, true), 0, text(w.err));
    const json = JSON.parse(text(w.out));
    assertEquals([json.channel.state, json.upgrade, json.held], ["current", V31, V33]);
    const rows = new Map(json.releases.map((r: { version: string }) => [r.version, r]));
    assertEquals(
      [...rows.keys()],
      [V33, V31, "3.0.0-denext.29", BUNDLED, BUNDLED_RUNTIME.toolchain.rollback!.version]
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    );
    assertEquals(rows.get(V33), {
      version: V33,
      installed: false,
      roles: [],
      channel: "held",
      releasedAt: (rows.get(V33) as { releasedAt: string }).releasedAt,
    });
    assertEquals((rows.get(V31) as { channel: string; installed: boolean }).channel, "available");
    assertEquals((rows.get(V31) as { installed: boolean }).installed, true);
    assertEquals((rows.get("3.0.0-denext.29") as { channel: string }).channel, "unlisted");
    assertEquals((rows.get(BUNDLED) as { roles: string[] }).roles, ["selected", "bundled"]);

    // --all: every listed release, with why it is not offered.
    assertEquals(await run(w, ["list"], { all: true }, true), 0);
    const all = new Map(
      JSON.parse(text(w.out)).releases.map((r: { version: string }) => [r.version, r]),
    );
    assertEquals((all.get(V32) as { channel: string; reason: string }).channel, "yanked");
    assertEquals((all.get(V32) as { reason: string }).reason, "broken");
    assertEquals((all.get("3.0.0-denext.30") as { channel: string }).channel, "incompatible");
    assertStringIncludes(
      (all.get("3.0.0-denext.30") as { reason: string }).reason,
      "needs denext 99.0.0",
    );
  });
});

Deno.test("runtime list: offline the channel is unavailable, installed releases still listed", async () => {
  await withWorld(async (w) => {
    w.offline = true;
    await Deno.mkdir(join(w.cacheRoot, V31, TARGET), { recursive: true });
    await Deno.writeTextFile(join(w.cacheRoot, V31, TARGET, ".denext-toolchain.json"), "{}");
    assertEquals(await run(w, ["list"]), 0);
    const out = text(w.out);
    assertStringIncludes(out, "channel: unavailable (the runtime channel is unavailable");
    assertMatch(out, /3\.0\.0-denext\.31\s+installed/);
    assertMatch(
      out,
      new RegExp(`\\* ${BUNDLED.replaceAll(".", "\\.")}`),
      "the selected one is starred",
    );
    assertEquals(await run(w, ["list"], {}, true), 0);
    const json = JSON.parse(text(w.out));
    assertEquals(json.channel.state, "absent");
    assertEquals(json.upgrade, null);
    assert(json.releases.every((r: { channel: unknown }) => r.channel === null));
  });
});

// ---------------------------------------------------------------------------------------------
// The verb, and the retired one.

Deno.test("runtime: an unknown action is one line naming the actions, exit 1", async () => {
  await withWorld(async (w) => {
    assertEquals(await run(w, ["status"]), 1);
    assertStringIncludes(text(w.err), 'unknown runtime action "status"');
    assertStringIncludes(text(w.err), "version | info | list | install | upgrade | use");
  });
});

Deno.test("denext toolchain is gone: its error names the runtime equivalent of the action", () => {
  const reg = buildRegistry();
  assertEquals(reg.get("toolchain"), undefined);
  assert(reg.get("runtime"));
  const cases: [string[], string][] = [
    [["toolchain", "status"], "denext runtime version"],
    [["toolchain", "install", "--with", "gleam"], "denext runtime install"],
    [["toolchain", "prune"], "denext runtime prune"],
    [["toolchain", "link"], "denext runtime link"],
    [["toolchain"], "denext runtime version"],
    [["toolchain", "frobnicate"], "denext runtime version"],
  ];
  // Only an own entry is retired: a name off Object.prototype is an ordinary unknown command.
  const odd = reg.parse(["constructor"]);
  assertEquals(odd.kind === "error" ? odd.hint : "not an error", undefined);
  for (const [argv, want] of cases) {
    const outcome = reg.parse(argv);
    assertEquals(outcome.kind, "error", argv.join(" "));
    if (outcome.kind !== "error") continue;
    assertEquals(outcome.message, 'unknown command "toolchain"');
    assertEquals(outcome.suggestion, want, argv.join(" "));
    assertStringIncludes(outcome.hint ?? "", "`denext runtime`");
    assertEquals(outcome.unknownVerb, { name: "toolchain", index: 0 });
  }
});

Deno.test("the user default's file: a named cache wins, else DENEXT_RUNTIME_DEFAULT_FILE, else DENO_DIR's", async () => {
  await withWorld(async (w) => {
    const other = join(w.root, "elsewhere.json");
    const env = (vars: Record<string, string>) => (k: string) => vars[k];
    assertEquals(
      userRuntimeDefaultFile(env({ DENO_DIR: "/d" })),
      join("/d", "denext-deno", "default.json"),
    );
    assertEquals(
      userRuntimeDefaultFile(env({ DENO_DIR: "/d", [RUNTIME_DEFAULT_FILE_ENV]: other })),
      other,
    );
    assertEquals(
      userRuntimeDefaultFile(env({ [RUNTIME_DEFAULT_FILE_ENV]: other }), w.cacheRoot),
      join(w.cacheRoot, "default.json"),
    );
    // The resolver reads the override, so the harness's empty file hides the machine's default.
    const old = await release(V31);
    await cacheDoc(w, old);
    await writeUserRuntimeDefault(w.cacheRoot, {
      version: V31,
      integrity: old.integrity,
      held: false,
    });
    const vars = { DENO_DIR: join(w.root, "deno-dir") };
    const seen = resolveRuntimeReleaseSync({ env: env(vars), projectDir: w.project });
    assertEquals([seen.source, seen.version], ["default", V31]);
    const hidden = resolveRuntimeReleaseSync({
      env: env({ ...vars, [RUNTIME_DEFAULT_FILE_ENV]: other }),
      projectDir: w.project,
    });
    assertEquals([hidden.source, hidden.version], ["bundled", BUNDLED]);
    // `runtime use` writes to the override too.
    assertEquals(
      await run(w, ["use", "bundled"], {}, false, {
        env: env({ ...vars, [RUNTIME_DEFAULT_FILE_ENV]: other }),
        cacheRoot: undefined,
      }),
      0,
    );
    assertStringIncludes(text(w.out), "no default runtime is set");
    assertEquals(readUserRuntimeDefaultFile(join(w.cacheRoot, "default.json"))?.version, V31);
  });
});

Deno.test("the served documents are the channel's own text (fixture sanity)", async () => {
  const f = await release(V31);
  assertEquals(releaseDocumentText(f.doc), f.text);
  assertEquals(f.entry.doc.sha256, f.integrity.slice("sha256-".length));
});

// ---------------------------------------------------------------------------------------------
// path / link / unlink, in process (on a DENEXT_DENO=<path> binary: nothing is downloaded)

Deno.test({
  name: "runtime path / link / unlink: name, link and unlink the binary in force",
  // A shell script stands in for `deno` (its --version answers the probe).
  ignore: Deno.build.os === "windows",
}, async () => {
  await withWorld(async (w) => {
    // Inside the toolchain cache, where `runtime unlink` recognises a link of its own.
    await Deno.mkdir(join(w.cacheRoot, "fake"), { recursive: true });
    const fake = join(w.cacheRoot, "fake", "deno");
    await Deno.writeTextFile(fake, "#!/bin/sh\necho 'deno 2.9.8 (stable, release, x86_64)'\n", {
      mode: 0o755,
    });
    const home = join(w.root, "home");
    const saved = ["DENEXT_DENO", "DENEXT_INSTALL", "DENO_DIR"].map((k) =>
      [k, Deno.env.get(k)] as const
    );
    Deno.env.set("DENO_DIR", join(w.root, "deno-dir"));
    Deno.env.set("DENEXT_DENO", fake);
    Deno.env.set("DENEXT_INSTALL", home);
    try {
      assertEquals(await run(w, ["path"]), 0, text(w.err));
      assertEquals(w.out, [fake]);
      assertEquals(await run(w, ["link"]), 0, text(w.err));
      assertStringIncludes(text(w.out), `linked ${join(home, "bin", "deno")}`);
      assertStringIncludes(text(w.out), "Put it on PATH");
      assert((await Deno.lstat(join(home, "bin", "deno"))).isSymlink);
      assertEquals(await run(w, ["unlink"]), 0, text(w.err));
      assertStringIncludes(text(w.out), "removed");
      assertEquals(await Deno.lstat(join(home, "bin", "deno")).catch(() => null), null);
      assertEquals(await run(w, ["unlink"]), 0);
      assertStringIncludes(text(w.out), "nothing to unlink");
    } finally {
      for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  });
});
