// Windows packaging signs EVERY PE file of the bundle, not just the .exe: the pinned runtime
// refuses an update of a signed app unless each PE file in the staged bundle (the .exe,
// <App>.dll, WebView2Loader.dll, the app-local VC++ runtime, CEF's DLLs and helpers, any .node
// addon) carries the running app's Authenticode signature. PE files are found by their header,
// not their extension; signing is batched through signtool, the password on no command line. With no
// certificate nothing is signed; a certificate without signtool fails the run.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { desktopPeFiles, desktopSignWindows } from "../src/build/desktop.ts";
import type { DesktopRunOptions } from "../src/build/desktop.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";

/** A minimal PE image: the DOS header's `MZ`, `e_lfanew` → `PE\0\0`. */
function pe(peAt = 0x80): Uint8Array {
  const bytes = new Uint8Array(peAt + 64);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  new DataView(bytes.buffer).setUint32(0x3c, peAt, true);
  bytes.set([0x50, 0x45, 0, 0], peAt);
  return bytes;
}

/** A fake Windows bundle: PE files with all sorts of names, and files that only look like one. */
async function fakeBundle(): Promise<{ dir: string; pes: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_win_bundle_" });
  const files: Record<string, Uint8Array> = {
    "MyApp-x64.exe": pe(),
    "MyApp.dll": pe(0xf0),
    "WebView2Loader.dll": pe(),
    "vcruntime140.dll": pe(),
    "cef/libcef.dll": pe(),
    "cef/MyApp Helper.exe": pe(),
    "node_modules/addon/build/Release/addon.node": pe(),
    "resources/renamed.bin": pe(), // a PE file is one whatever its name
    "fake.dll": new TextEncoder().encode("MZ but no PE header at all, just text padding......."),
    "mz-only.dll": new Uint8Array([0x4d, 0x5a]),
    "resources/app.asar": new TextEncoder().encode("not a program"),
    "readme.txt": new TextEncoder().encode("hello"),
  };
  for (const [rel, bytes] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeFile(join(dir, rel), bytes);
  }
  const pes = [
    "MyApp-x64.exe",
    "MyApp.dll",
    "WebView2Loader.dll",
    "vcruntime140.dll",
    "cef/libcef.dll",
    "cef/MyApp Helper.exe",
    "node_modules/addon/build/Release/addon.node",
    "resources/renamed.bin",
  ].map((rel) => join(dir, rel)).sort();
  return { dir, pes };
}

Deno.test("desktopPeFiles: every PE file in the bundle, found by its MZ/PE header, not its extension", async () => {
  const { dir, pes } = await fakeBundle();
  try {
    assertEquals(await desktopPeFiles(dir), pes);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const THUMB = "AB".repeat(20);

/** A fake PowerShell for the certificate-store import: records each call's stdin. */
function storeFake() {
  const calls: Array<{ cmd: string[]; stdin: string }> = [];
  const run = (cmd: readonly string[], stdin: string) => {
    calls.push({ cmd: [...cmd], stdin });
    return Promise.resolve({
      code: 0,
      stdout: calls.length === 1 ? JSON.stringify({ sha1: THUMB, added: [THUMB] }) : "",
      stderr: "",
    });
  };
  return { calls, run, runSync: () => {} };
}

/** A recording signtool stub. */
function recorder() {
  const calls: Array<{ cmd: string[]; secrets: string[] }> = [];
  const run = (cmd: string[], _env?: Record<string, string>, options?: DesktopRunOptions) => {
    calls.push({ cmd, secrets: [...(options?.secrets ?? [])] });
    return Promise.resolve();
  };
  return { calls, run };
}

Deno.test("desktopSignWindows: signs every PE file of the bundle in batched signtool calls, password on no command line", async () => {
  const { dir, pes } = await fakeBundle();
  try {
    const { calls, run } = recorder();
    const store = storeFake();
    const env: Record<string, string> = {
      DENEXT_WINDOWS_CERT: "C:/certs/app.pfx",
      DENEXT_WINDOWS_CERT_PASSWORD: "s3cret",
    };
    const signed = await desktopSignWindows(await desktopPeFiles(dir), {
      run,
      has: (cmd) => Promise.resolve(cmd === "signtool"),
      env: (name) => env[name],
      warn: () => {},
      store,
    });
    assert(signed);
    assertEquals(calls.length, 1, "one batch for a small bundle");
    const { cmd, secrets } = calls[0];
    assertEquals(cmd.slice(0, 2), ["signtool", "sign"]);
    assertEquals(cmd.slice(-pes.length), pes, "every PE file, and nothing else");
    for (const notPe of ["fake.dll", "mz-only.dll", "readme.txt", "app.asar"]) {
      assert(!cmd.some((a) => a.endsWith(notPe)), notPe);
    }
    // The .pfx is imported into the user's store for the run (password on PowerShell's stdin)
    // and signtool signs by its thumbprint; the store entry is removed afterwards.
    assertStringIncludes(
      cmd.join(" "),
      `/sha1 ${THUMB} /fd sha256 /tr http://timestamp.digicert.com /td sha256`,
    );
    assert(!cmd.some((a) => a.includes("s3cret") || a === "/p"), cmd.join(" "));
    assertEquals(secrets, []);
    assertEquals(store.calls.length, 2, "imported, then removed");
    assertEquals(store.calls[0].stdin, btoa("s3cret"));
    assert(store.calls.every((c) => !c.cmd.join(" ").includes("s3cret")));
    // A large bundle (CEF ships dozens of DLLs) is signed in batches, each with the same flags.
    const many = Array.from({ length: 70 }, (_, i) => `C:/b/lib${i}.dll`);
    const big = recorder();
    const bigStore = storeFake();
    await desktopSignWindows(many, {
      run: big.run,
      has: () => Promise.resolve(true),
      env: (name) => ({ ...env, DENEXT_SIGN_TIMESTAMP_URL: "http://ts.example" })[name],
      store: bigStore,
    });
    assertEquals(bigStore.calls.length, 2, "one import (and one removal) for all the batches");
    assertEquals(big.calls.map((c) => c.cmd.filter((a) => a.startsWith("C:/b/")).length), [
      32,
      32,
      6,
    ]);
    assert(big.calls.every((c) => c.cmd.includes("http://ts.example") && c.cmd.includes(THUMB)));
    assertEquals(big.calls.flatMap((c) => c.cmd.filter((a) => a.startsWith("C:/b/"))), many);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopSignWindows: no certificate signs nothing and says so", async () => {
  const { calls, run } = recorder();
  const warnings: string[] = [];
  const signed = await desktopSignWindows(["a.exe", "a.dll"], {
    run,
    has: () => Promise.resolve(true),
    env: () => undefined,
    warn: (m) => warnings.push(m),
  });
  assertEquals(signed, false);
  assertEquals(calls, []);
  assertStringIncludes(warnings.join("\n"), "no DENEXT_WINDOWS_CERT set");
});

Deno.test("desktopSignWindows: a configured certificate without signtool fails the run, never an unsigned build", async () => {
  // A certificate in the environment says the app is to ship signed: without signtool here (off
  // Windows, no Windows SDK) the run used to warn and package the app unsigned, and an update of
  // a signed install is refused unless every PE file carries its signature. `--no-sign` (which
  // never calls this) is the way to build unsigned on purpose.
  for (
    const [env, named] of [
      [{ DENEXT_WINDOWS_CERT: "app.pfx" }, "DENEXT_WINDOWS_CERT"],
      [{ DENEXT_WINDOWS_CERT_THUMBPRINT: "ab cd" }, "DENEXT_WINDOWS_CERT_THUMBPRINT"],
    ] as Array<[Record<string, string>, string]>
  ) {
    const { calls, run } = recorder();
    const error = await assertRejects(() =>
      desktopSignWindows(["a.exe", "a.dll"], {
        run,
        has: () => Promise.resolve(false),
        env: (name) => env[name],
        warn: () => {},
      })
    );
    assertStringIncludes(String(error), named);
    assertStringIncludes(String(error), "--no-sign");
    assertEquals(calls, []);
  }
});

Deno.test("desktopSignWindows: a store thumbprint signs with /sha1, as build --compile --sign does", async () => {
  const { calls, run } = recorder();
  const env: Record<string, string> = { DENEXT_WINDOWS_CERT_THUMBPRINT: "AB CD EF" };
  const signed = await desktopSignWindows(["a.exe"], {
    run,
    has: (cmd) => Promise.resolve(cmd === "signtool"),
    env: (name) => env[name],
    warn: () => {},
  });
  assert(signed);
  assertStringIncludes(calls[0].cmd.join(" "), "signtool sign /sha1 ABCDEF /fd sha256");
});

Deno.test("package-windows.ts: signs the bundle's PE files before wrapping it, then the .msi", () => {
  const script = scaffoldFiles({ dir: "/x", desktop: true } as never)
    .find((f) => f.path === "scripts/package-windows.ts")!.content;
  const body = script.slice(script.indexOf("async function packageArch("));
  const signBundle = body.indexOf("if (signing) {\n    await signBundle(dir, ");
  assert(signBundle > 0, "the bundle is signed");
  assertStringIncludes(script, "if (await sign(await desktopPeFiles(dir)) && "); // every PE file
  assert(
    signBundle > body.indexOf("bundleDesktopVcRuntime(dir, arch)"),
    "after the VC++ runtime lands",
  );
  assert(signBundle < body.indexOf("await msi("), "before the .msi wraps it");
  assert(signBundle < body.indexOf("zipBundle("), "before the .zip wraps it");
  assert(body.indexOf("if (built && signing) await sign([built]);") > body.indexOf("await msi("));
  assertStringIncludes(script, "return await desktopSignWindows(files);");
  assert(!script.includes("sign(`${dir}/${name}-${LABELS[arch]}.exe`)"), "not the .exe alone");
});
