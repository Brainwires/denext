// `denext mobile submit` (src/build/mobile-submit.ts + mobile-artifact.ts): the artifact checks,
// the App Store Connect token and lookup, altool's key directory, the Play edit sequence, and
// dry runs that upload nothing. The network is a fake fetch; no key ever appears in a report.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { checkArtifact, listZipEntries } from "../src/build/mobile-artifact.ts";
import {
  ascToken,
  findLatestArtifact,
  formatSubmitReport,
  parseServiceAccount,
  playUpload,
  submitAndroid,
  submitIos,
} from "../src/build/mobile-submit.ts";
import type { BuildCommand } from "../src/build/mobile-build.ts";

/** A zip of empty stored entries (central directory only is what the checks read). */
function zipOf(names: string[], prefix: Uint8Array = new Uint8Array()): Uint8Array {
  const enc = new TextEncoder();
  const central: number[] = [];
  for (const name of names) {
    const n = enc.encode(name);
    const h = new Uint8Array(46 + n.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(28, n.length, true);
    h.set(n, 46);
    central.push(...h);
  }
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(10, names.length, true);
  v.setUint32(12, central.length, true);
  v.setUint32(16, prefix.length, true);
  return new Uint8Array([...prefix, ...central, ...eocd]);
}

const SIGNED_IPA = ["Payload/", "Payload/App.app/", "Payload/App.app/_CodeSignature/CodeResources"];
const SIGNED_AAB = ["BundleConfig.pb", "base/manifest/AndroidManifest.xml", "META-INF/UPLOAD.RSA"];

/** A PKCS#8 PEM for a fresh key. */
async function pem(
  alg: EcKeyGenParams | RsaHashedKeyGenParams,
): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = encodeBase64(der).replace(/(.{64})/g, "$1\n");
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** A fetch that answers from a list of [matcher, response] and records every call. */
function fakeFetch(routes: [RegExp, () => Response][]) {
  const calls: { method: string; url: string }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    const hit = routes.find(([re]) => re.test(`${init?.method ?? "GET"} ${url}`));
    return Promise.resolve(hit ? hit[1]() : new Response("no route", { status: 599 }));
  }) as typeof fetch;
  return { fn, calls };
}

Deno.test("mobile artifact: zip listing and the signed / unsigned checks", () => {
  assertEquals(listZipEntries(zipOf(["a", "b/c"])), ["a", "b/c"]);
  assertThrows(() => listZipEntries(new Uint8Array(40)), Error, "not a zip");
  assertEquals(checkArtifact("x.ipa", zipOf(SIGNED_IPA)), {
    kind: "ipa",
    signed: true,
    errors: [],
  });
  const unsigned = checkArtifact("x.ipa", zipOf(["Payload/App.app/Info.plist"]));
  assertEquals(unsigned.signed, false);
  assertStringIncludes(unsigned.errors.join(), "unsigned");
  assertEquals(checkArtifact("x.aab", zipOf(SIGNED_AAB)).errors, []);
  assertStringIncludes(
    checkArtifact("x.aab", zipOf(["BundleConfig.pb"])).errors.join(),
    "AndroidManifest",
  );
  const apk = zipOf(["AndroidManifest.xml"], new TextEncoder().encode("APK Sig Block 42"));
  assertEquals(checkArtifact("x.apk", apk).signed, true);
  assertStringIncludes(checkArtifact("x.aab", new Uint8Array(3)).errors[0], "not a zip");
});

Deno.test("mobile submit: the App Store Connect token is an ES256 JWT the key's public half verifies", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const key = await pem({ name: "ECDSA", namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_KEY1234567.p8");
    await Deno.writeTextFile(keyPath, key.pem);
    const token = await ascToken(
      { keyPath, keyId: "KEY1234567", issuerId: "iss" },
      1_700_000_000_000,
    );
    const [h, c, sig] = token.split(".");
    assertEquals(JSON.parse(new TextDecoder().decode(b64urlDecode(h))), {
      alg: "ES256",
      kid: "KEY1234567",
      typ: "JWT",
    });
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
    assertEquals(claims.aud, "appstoreconnect-v1");
    assertEquals(claims.exp - claims.iat, 1200);
    assert(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key.publicKey,
        b64urlDecode(sig) as Uint8Array<ArrayBuffer>,
        new TextEncoder().encode(`${h}.${c}`),
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile submit ios: dry run checks and looks up, a real run hands altool the key dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const key = await pem({ name: "ECDSA", namedCurve: "P-256" });
    const keyPath = join(dir, "my-key.p8"); // not AuthKey_<id>.p8: altool gets a linked copy
    await Deno.writeTextFile(keyPath, key.pem);
    const ipa = join(dir, "App.ipa");
    await Deno.writeFile(ipa, zipOf(SIGNED_IPA));
    const net = fakeFetch([[
      /GET https:\/\/api\.appstoreconnect\.apple\.com\/v1\/apps\?filter\[bundleId\]=dev\.example/,
      () => Response.json({ data: [{ id: "123", attributes: { name: "Receipts" } }] }),
    ]]);
    const runs: BuildCommand[] = [];
    const deps = {
      fetch: net.fn,
      now: () => 1_700_000_000_000,
      run: async (c: BuildCommand) => {
        runs.push(c);
        const linked = join(c.env!.API_PRIVATE_KEYS_DIR, "AuthKey_KEYID.p8");
        assertEquals(await Deno.readTextFile(linked), key.pem);
        return { code: 0 };
      },
    };
    const creds = { keyPath, keyId: "KEYID", issuerId: "ISSUER" };
    const dry = await submitIos(
      { artifact: ipa, bundleId: "dev.example", creds, dryRun: true },
      deps,
    );
    assertEquals(dry.checks.map((c) => c.ok), [true, true, true]);
    assertStringIncludes(dry.checks[2].detail, "Receipts (dev.example, app 123)");
    assertEquals(dry.uploaded, false);
    assertEquals(runs.length, 0, "a dry run runs nothing");
    const text = formatSubmitReport(dry);
    assert(!text.includes("PRIVATE KEY"), "the key never reaches the report");
    assertStringIncludes(text, "ready to submit");

    const real = await submitIos(
      { artifact: ipa, bundleId: "dev.example", creds, dryRun: false },
      deps,
    );
    assertEquals(real.uploaded, true);
    assertEquals(runs[0].args.slice(0, 4), ["altool", "--upload-app", "-f", ipa]);
    assert(runs[0].args.includes("--apiIssuer"));
    // The temporary key directory is gone.
    let left = true;
    try {
      await Deno.stat(runs[0].env!.API_PRIVATE_KEYS_DIR);
    } catch {
      left = false;
    }
    assert(!left);

    const missing = await submitIos({ artifact: ipa, creds: { keyPath }, dryRun: true }, deps);
    assertEquals(missing.checks[1].ok, false);
    assertStringIncludes(missing.checks[1].detail, "--asc-issuer");

    const refused = await submitIos({ artifact: ipa, bundleId: "dev.other", creds, dryRun: true }, {
      ...deps,
      fetch: fakeFetch([[/GET/, () =>
        Response.json({ errors: [{ detail: "bad token" }] }, { status: 401 })]]).fn,
    });
    assertStringIncludes(refused.checks[2].detail, "HTTP 401: bad token");

    const offline = await submitIos({ artifact: ipa, creds, dryRun: true, offline: true }, deps);
    assertEquals(offline.checks.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile submit android: service account, the edit sequence, and a dry run that commits nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const key = await pem({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    });
    const account = join(dir, "sa.json");
    await Deno.writeTextFile(
      account,
      JSON.stringify({ type: "service_account", client_email: "ci@x.iam", private_key: key.pem }),
    );
    const aab = join(dir, "app.aab");
    await Deno.writeFile(aab, zipOf(SIGNED_AAB));
    const edits =
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.example/edits";
    const net = fakeFetch([
      [
        /POST https:\/\/oauth2\.googleapis\.com\/token/,
        () => Response.json({ access_token: "tok" }),
      ],
      [/POST .*\/edits$/, () => Response.json({ id: "e1" })],
      [/DELETE .*\/edits\/e1$/, () => new Response(null, { status: 204 })],
      [/POST .*upload.*\/bundles\?uploadType=media/, () => Response.json({ versionCode: 42 })],
      [/PUT .*\/tracks\/internal$/, () => Response.json({})],
      [/POST .*:commit$/, () => Response.json({ id: "e1" })],
    ]);
    const deps = {
      fetch: net.fn,
      now: () => 1_700_000_000_000,
      run: () => Promise.resolve({ code: 0 }),
    };
    const base = {
      artifact: aab,
      packageName: "dev.example",
      serviceAccount: account,
      track: "internal",
      status: "completed" as const,
    };
    const dry = await submitAndroid({ ...base, dryRun: true }, deps);
    assertEquals(dry.checks.every((c) => c.ok), true, JSON.stringify(dry.checks));
    assertEquals(net.calls.map((c) => c.method), ["POST", "POST", "DELETE"]);
    assertEquals(dry.uploaded, false);

    net.calls.length = 0;
    const real = await submitAndroid({ ...base, dryRun: false }, deps);
    assertEquals(real.uploaded, true);
    assertEquals(net.calls.map((c) => `${c.method} ${c.url.replace(edits, "…")}`), [
      "POST https://oauth2.googleapis.com/token",
      "POST …",
      "POST https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/dev.example/edits/e1/bundles?uploadType=media",
      "PUT …/e1/tracks/internal",
      "POST …/e1:commit",
    ]);
    assertStringIncludes(real.checks.at(-1)!.detail, "version code 42 released to internal");
    assert(!formatSubmitReport(real).includes("PRIVATE KEY"));

    const noAccount = await submitAndroid(
      { ...base, serviceAccount: undefined, dryRun: true },
      deps,
    );
    assertStringIncludes(noAccount.checks[1].detail, "--service-account");
    assertThrows(
      () => parseServiceAccount('{"type":"user"}', "k.json"),
      Error,
      "not a service-account",
    );
    assertThrows(
      () => parseServiceAccount('{"type":"service_account"}', "k.json"),
      Error,
      "client_email",
    );

    const direct = await playUpload("tok", { ...base, checkOnly: true }, net.fn);
    assertEquals(direct.editId, "e1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile submit: the newest store build is picked from dist/mobile", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const out = join(dir, "android");
    await Deno.mkdir(out);
    const write = async (name: string, meta: Record<string, unknown>) => {
      await Deno.writeFile(join(out, name), new Uint8Array(1));
      await Deno.writeTextFile(
        join(out, `${name}.json`),
        JSON.stringify({ platform: "android", ...meta }),
      );
    };
    await write("a-debug.apk", {
      configuration: "Debug",
      builtAt: "2026-09-27T03:00:00Z",
      appId: "d",
    });
    await write("a-release.aab", {
      configuration: "Release",
      builtAt: "2026-09-27T01:00:00Z",
      appId: "r1",
    });
    await write("b-release.aab", {
      configuration: "Release",
      builtAt: "2026-09-27T02:00:00Z",
      appId: "r2",
    });
    await Deno.writeTextFile(join(out, "stray.json"), "{");
    const latest = await findLatestArtifact(dir, "android");
    assertEquals(latest?.meta.appId, "r2");
    assertEquals(await findLatestArtifact(dir, "ios"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
