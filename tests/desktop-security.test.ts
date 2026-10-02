// Desktop security properties the W4 audit asked to see tested end to end, through the production
// wiring rather than a faked refusal:
//
//  - the PKCE verifier of a denext-driven auth session (Clerk's hosted sign-in over
//    `openAuthSession`'s custom-scheme flow) never reaches page-visible storage, the runtime or the
//    browser — only the token redemption carries it;
//  - a deep link with a forged `state` leaves the auth session pending, and is not handed to the
//    page as an ordinary link either (runDesktop's launch router + scheme auth sessions);
//  - full-app updates: a manifest re-targeted at another app (`wrong_app`) fails its signature, and
//    publishing never merges one app's release into another's manifest;
//  - a full-app update's trial launch is confirmed ONLY by the token-gated boot beacon of a loaded
//    window: no beacon (the page never loaded) or a forged one leaves it unconfirmed, so the
//    runtime rolls it back on the next launch.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { type ClerkLike, startClerkBrowserSignIn } from "../src/desktop/clerk.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  APP_UPDATE_MANIFEST_FILE,
  publishAppUpdate,
  verifyAppUpdateEnvelope,
} from "../src/build/app-update.ts";
import { generateOtaKeyPair, importOtaSigningKey } from "../src/build/ota-signing.ts";
import { createFakeDesktopRuntime } from "./helpers/desktop-fake-runtime.ts";
import { injectedGlobal } from "./helpers/desktop-bridge-server.ts";
import { withProps } from "./helpers/deno-stub.ts";
import { boot, exportDir, get, pageRpc, TOKEN_HEADER } from "./helpers/desktop-run-boot.ts";

// --- PKCE ---------------------------------------------------------------------------------------

/** A Storage that records every write. */
function recordingStorage(writes: string[]): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(`${k}=${v}`);
      m.set(k, String(v));
    },
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

Deno.test("openAuthSession SECURITY: the PKCE verifier never reaches page-visible storage, the runtime or the browser", async () => {
  const writes: string[] = [];
  const cookies: string[] = [];
  const fapi: Array<{ path: string; body: Record<string, unknown> }> = [];
  const clerk: ClerkLike = {
    getFapiClient: () => ({
      request: (init) => {
        fapi.push({ path: init.path, body: init.body ?? {} });
        const response = init.path === "/client/hosted_auth"
          ? { object: "hosted_auth", url: "https://accounts.example.com/sign-in" }
          : { object: "client", sessions: [{ id: "sess_9" }] };
        return Promise.resolve({ ok: true, status: 200, payload: { response } });
      },
    }),
    client: { fromJSON: () => {} },
    setActive: () => Promise.resolve(),
  };
  const rt = createFakeDesktopRuntime({
    authSession: {
      start: (a) => ({
        url: `myapp://auth/?state=${(a as { state: string }).state}` +
          "&rotating_token_nonce=n9&created_session_id=sess_9",
      }),
    },
  });
  const restore = rt.install();
  try {
    await withProps(globalThis, {
      localStorage: recordingStorage(writes),
      sessionStorage: recordingStorage(writes),
      document: {
        get cookie() {
          return cookies.join("; ");
        },
        set cookie(v: string) {
          cookies.push(v);
        },
      },
    }, async () => {
      const { createdSessionId } = await startClerkBrowserSignIn(clerk, {
        redirectUrl: "myapp://auth/",
      });
      assertEquals(createdSessionId, "sess_9");
    });
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
  const redemption = fapi.find((r) => r.path === "/client")!;
  const verifier = redemption.body.codeVerifier as string;
  assert(/^[0-9a-f]{64}$/.test(verifier), "a 256-bit verifier was redeemed");
  const seen = JSON.stringify({
    storage: writes,
    cookies,
    runtime: rt.calls,
    requests: fapi.filter((r) => r !== redemption),
    pageGlobal: (globalThis as { __denext?: unknown }).__denext ?? null,
  });
  assert(!seen.includes(verifier), "the verifier leaked outside the redemption");
  // What the browser and the runtime got is the S256 challenge, never the verifier.
  assertEquals(typeof fapi[0].body.codeChallenge, "string");
  assert(fapi[0].body.codeChallenge !== verifier);
});

// --- forged-state deep link ------------------------------------------------------------------

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function authorizeUrl(state: string): string {
  const u = new URL("https://auth.example.com/authorize");
  u.searchParams.set("client_id", "app");
  u.searchParams.set("redirect_uri", "myapp://auth/cb");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", CHALLENGE);
  u.searchParams.set("code_challenge_method", "S256");
  return u.href;
}

/** A `Deno.Command` stand-in recording what the system browser would have been asked to open. */
function fakeCommand(opened: string[]) {
  return class {
    #args: string[];
    constructor(_cmd: string, opts: { args?: string[] }) {
      this.#args = opts.args ?? [];
    }
    output() {
      opened.push(this.#args.at(-1) ?? "");
      return Promise.resolve({ success: true, code: 0 });
    }
  };
}

Deno.test("deep link SECURITY: a forged-state callback leaves the auth session pending and never reaches the page", async () => {
  const outDir = await exportDir();
  const opened: string[] = [];
  const desktop = Object.assign(new EventTarget(), {
    getSchemeOwner: () => Promise.resolve({ owner: "self" as const }),
  });
  const openUrl = (url: string) =>
    desktop.dispatchEvent(new CustomEvent("openurl", { detail: { url } }));
  try {
    await withProps(Deno, { Command: fakeCommand(opened) }, async () => {
      const { served } = await boot(
        { outDir, port: 1, deepLinks: ["myapp"], authSessionEnabled: true },
        { deno: { desktop } },
      );
      const token = injectedGlobal(
        await (await served.handler(get("http://127.0.0.1:1/"), {})).text(),
      )!.token as string;
      const rpc = pageRpc(served, token);
      let settled: unknown;
      const session = rpc("authSession", "start", {
        callbackScheme: "myapp",
        url: authorizeUrl("st-real"),
        session: "page-key-0123456789abcdef",
      }).then((r) => (settled = r));
      for (let i = 0; i < 100 && opened.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 2));
      }
      assertEquals(opened, [authorizeUrl("st-real")], "the system browser was asked to open it");
      // An attacker's link to the same callback, with a forged or missing state.
      openUrl("myapp://auth/cb?code=evil&state=st-forged");
      openUrl("myapp://auth/cb?code=evil");
      await new Promise((r) => setTimeout(r, 20));
      assertEquals(settled, undefined, "the session is still pending");
      assertEquals((await rpc("deepLinks", "take")).data, [], "and the page never saw them");
      // The real callback completes it.
      openUrl("myapp://auth/cb?code=good&state=st-real");
      await session;
      assertEquals(settled, { ok: true, data: { url: "myapp://auth/cb?code=good&state=st-real" } });
    });
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

// --- full-app updates: wrong_app -------------------------------------------------------------

/** A packaged app directory to publish. */
async function packagedApp(root: string): Promise<string> {
  const app = join(root, "App.app");
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.writeTextFile(join(app, "Contents", "MacOS", "app"), "#!/bin/sh\n");
  return app;
}

Deno.test("full-app update SECURITY (wrong_app): the app id is signed; a re-targeted manifest does not verify", async () => {
  const pair = await generateOtaKeyPair();
  const key = await importOtaSigningKey(pair.privateKeyPem);
  const dir = await Deno.makeTempDir();
  try {
    const r = await publishAppUpdate({
      artifact: await packagedApp(dir),
      app: "com.example.victim",
      version: "2.0.0",
      urlBase: "https://u.example.com/",
      outDir: join(dir, "out"),
      key,
      platform: "aarch64-apple-darwin-webview",
    });
    const envelope = JSON.parse(await Deno.readTextFile(r.manifest));
    assertEquals(
      (await verifyAppUpdateEnvelope(envelope, pair.publicKey)).app,
      "com.example.victim",
    );
    // Re-target the same signed release at another app: the signature no longer holds.
    const retargeted = {
      signed: envelope.signed.replace('"com.example.victim"', '"com.example.other"'),
      signature: envelope.signature,
    };
    assert(retargeted.signed !== envelope.signed);
    await assertRejects(
      () => verifyAppUpdateEnvelope(retargeted, pair.publicKey),
      Error,
      "signature",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("full-app update SECURITY (wrong_app): publishing never merges one app's release into another's", async () => {
  const pair = await generateOtaKeyPair();
  const key = await importOtaSigningKey(pair.privateKeyPem);
  const dir = await Deno.makeTempDir();
  try {
    const artifact = await packagedApp(dir);
    const common = {
      artifact,
      version: "2.0.0",
      urlBase: "https://u.example.com/",
      outDir: join(dir, "out"),
      key,
    };
    await publishAppUpdate({
      ...common,
      app: "com.example.a",
      platform: "aarch64-apple-darwin-webview",
    });
    const b = await publishAppUpdate({
      ...common,
      app: "com.example.b",
      platform: "x86_64-apple-darwin-webview",
    });
    assertEquals(
      b.platforms,
      ["x86_64-apple-darwin-webview"],
      "app A's platform was not carried over",
    );
    const payload = await verifyAppUpdateEnvelope(
      JSON.parse(await Deno.readTextFile(join(dir, "out", APP_UPDATE_MANIFEST_FILE))),
      pair.publicKey,
    );
    assertEquals(payload.app, "com.example.b");
    assertEquals(Object.keys(payload.platforms), ["x86_64-apple-darwin-webview"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- full-app updates: no confirm, no keep -----------------------------------------------------

/** A fake `Deno.desktop.updater` on a trial launch, counting confirms. */
function trialUpdater(trial = true) {
  const state = { confirms: 0 };
  const updater = {
    status: () => ({ trial }),
    confirm: () => {
      state.confirms++;
      return true;
    },
  };
  return { state, desktop: Object.assign(new EventTarget(), { updater }) };
}

const BOOTED = "/_denext/desktop/booted";

Deno.test("full-app update SECURITY (rollback): a trial is confirmed only by the loaded window's token-gated beacon", async () => {
  const outDir = await exportDir();
  try {
    const { state, desktop } = trialUpdater();
    // Deno.desktop stays in place for the whole launch: the confirm reads it when the beacon lands.
    await withProps(Deno, { desktop }, async () => {
      const { served } = await boot({ outDir, port: 1 });
      const html = await (await served.handler(get("http://127.0.0.1:1/"), {})).text();
      assert(html.includes(BOOTED), "a trial launch injects the boot beacon");
      const token = injectedGlobal(html)!.token as string;
      // The page has been served, its assets fetched, the bridge used — but the window never loaded:
      // nothing confirms, so the runtime rolls this version back at the next launch.
      await served.handler(get("http://127.0.0.1:1/app.js"), {});
      await pageRpc(served, token)("window", "state");
      assertEquals(state.confirms, 0);
      // Forged beacons: no token, a wrong token, a GET.
      const post = (headers: Record<string, string>, method = "POST") =>
        served.handler(new Request(`http://127.0.0.1:1${BOOTED}`, { method, headers }), {});
      assertEquals((await post({})).status, 403);
      assertEquals((await post({ [TOKEN_HEADER]: `${token}x` })).status, 403);
      assertEquals((await post({ [TOKEN_HEADER]: token }, "GET")).status, 405);
      assertEquals(state.confirms, 0);
      // The loaded window's beacon confirms — once, however often the page reloads.
      assertEquals((await post({ [TOKEN_HEADER]: token })).status, 204);
      assertEquals((await post({ [TOKEN_HEADER]: token })).status, 204);
      assertEquals(state.confirms, 1);
    });
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("full-app update SECURITY (rollback): with autoConfirm off, or no trial, nothing is ever confirmed for the app", async () => {
  const outDir = await exportDir();
  try {
    for (
      const [options, trial] of [
        [{ autoConfirmAppUpdate: false }, true],
        [{}, false],
      ] as const
    ) {
      const { state, desktop } = trialUpdater(trial);
      const { served } = await boot({ outDir, port: 1, ...options }, { deno: { desktop } });
      const html = await (await served.handler(get("http://127.0.0.1:1/"), {})).text();
      assert(!html.includes(BOOTED), "no beacon is injected");
      const token = injectedGlobal(html)!.token as string;
      await served.handler(
        new Request(`http://127.0.0.1:1${BOOTED}`, {
          method: "POST",
          headers: { [TOKEN_HEADER]: token },
        }),
        {},
      );
      assertEquals(state.confirms, 0);
    }
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});
