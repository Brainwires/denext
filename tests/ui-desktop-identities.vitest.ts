// `denext ui` → the `/desktop` panel's signing identities. `listSigningIdentities` really shells
// out to `security find-identity`, so a developer Mac and a Linux CI box hold different
// keychains; `vi.mock` replaces it (denext's Deno toolchain; CONTRIBUTING.md → Vitest files) and
// BOTH renderings are asserted on every machine — the guidance for an empty keychain and the
// escaped table for a full one. The PATH probe for the signing tools is replaced too, so nothing
// here spawns a process. The panel's other views are tests/ui-desktop-feature.test.ts.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import type { UiContext } from "../src/ui/html.ts";
import { desktopPanel } from "../src/ui/features/desktop.ts";
import { listSigningIdentities, type SigningIdentity } from "../src/ui/signing.ts";

vi.mock("../src/ui/signing.ts", async (importOriginal: () => Promise<object>) => ({
  ...(await importOriginal()),
  listSigningIdentities: vi.fn(),
  hasCommand: vi.fn(() => Promise.resolve(true)), // `codesign` / `signtool` on PATH: no `which`
}));

let dir = "";

beforeEach(async () => {
  dir = await Deno.makeTempDir({ prefix: "denext_ui_desktop_ids_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "scripts"), { recursive: true });
  for (const os of ["macos", "windows", "linux"]) {
    await Deno.writeTextFile(join(dir, `scripts/package-${os}.ts`), "// stub\n");
  }
  // Unset, so the command block has an identity line to compose.
  vi.stubEnv("DENEXT_CODESIGN_IDENTITY", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(listSigningIdentities).mockReset();
  await Deno.remove(dir, { recursive: true });
});

/** One GET against the panel. */
async function call(path: string): Promise<Response> {
  const url = new URL(`http://127.0.0.1:5177${path}`);
  const ctx: UiContext = {
    dir,
    url,
    method: "GET",
    readOnly: false,
    csrf: "csrf-token",
    json: url.pathname.startsWith("/api/"),
    fragment: false,
    events: new Set() as SseClients,
  };
  return await desktopPanel(new Request(url, { method: "GET" }), ctx);
}

it("a keychain with no Developer ID identity gets the guidance, not an empty table", async () => {
  vi.mocked(listSigningIdentities).mockResolvedValue([]);
  const body = await (await call("/desktop")).text();
  expect(body).toContain("No Developer ID Application identity in this keychain");
  expect(body, "no table heading for an empty list").not.toContain("Identities in your keychain");
  // With nothing to answer for you, the identity line is a placeholder — never a quoted "".
  expect(body).toContain("export DENEXT_CODESIGN_IDENTITY=...");
  expect(body).toContain("denext desktop package");
  // The JSON twin agrees.
  expect((await (await call("/api/desktop")).json()).identities).toEqual([]);
});

it("the identities found are tabled — names escaped — and the first is offered as the export", async () => {
  // A keychain identity is text the panel did not write; the second name here is what a
  // certificate could carry, and the page must show it as text rather than run it.
  const hostile = "Developer ID Application: <script>alert(1)</script> & Sons (BBBBBBBBBB)";
  const identities: SigningIdentity[] = [
    {
      sha1: "5D44043D1F109F96CDF66FB5D21E38573E643C23",
      name: "Developer ID Application: A Name (AAAAAAAAAA)",
      team: "AAAAAAAAAA",
    },
    { sha1: "2B58CDBD54D9C53E25BB8864B027646513CA8BA9", name: hostile, team: "BBBBBBBBBB" },
  ];
  vi.mocked(listSigningIdentities).mockResolvedValue(identities);
  const body = await (await call("/desktop")).text();
  expect(body).toContain("Identities in your keychain");
  expect(body, "the guidance is for an empty list").not.toContain(
    "No Developer ID Application identity",
  );
  // Every row: name, Team ID and fingerprint, in the order the keychain printed them.
  for (const id of identities) {
    expect(body).toContain(`<code class="mono">${id.sha1}</code>`);
    expect(body).toContain(`<td>${id.team}</td>`);
  }
  expect(body).toContain(
    '<code class="mono">Developer ID Application: A Name (AAAAAAAAAA)</code>',
  );
  expect(body).toContain(
    '<code class="mono">Developer ID Application: &lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons (BBBBBBBBBB)</code>',
  );
  expect(body, "a hostile name never reaches the page as markup").not.toContain(
    "<script>alert(1)",
  );
  expect(body.indexOf("A Name"), "rows keep the keychain's order").toBeLessThan(
    body.indexOf("Sons"),
  );
  // The export line is the FIRST identity, single-quoted for a shell (escaped once more for HTML).
  expect(body).toContain(
    "export DENEXT_CODESIGN_IDENTITY=&#39;Developer ID Application: A Name (AAAAAAAAAA)&#39;",
  );
  expect(body, "no placeholder when it can answer").not.toContain(
    "export DENEXT_CODESIGN_IDENTITY=...",
  );
  // The JSON twin carries the same list, unescaped, because JSON is not HTML.
  expect((await (await call("/api/desktop")).json()).identities).toEqual(identities);
});

it("only the macOS view asks the keychain", async () => {
  vi.mocked(listSigningIdentities).mockResolvedValue([]);
  await call("/desktop?tab=windows");
  await call("/desktop?tab=linux");
  expect(listSigningIdentities).not.toHaveBeenCalled();
  await call("/desktop");
  expect(listSigningIdentities).toHaveBeenCalledTimes(1);
});
