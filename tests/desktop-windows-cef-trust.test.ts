// Windows packaging and the CEF backend: the package script's closing note names what the target
// needs for the backend it built (a CEF app ships Chromium, so no WebView2), and a CEF build signed
// with a certificate Windows does not trust is caught — CEF's bootstrap verifies the executable's
// Authenticode chain with WinVerifyTrust and dies at launch with a FATAL error when it fails. The
// package script checks the signed executable; `denext desktop doctor` checks DENEXT_WINDOWS_CERT.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { desktopWindowsTargetNote } from "../src/build/desktop.ts";
import {
  authenticodeSignature,
  cefCertificateProblem,
  cefSignatureProblem,
  certificateTrust,
  desktopCheckCefSignature,
  type PowerShellRunner,
} from "../src/build/desktop-windows-trust.ts";
import { runDesktopDoctor } from "../src/build/desktop-doctor.ts";
import type { DesktopRuntimeStatus } from "../src/build/desktop-runtime.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";

Deno.test("desktopWindowsTargetNote: a CEF build needs no WebView2; a webview build does", () => {
  const webview = desktopWindowsTargetNote("webview", []);
  assertStringIncludes(webview, "needs the Microsoft Edge WebView2 runtime");
  assertStringIncludes(webview, "no VC++ redistributable is required");
  const cef = desktopWindowsTargetNote("cef", []);
  assert(!cef.includes("needs the Microsoft Edge WebView2"), cef);
  assertStringIncludes(cef, "Chromium (CEF)");
  assertStringIncludes(cef, "no WebView2 runtime");
  const cefNoVc = desktopWindowsTargetNote("cef", ["arm64"]);
  assertStringIncludes(cefNoVc, "for arm64, the VC++ 2015-2022 redistributable");
  assert(!cefNoVc.includes("needs the Microsoft Edge WebView2"), cefNoVc);
  const webviewNoVc = desktopWindowsTargetNote("webview", ["arm64"]);
  assertStringIncludes(webviewNoVc, "WebView2 runtime and, for arm64, the VC++");
});

Deno.test("package-windows.ts: the closing note follows the backend; a signed CEF exe is checked", () => {
  const script = scaffoldFiles({ dir: "/x", desktop: true } as never)
    .find((f) => f.path === "scripts/package-windows.ts")!.content;
  assertStringIncludes(script, "desktopWindowsTargetNote(prepared.meta.backend, noVcRuntime)");
  assert(!script.includes('"\\n  (the target needs the Microsoft Edge WebView2 runtime'));
  // signBundle signs every PE file, then checks a CEF app's signed executable.
  const signBundle = script.slice(script.indexOf("async function signBundle("));
  const check = signBundle.indexOf("await desktopCheckCefSignature(");
  assert(check > 0, "the signed CEF executable is checked");
  assert(check > signBundle.indexOf("await sign(await desktopPeFiles(dir))"), "after signing");
  assertStringIncludes(signBundle, 'backend === "cef"');
  const body = script.slice(script.indexOf("async function packageArch("));
  const signed = body.indexOf("await signBundle(dir, `${name}-${LABELS[arch]}.exe`, meta.backend)");
  assert(signed > 0 && signed < body.indexOf("await msi("), "before the .msi wraps it");
});

/** A PowerShell stub that answers `json` and records the environment it was given. */
function powershell(json: unknown, seen: Record<string, string>[] = []): PowerShellRunner {
  return (_script, env) => {
    seen.push(env);
    return Promise.resolve({ code: 0, stdout: JSON.stringify(json) + "\r\n" });
  };
}

const UNTRUSTED = {
  status: "UnknownError",
  message: "A certificate chain processed, but terminated in a root certificate which is not " +
    "trusted by the trust provider",
};

Deno.test("cefSignatureProblem: only a signature Windows does not trust is a problem", () => {
  assertEquals(cefSignatureProblem({ status: "Valid", message: "" }), undefined);
  assertEquals(cefSignatureProblem({ status: "NotSigned", message: "" }), undefined);
  const problem = cefSignatureProblem(UNTRUSTED)!;
  assertStringIncludes(problem, "UnknownError");
  assertStringIncludes(problem, "WinVerifyTrust");
  assertStringIncludes(problem, "will not start");
});

Deno.test("authenticodeSignature: Windows only; the file goes through the environment", async () => {
  const seen: Record<string, string>[] = [];
  assertEquals(
    await authenticodeSignature("C:\\a b\\App.exe", {
      os: "windows",
      powershell: powershell(UNTRUSTED, seen),
    }),
    UNTRUSTED,
  );
  assertEquals(seen, [{ DENEXT_TRUST_FILE: "C:\\a b\\App.exe" }]);
  assertEquals(
    await authenticodeSignature("x", { os: "darwin", powershell: powershell(UNTRUSTED) }),
    null,
  );
  const broken: PowerShellRunner = () => Promise.resolve({ code: 1, stdout: "" });
  assertEquals(await authenticodeSignature("x", { os: "windows", powershell: broken }), null);
  const garbage: PowerShellRunner = () => Promise.resolve({ code: 0, stdout: "not json" });
  assertEquals(await authenticodeSignature("x", { os: "windows", powershell: garbage }), null);
});

Deno.test("desktopCheckCefSignature: warns with the fix when the signed exe is untrusted", async () => {
  const warnings: string[] = [];
  const ok = await desktopCheckCefSignature("App.exe", {
    os: "windows",
    powershell: powershell(UNTRUSTED),
    warn: (m) => warnings.push(m),
  });
  assertEquals(ok, false);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "will not start");
  assertStringIncludes(warnings[0], "--no-sign");
  const quiet: string[] = [];
  for (const status of ["Valid", "NotSigned"]) {
    assert(
      await desktopCheckCefSignature("App.exe", {
        os: "windows",
        powershell: powershell({ status, message: "" }),
        warn: (m) => quiet.push(m),
      }),
    );
  }
  assert(await desktopCheckCefSignature("App.exe", { os: "linux", warn: (m) => quiet.push(m) }));
  assertEquals(quiet, []);
});

const SELF_SIGNED = {
  trusted: false,
  subject: "CN=Denext Test Signing (self-signed)",
  selfSigned: true,
  problems: ["UntrustedRoot"],
};

Deno.test("certificateTrust: the password reaches PowerShell through the environment only", async () => {
  const seen: Record<string, string>[] = [];
  const trust = await certificateTrust("C:\\c.pfx", "s3cret", {
    os: "windows",
    powershell: powershell(SELF_SIGNED, seen),
  });
  assertEquals(trust, SELF_SIGNED);
  assertEquals(seen, [{ DENEXT_TRUST_CERT: "C:\\c.pfx", DENEXT_TRUST_PASSWORD: "s3cret" }]);
  const problem = cefCertificateProblem(trust!)!;
  assertStringIncludes(
    problem,
    "a self-signed certificate this machine does not trust (UntrustedRoot)",
  );
  assertStringIncludes(problem, "CN=Denext Test Signing");
  assertEquals(cefCertificateProblem({ ...SELF_SIGNED, trusted: true, problems: [] }), undefined);
  assertEquals(await certificateTrust("c.pfx", undefined, { os: "darwin" }), null);
});

const status = (backend: "webview" | "cef"): DesktopRuntimeStatus => ({
  mode: "pinned",
  version: "2.9.7-denext.12",
  target: "x86_64-pc-windows-msvc",
  backend,
  cache: "cached",
  deno: { found: "2.9.7", required: "2.9.7" },
  ok: true,
  detail: `runtime 2.9.7-denext.12 for x86_64-pc-windows-msvc/${backend}; cached + verified`,
});

const certEnv = (key: string) =>
  ({ DENEXT_WINDOWS_CERT: "C:\\c.pfx", DENEXT_WINDOWS_CERT_PASSWORD: "pw" } as Record<
    string,
    string
  >)[key];

Deno.test("desktop doctor: a CEF app with an untrusted DENEXT_WINDOWS_CERT is a warning on Windows", async () => {
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status("cef")),
    os: "windows",
    env: certEnv,
    powershell: powershell(SELF_SIGNED),
  });
  assert(report.checks.includes("cef-signing"), report.checks.join());
  const finding = report.findings.find((f) => f.check === "cef-signing");
  assert(finding, JSON.stringify(report.findings));
  assertEquals(finding.level, "warning");
  assertStringIncludes(finding.message, "WinVerifyTrust");
  assertStringIncludes(finding.fix, "--no-sign");
});

Deno.test("desktop doctor: no CEF signing finding for webview, a trusted cert, no cert, or off Windows", async () => {
  const cases = [
    { backend: "webview" as const, os: "windows", env: certEnv, answer: SELF_SIGNED },
    {
      backend: "cef" as const,
      os: "windows",
      env: certEnv,
      answer: { ...SELF_SIGNED, trusted: true },
    },
    { backend: "cef" as const, os: "windows", env: () => undefined, answer: SELF_SIGNED },
    { backend: "cef" as const, os: "darwin", env: certEnv, answer: SELF_SIGNED },
  ];
  for (const c of cases) {
    const report = await runDesktopDoctor({
      runtimeStatus: () => Promise.resolve(status(c.backend)),
      os: c.os,
      env: c.env,
      powershell: powershell(c.answer),
    });
    assertEquals(report.findings.filter((f) => f.check === "cef-signing"), [], JSON.stringify(c));
  }
});
