// `denext build --compile --sign` / `compile.sign` (src/build/compile-sign.ts) and the signing
// primitives it shares with `denext desktop package` (src/build/code-signing.ts). Every tool is a
// fake: the runner records the argv (and reads the files a command takes while they exist).
// One test signs a real Mach-O ad-hoc with the real codesign on a Mac.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  macosCodesignArgs,
  notaryCredentials,
  notarytoolSubmitArgs,
  osslsigncodeArgs,
  parseNotaryResult,
  signingReadiness,
  signingReadinessLines,
  signingReady,
  signtoolArgs,
  windowsCertificate,
  windowsSignTool,
} from "../src/build/code-signing.ts";
import {
  compileSignRequested,
  type SignCommandResult,
  signCompiledBinary,
} from "../src/build/compile-sign.ts";
import { parsePlist, type PlistDict } from "../src/build/plist-value.ts";
import { compileSigningCheck } from "../src/cli/commands/doctor.ts";
import type { DenextConfig } from "../src/server/config.ts";

const MAC = "aarch64-apple-darwin";
const WIN = "x86_64-pc-windows-msvc";

/** A recording runner; `respond` answers a command (default: success, no output). */
function recorder(respond?: (cmd: readonly string[]) => Partial<SignCommandResult> | void) {
  const calls: Array<{ cmd: string[]; secrets: string[]; entitlements?: Record<string, unknown> }> =
    [];
  const run = async (cmd: readonly string[], secrets: readonly string[]) => {
    const call: (typeof calls)[number] = { cmd: [...cmd], secrets: [...secrets] };
    const at = cmd.indexOf("--entitlements");
    if (at >= 0) {
      // The plist exists only while the command runs: read it now.
      const dict = parsePlist(await Deno.readTextFile(cmd[at + 1])) as PlistDict;
      call.entitlements = Object.fromEntries(
        dict.entries.map(([k, v]) => [k, v.kind === "bool" ? v.value : v.kind]),
      );
    }
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...(respond?.(cmd) ?? {}) };
  };
  return { calls, run };
}

const envOf = (vars: Record<string, string>) => (name: string) => vars[name] || undefined;

Deno.test("macosCodesignArgs: the desktop script's argv, ad-hoc and with an identity", () => {
  // The package script's former inline argv, byte for byte.
  assertEquals(
    macosCodesignArgs("A.app", { entitlementArgs: ["--preserve-metadata=entitlements"] }),
    [
      "codesign",
      "--force",
      "--timestamp=none",
      "--preserve-metadata=entitlements",
      "-s",
      "-",
      "A.app",
    ],
  );
  assertEquals(
    macosCodesignArgs("A.app/Contents/MacOS/lib.dylib", {
      identity: "Developer ID Application: A (TEAM123456)",
      entitlementArgs: ["--entitlements", "e.plist"],
      identifier: "com.example.app",
    }),
    [
      "codesign",
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      "e.plist",
      "--identifier",
      "com.example.app",
      "-s",
      "Developer ID Application: A (TEAM123456)",
      "A.app/Contents/MacOS/lib.dylib",
    ],
  );
  // Ad-hoc with the Hardened Runtime (the compiled binary's local test path).
  assertEquals(macosCodesignArgs("bin", { identity: "-", hardened: true }), [
    "codesign",
    "--force",
    "--timestamp=none",
    "--options",
    "runtime",
    "-s",
    "-",
    "bin",
  ]);
});

Deno.test("notary credentials: a keychain profile, else an App Store Connect API key", () => {
  assertEquals(notaryCredentials(envOf({})), undefined);
  assertEquals(notaryCredentials(envOf({ DENEXT_NOTARY_KEY: "k.p8" })), undefined, "needs the id");
  const profile = notaryCredentials(
    envOf({ DENEXT_NOTARY_PROFILE: "denext", DENEXT_NOTARY_KEY: "k" }),
  )!;
  assertEquals(profile, { kind: "keychain-profile", profile: "denext" });
  assertEquals(notarytoolSubmitArgs("a.zip", profile), [
    "xcrun",
    "notarytool",
    "submit",
    "a.zip",
    "--keychain-profile",
    "denext",
    "--wait",
  ]);
  const key = notaryCredentials(envOf({
    DENEXT_NOTARY_KEY: "/k/AuthKey.p8",
    DENEXT_NOTARY_KEY_ID: "ABC123",
    DENEXT_NOTARY_ISSUER: "iss-uuid",
  }))!;
  assertEquals(notarytoolSubmitArgs("a.zip", key, true).slice(4), [
    "--key",
    "/k/AuthKey.p8",
    "--key-id",
    "ABC123",
    "--issuer",
    "iss-uuid",
    "--wait",
    "--output-format",
    "json",
  ]);
  assertEquals(
    parseNotaryResult(
      'Conducting pre-submission checks\n{"id":"u-1","status":"Accepted","message":"ok"}',
    ),
    { id: "u-1", status: "Accepted", message: "ok" },
  );
  assertEquals(parseNotaryResult("no json"), undefined);
  assertEquals(parseNotaryResult("{broken"), undefined);
});

Deno.test("Windows certificate: a .pfx (with its password), else a store thumbprint", () => {
  assertEquals(windowsCertificate(envOf({})), undefined);
  const pfx = windowsCertificate(envOf({
    DENEXT_WINDOWS_CERT: "c.pfx",
    DENEXT_WINDOWS_CERT_PASSWORD: "pw",
    DENEXT_WINDOWS_CERT_THUMBPRINT: "AB",
  }))!;
  assertEquals(pfx, { kind: "pfx", path: "c.pfx", password: "pw" });
  const thumb = windowsCertificate(envOf({ DENEXT_WINDOWS_CERT_THUMBPRINT: "ab cd ef" }))!;
  assertEquals(thumb, { kind: "thumbprint", sha1: "abcdef" });
  assertEquals(
    windowsCertificate(envOf({ DENEXT_WINDOWS_CERT_THUMBPRINT: "ab" }), false),
    undefined,
  );
  assertEquals(signtoolArgs(["a.exe"], pfx, "http://ts"), [
    "signtool",
    "sign",
    "/f",
    "c.pfx",
    "/fd",
    "sha256",
    "/tr",
    "http://ts",
    "/td",
    "sha256",
    "/p",
    "pw",
    "a.exe",
  ]);
  assertEquals(signtoolArgs(["a.exe"], thumb).slice(2, 4), ["/sha1", "abcdef"]);
  const ossl = osslsigncodeArgs("in.exe", "out.exe", "c.pfx", "/tmp/pass", "http://ts");
  assertEquals(ossl, [
    "osslsigncode",
    "sign",
    "-pkcs12",
    "c.pfx",
    "-readpass",
    "/tmp/pass",
    "-h",
    "sha256",
    "-ts",
    "http://ts",
    "-in",
    "in.exe",
    "-out",
    "out.exe",
  ]);
  assert(!osslsigncodeArgs("i", "o", "c.pfx", undefined).includes("-readpass"));
});

Deno.test("windowsSignTool: signtool on Windows, osslsigncode elsewhere", async () => {
  const has = (tools: string[]) => (cmd: string) => Promise.resolve(tools.includes(cmd));
  assertEquals(await windowsSignTool(has(["signtool", "osslsigncode"]), "windows"), "signtool");
  assertEquals(await windowsSignTool(has(["osslsigncode"]), "windows"), "osslsigncode");
  assertEquals(await windowsSignTool(has(["signtool", "osslsigncode"]), "linux"), "osslsigncode");
  assertEquals(await windowsSignTool(has([]), "darwin"), undefined);
});

Deno.test("compileSignRequested: --sign, or a compile.sign that is not false", () => {
  assert(compileSignRequested(true, undefined));
  assert(compileSignRequested(false, true));
  assert(compileSignRequested(false, { notarize: false }));
  assert(!compileSignRequested(false, false));
  assert(!compileSignRequested(false, undefined));
});

/** A project dir and a fake binary in it. */
async function fixture(): Promise<{ dir: string; bin: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_compile_sign_" });
  const bin = join(dir, "app");
  await Deno.writeTextFile(bin, "binary");
  return { dir, bin };
}

Deno.test("signCompiledBinary: nothing asked, nothing done", async () => {
  const { calls, run } = recorder();
  assertEquals(
    await signCompiledBinary("x", { explicit: false, target: MAC, projectDir: "." }, { run }),
    undefined,
  );
  assertEquals(calls, []);
});

Deno.test("signCompiledBinary (macOS): Hardened Runtime + timestamp + the JIT entitlement, verified, notarized", async () => {
  const { dir, bin } = await fixture();
  try {
    const identity = "Developer ID Application: A (TEAM123456)";
    const { calls, run } = recorder((cmd) =>
      cmd[1] === "notarytool"
        ? { stdout: '{"id":"sub-1","status":"Accepted","message":"ok"}' }
        : undefined
    );
    const result = await signCompiledBinary(bin, {
      explicit: true,
      target: MAC,
      projectDir: dir,
    }, {
      run,
      os: "darwin",
      has: () => Promise.resolve(true),
      env: envOf({
        DENEXT_CODESIGN_IDENTITY: identity,
        DENEXT_NOTARY_KEY: "/k/AuthKey.p8",
        DENEXT_NOTARY_KEY_ID: "KEYID",
        DENEXT_NOTARY_ISSUER: "ISSUER",
      }),
      warn: () => {},
    });
    assertEquals(calls.map((c) => c.cmd[0] === "xcrun" ? c.cmd[1] : c.cmd[0]), [
      "codesign",
      "codesign",
      "ditto",
      "notarytool",
    ]);
    const [sign, verify, zip, submit] = calls;
    assertEquals(sign.cmd.slice(0, 5), [
      "codesign",
      "--force",
      "--timestamp",
      "--options",
      "runtime",
    ]);
    assertEquals(sign.cmd.slice(-3), ["-s", identity, bin]);
    assertEquals(sign.entitlements, { "com.apple.security.cs.allow-jit": true }, "the minimal set");
    assertEquals(verify.cmd, ["codesign", "--verify", "--strict", "--verbose=2", bin]);
    assertEquals(zip.cmd.slice(0, 5), ["ditto", "-c", "-k", "--keepParent", bin]);
    assertStringIncludes(
      submit.cmd.join(" "),
      "--key /k/AuthKey.p8 --key-id KEYID --issuer ISSUER --wait --output-format json",
    );
    assertEquals(submit.secrets, ["KEYID", "ISSUER"]);
    assert(result?.signed);
    assertStringIncludes(result!.detail, "notarized (submission sub-1; not stapled");
    // The plist and the submission zip are gone.
    for await (const e of Deno.readDir(dir)) assertEquals(e.name, "app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signCompiledBinary (macOS): ffi adds disable-library-validation; an explicit plist keeps its keys", async () => {
  const { dir, bin } = await fixture();
  try {
    await Deno.writeTextFile(
      join(dir, "ents.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><false/><key>com.apple.security.network.client</key><true/></dict></plist>',
    );
    const { calls, run } = recorder();
    await signCompiledBinary(bin, {
      explicit: false,
      config: { entitlements: "ents.plist", notarize: false },
      target: "x86_64-apple-darwin",
      projectDir: dir,
      ffi: true,
    }, {
      run,
      os: "darwin",
      has: () => Promise.resolve(true),
      env: envOf({ DENEXT_CODESIGN_IDENTITY: "-" }),
    });
    assertEquals(calls[0].entitlements, {
      "com.apple.security.cs.allow-jit": false,
      "com.apple.security.network.client": true,
      "com.apple.security.cs.disable-library-validation": true,
    });
    assertEquals(calls.length, 2, "sign + verify, notarize: false");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signCompiledBinary (macOS): notarization rejected, required, or not possible", async () => {
  const { dir, bin } = await fixture();
  const base = { target: MAC, projectDir: dir };
  const deps = (vars: Record<string, string>, stdout = "") => ({
    ...recorder(() => ({ stdout })),
    os: "darwin",
    has: () => Promise.resolve(true),
    env: envOf({ DENEXT_CODESIGN_IDENTITY: "Developer ID Application: A (TEAM123456)", ...vars }),
  });
  try {
    await assertRejects(
      () =>
        signCompiledBinary(bin, { ...base, explicit: true }, {
          ...deps(
            { DENEXT_NOTARY_PROFILE: "p" },
            '{"id":"sub-9","status":"Invalid","message":"The binary is not signed."}',
          ),
        }),
      Error,
      "notarization Invalid (submission sub-9): The binary is not signed. See why with: xcrun notarytool log sub-9",
    );
    await assertRejects(
      () =>
        signCompiledBinary(bin, { ...base, explicit: false, config: { notarize: true } }, deps({})),
      Error,
      "compile.sign.notarize: no notary credentials",
    );
    const warnings: string[] = [];
    const r = await signCompiledBinary(bin, { ...base, explicit: true }, {
      ...deps({}),
      warn: (m) => warnings.push(m),
    });
    assert(r?.signed);
    assertStringIncludes(r!.detail, "NOT notarized");
    assertStringIncludes(warnings.join(), "signed but not notarized");
    const adhoc = await signCompiledBinary(bin, { ...base, explicit: true }, {
      ...deps({ DENEXT_CODESIGN_IDENTITY: "-", DENEXT_NOTARY_PROFILE: "p" }),
    });
    assertStringIncludes(
      adhoc!.detail,
      "signed (ad-hoc, Hardened Runtime); not notarized (an ad-hoc",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signCompiledBinary: a missing credential or tool fails --sign, and only warns for compile.sign", async () => {
  const cases: Array<[string, Record<string, string>, string, string[], string]> = [
    [MAC, {}, "darwin", ["codesign"], "no DENEXT_CODESIGN_IDENTITY"],
    [MAC, { DENEXT_CODESIGN_IDENTITY: "-" }, "linux", ["codesign"], "signed on macOS"],
    [MAC, { DENEXT_CODESIGN_IDENTITY: "-" }, "darwin", [], "codesign is not on PATH"],
    [WIN, {}, "linux", ["osslsigncode"], "no DENEXT_WINDOWS_CERT"],
    [WIN, { DENEXT_WINDOWS_CERT: "c.pfx" }, "linux", [], "osslsigncode is not on PATH"],
    [WIN, { DENEXT_WINDOWS_CERT: "c.pfx" }, "windows", [], "signtool is not on PATH"],
    [WIN, { DENEXT_WINDOWS_CERT_THUMBPRINT: "ab" }, "linux", ["osslsigncode"], "only signtool"],
    ["x86_64-unknown-linux-gnu", {}, "linux", [], "Linux executables are not signed"],
  ];
  for (const [target, vars, os, tools, said] of cases) {
    const { calls, run } = recorder();
    const deps = {
      run,
      os,
      env: envOf(vars),
      has: (c: string) => Promise.resolve(tools.includes(c)),
    };
    await assertRejects(
      () => signCompiledBinary("bin", { explicit: true, target, projectDir: "." }, deps),
      Error,
      said,
    );
    const warnings: string[] = [];
    const r = await signCompiledBinary("bin", {
      explicit: false,
      config: true,
      target,
      projectDir: ".",
    }, {
      ...deps,
      warn: (m) => warnings.push(m),
    });
    assertEquals(r?.signed, false, said);
    assertStringIncludes(warnings.join(), said);
    assertStringIncludes(warnings.join(), "left unsigned");
    assertEquals(calls, [], `${said}: nothing ran`);
  }
});

Deno.test("signCompiledBinary (Windows, osslsigncode): the password goes through a 0600 file, never argv", async () => {
  const { dir, bin } = await fixture();
  try {
    let passSeen = "";
    let passPath = "";
    let mode = 0;
    const { calls, run } = recorder((cmd) => {
      const pass = cmd[cmd.indexOf("-readpass") + 1];
      passPath = pass;
      passSeen = Deno.readTextFileSync(pass);
      mode = Deno.statSync(pass).mode! & 0o777;
      Deno.writeTextFileSync(cmd[cmd.indexOf("-out") + 1], "signed");
    });
    const r = await signCompiledBinary(bin, {
      explicit: true,
      config: { timestampUrl: "http://ts.example" },
      target: WIN,
      projectDir: dir,
    }, {
      run,
      os: "linux",
      has: (c) => Promise.resolve(c === "osslsigncode"),
      env: envOf({ DENEXT_WINDOWS_CERT: "/c/app.pfx", DENEXT_WINDOWS_CERT_PASSWORD: "s3cret" }),
    });
    assertEquals(passSeen, "s3cret");
    if (Deno.build.os !== "windows") assertEquals(mode, 0o600);
    assert(!calls[0].cmd.includes("s3cret"), "no password on the command line");
    assertStringIncludes(calls[0].cmd.join(" "), "-pkcs12 /c/app.pfx -readpass");
    assertStringIncludes(calls[0].cmd.join(" "), "-ts http://ts.example -in " + bin);
    assertEquals(await Deno.readTextFile(bin), "signed", "the signed copy replaced the binary");
    assertStringIncludes(
      r!.detail,
      "Authenticode-signed (osslsigncode, timestamp http://ts.example)",
    );
    for await (const e of Deno.readDir(dir)) assertEquals(e.name, "app", "no scratch left");
    // The password file is never beside the release binary, and is gone once signing ends.
    assert(!passPath.startsWith(dir), `the password file sat beside the binary: ${passPath}`);
    await assertRejects(() => Deno.stat(passPath), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Sign `bin` with osslsigncode through `run` (a .pfx with a password). */
function osslsignWith(dir: string, bin: string, run: ReturnType<typeof recorder>["run"]) {
  return signCompiledBinary(bin, { explicit: true, config: {}, target: WIN, projectDir: dir }, {
    run,
    os: "linux",
    has: (c) => Promise.resolve(c === "osslsigncode"),
    env: envOf({ DENEXT_WINDOWS_CERT: "/c/app.pfx", DENEXT_WINDOWS_CERT_PASSWORD: "s3cret" }),
  });
}

Deno.test("signCompiledBinary (osslsigncode): a signing dir a killed run left is swept", async () => {
  const { dir, bin } = await fixture();
  try {
    const stale = join(dir, ".denext-sign-old");
    const fresh = join(dir, ".denext-sign-new");
    for (const d of [stale, fresh]) {
      await Deno.mkdir(d);
      await Deno.writeTextFile(join(d, "pass"), "old-secret");
    }
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Deno.utime(stale, hourAgo, hourAgo);
    const { run } = recorder((cmd) => Deno.writeTextFileSync(cmd[cmd.indexOf("-out") + 1], "s"));
    await osslsignWith(dir, bin, run);
    await assertRejects(() => Deno.stat(stale), Deno.errors.NotFound);
    assert((await Deno.stat(fresh)).isDirectory, "a recent one may be a run still signing");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "signCompiledBinary (osslsigncode): an interrupted signing leaves no password file",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { dir, bin } = await fixture();
    try {
      const ready = join(dir, "ready.json");
      const script = join(dir, "sign.ts");
      const mod = new URL("../src/build/compile-sign.ts", import.meta.url).href;
      await Deno.writeTextFile(
        script,
        `import { signCompiledBinary } from ${JSON.stringify(mod)};
await signCompiledBinary(${JSON.stringify(bin)}, {
  explicit: true, config: {}, target: ${JSON.stringify(WIN)}, projectDir: ${JSON.stringify(dir)},
}, {
  os: "linux",
  has: (c) => Promise.resolve(c === "osslsigncode"),
  env: (k) => ({ DENEXT_WINDOWS_CERT: "/c/app.pfx", DENEXT_WINDOWS_CERT_PASSWORD: "s3cret" })[k],
  run: (cmd) => {
    Deno.writeTextFileSync(${JSON.stringify(ready)}, JSON.stringify(cmd));
    return new Promise(() => {}); // osslsigncode still running when the signal comes
  },
});
`,
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-check",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          script,
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      let cmd: string[] | null = null;
      for (let i = 0; i < 300 && cmd === null; i++) {
        try {
          cmd = JSON.parse(await Deno.readTextFile(ready));
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert(cmd !== null, "the signing step started");
      const pass = cmd[cmd.indexOf("-readpass") + 1];
      assertEquals(await Deno.readTextFile(pass), "s3cret");
      child.kill("SIGINT");
      const { code } = await child.status;
      assertEquals(code, 130);
      await assertRejects(() => Deno.stat(pass), Deno.errors.NotFound);
      for await (const e of Deno.readDir(dir)) {
        assert(!e.name.startsWith(".denext-sign-"), `${e.name} was left beside the binary`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("signCompiledBinary (Windows, signtool): a failure's message has the password redacted", async () => {
  const { run, calls } = recorder(() => ({
    code: 1,
    stderr: "SignTool Error: bad password s3cret",
  }));
  const err = await assertRejects(
    () =>
      signCompiledBinary("C:/app.exe", { explicit: true, target: WIN, projectDir: "." }, {
        run,
        os: "windows",
        has: (c) => Promise.resolve(c === "signtool"),
        env: envOf({ DENEXT_WINDOWS_CERT: "c.pfx", DENEXT_WINDOWS_CERT_PASSWORD: "s3cret" }),
      }),
    Error,
  );
  assertEquals(calls[0].cmd.slice(-3), ["/p", "s3cret", "C:/app.exe"]);
  assertEquals(calls[0].secrets, ["s3cret"]);
  assert(!err.message.includes("s3cret"), err.message);
  assertStringIncludes(err.message, "/p *** C:/app.exe");
  assertStringIncludes(err.message, "bad password ***");
});

Deno.test("signing readiness: what doctor and the UI report, no secret read", async () => {
  const r = await signingReadiness({
    env: envOf({
      DENEXT_CODESIGN_IDENTITY: "Developer ID Application: A (TEAM123456)",
      DENEXT_NOTARY_PROFILE: "p",
      DENEXT_WINDOWS_CERT: "c.pfx",
    }),
    has: (c) => Promise.resolve(c === "codesign" || c === "osslsigncode"),
    identities: () =>
      Promise.resolve([{ name: "Developer ID Application: A (TEAM123456)", sha1: "AA" }]),
    os: "darwin",
  });
  assertEquals(r.macos, {
    identity: "Developer ID Application: A (TEAM123456)",
    identityFound: true,
    notary: "keychain-profile",
    codesign: true,
  });
  assertEquals(r.windows, { certificate: "pfx", signtool: false, osslsigncode: true });
  assert(signingReady(r, "darwin"));
  assert(signingReady(r, "linux"));
  assert(!signingReady(r, "windows"));
  assertEquals(signingReadinessLines(r), [
    'macOS: identity "Developer ID Application: A (TEAM123456)" (in the keychain), notary keychain profile, codesign found',
    "Windows: a .pfx certificate, osslsigncode",
  ]);
  const missing = await signingReadiness({
    env: envOf({ DENEXT_CODESIGN_IDENTITY: "Developer ID Application: B (OTHER12345)" }),
    has: () => Promise.resolve(false),
    identities: () => Promise.resolve([]),
    os: "darwin",
  });
  assertEquals(missing.macos.identityFound, false);
  assert(!signingReady(missing, "darwin"));
  assertStringIncludes(
    signingReadinessLines(missing).join("\n"),
    "(NOT in the keychain), no notary",
  );
  assertStringIncludes(
    signingReadinessLines(missing).join("\n"),
    "no DENEXT_WINDOWS_CERT, no signtool / osslsigncode",
  );
});

Deno.test("doctor: a compile signing check only when compile.sign is configured", async () => {
  const deps = {
    env: envOf({ DENEXT_CODESIGN_IDENTITY: "-" }),
    has: (c: string) => Promise.resolve(c === "codesign"),
    identities: () => Promise.resolve([]),
    os: "darwin",
  };
  assertEquals(await compileSigningCheck(undefined, deps), null);
  assertEquals(await compileSigningCheck({ compile: { sign: false } } as DenextConfig, deps), null);
  const check = (await compileSigningCheck({ compile: { sign: true } } as DenextConfig, deps))!;
  assertEquals(check.name, "compile signing");
  assert(check.ok);
  assertEquals(check.critical, false);
  assertStringIncludes(
    check.detail,
    "macOS: ad-hoc identity, no notary credentials, codesign found",
  );
});

Deno.test({
  name: "signCompiledBinary: a real ad-hoc codesign of a Mach-O, verified, and it runs",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_compile_sign_real_" });
    try {
      const bin = join(dir, "echo");
      await Deno.copyFile("/bin/echo", bin);
      const r = await signCompiledBinary(bin, {
        explicit: true,
        target: Deno.build.target,
        projectDir: dir,
      }, { env: envOf({ DENEXT_CODESIGN_IDENTITY: "-" }) });
      assert(r?.signed);
      const shown = await new Deno.Command("codesign", {
        args: ["-dv", "--entitlements", "-", bin],
        stderr: "piped",
        stdout: "piped",
      }).output();
      const text = new TextDecoder().decode(shown.stderr) + new TextDecoder().decode(shown.stdout);
      assertStringIncludes(text, "Signature=adhoc");
      assertStringIncludes(text, "runtime", "the Hardened Runtime flag");
      assertStringIncludes(text, "com.apple.security.cs.allow-jit");
      const out = await new Deno.Command(bin, { args: ["signed"], stdout: "piped" }).output();
      assertEquals(new TextDecoder().decode(out.stdout).trim(), "signed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
