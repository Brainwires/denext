// `denext ui` → the `/desktop` panel: which signing identities this machine holds, which
// `DENEXT_*` variables are set, and the command to run.
//
// The handler is driven directly with a hand-built context, as `ui-config-feature.test.ts` does —
// the kernel's own gates are `tests/ui-server.test.ts`'s subject, not this file's.
//
// Nothing here may depend on the host having a Developer ID certificate: `listSigningIdentities`
// really shells out, so a developer Mac and a Linux CI box hold different keychains. The identity
// source is swapped through `setSigningIdentitySource`, and BOTH renderings are asserted on every
// machine — the guidance for an empty keychain and the escaped table for a full one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SseClients } from "../src/build/sse.ts";
import type { UiContext } from "../src/ui/html.ts";
import { desktopPanel, setSigningIdentitySource, shellQuote } from "../src/ui/features/desktop.ts";
import type { SigningIdentity } from "../src/ui/signing.ts";

/** A project, optionally scaffolded for desktop packaging. */
async function project(scaffolded: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_desktop_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  if (scaffolded) {
    await Deno.mkdir(join(dir, "scripts"), { recursive: true });
    for (const os of ["macos", "windows", "linux"]) {
      await Deno.writeTextFile(join(dir, `scripts/package-${os}.ts`), "// stub\n");
    }
  }
  return dir;
}

/** One request against the panel. */
async function call(dir: string, path: string): Promise<Response> {
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

Deno.test("a project without desktop packaging is told so, not shown dead controls", async () => {
  const dir = await project(false);
  try {
    const body = await (await call(dir, "/desktop")).text();
    assertStringIncludes(body, "was not created with desktop packaging");
    assertStringIncludes(body, "denext create --desktop");
    // The command block belongs to a project that can actually run it.
    assert(!body.includes("denext desktop package"), "no command for a project that cannot run it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("each platform is its own view, named in the document title", async () => {
  const dir = await project(true);
  try {
    const titles: string[] = [];
    for (const path of ["/desktop", "/desktop?tab=windows", "/desktop?tab=linux"]) {
      const body = await (await call(dir, path)).text();
      titles.push(/<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "");
    }
    assertEquals(titles, [
      "Desktop · macOS · denext ui",
      "Desktop · Windows · denext ui",
      "Desktop · Linux · denext ui",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the one true secret is never accepted, shown, or served", async () => {
  const dir = await project(true);
  const KEY = "DENEXT_WINDOWS_CERT_PASSWORD";
  const had = Deno.env.get(KEY);
  Deno.env.set(KEY, "hunter2-not-a-real-password");
  try {
    const body = await (await call(dir, "/desktop?tab=windows")).text();
    // It is named, so you know to set it — being told nothing would be its own failure.
    assertStringIncludes(body, KEY);
    // But there is no field for it, and its value never reaches the page.
    assert(!/name="[^"]*PASSWORD[^"]*"/i.test(body), "no input field carries the password");
    assert(!body.includes("hunter2"), "the value never reaches the HTML");

    // Nor the JSON twin, which is the easier place to leak one by accident.
    const api = await (await call(dir, "/api/desktop?tab=windows")).json();
    const entry = api.env.find((e: { name: string }) => e.name === KEY);
    assertEquals(entry, { name: KEY, set: true, secret: true, value: null });
    assert(!JSON.stringify(api).includes("hunter2"), "the value never reaches the JSON twin");
  } finally {
    if (had === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, had);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a non-secret variable's value IS shown, because it is a name", async () => {
  const dir = await project(true);
  const KEY = "DENEXT_CODESIGN_IDENTITY";
  const had = Deno.env.get(KEY);
  Deno.env.set(KEY, "Developer ID Application: A Name (AAAAAAAAAA)");
  try {
    const body = await (await call(dir, "/desktop")).text();
    // The identity is a name, not a credential: the private key stays in the keychain, and
    // showing it is the whole point of the panel.
    assertStringIncludes(body, "Developer ID Application: A Name (AAAAAAAAAA)");
  } finally {
    if (had === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, had);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Linux says there is nothing to sign, rather than offering empty controls", async () => {
  const dir = await project(true);
  try {
    const body = await (await call(dir, "/desktop?tab=linux")).text();
    assertStringIncludes(body, "There is no signing step");
    assert(!body.includes("DENEXT_CODESIGN_IDENTITY"), "no macOS variables on the Linux view");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a keychain with no Developer ID identity gets the guidance, not an empty table", async () => {
  const dir = await project(true);
  setSigningIdentitySource(() => Promise.resolve([]));
  try {
    const body = await (await call(dir, "/desktop")).text();
    assertStringIncludes(body, "No Developer ID Application identity in this keychain");
    assert(!body.includes("Identities in your keychain"), "no table heading for an empty list");
    // With nothing to answer for you, the identity line is a placeholder — never a quoted "".
    assertStringIncludes(body, "export DENEXT_CODESIGN_IDENTITY=...");
    assertStringIncludes(body, "denext desktop package");
    // The JSON twin agrees.
    assertEquals((await (await call(dir, "/api/desktop")).json()).identities, []);
  } finally {
    setSigningIdentitySource();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the identities found are tabled — names escaped — and the first is offered as the export", async () => {
  const dir = await project(true);
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
  setSigningIdentitySource(() => Promise.resolve(identities));
  const KEY = "DENEXT_CODESIGN_IDENTITY";
  const had = Deno.env.get(KEY);
  Deno.env.delete(KEY); // unset, so the command block has an identity line to compose
  try {
    const body = await (await call(dir, "/desktop")).text();
    assertStringIncludes(body, "Identities in your keychain");
    assert(
      !body.includes("No Developer ID Application identity"),
      "the guidance is for an empty list",
    );
    // Every row: name, Team ID and fingerprint, in the order the keychain printed them.
    for (const id of identities) {
      assertStringIncludes(body, `<code class="mono">${id.sha1}</code>`);
      assertStringIncludes(body, `<td>${id.team}</td>`);
    }
    assertStringIncludes(
      body,
      '<code class="mono">Developer ID Application: A Name (AAAAAAAAAA)</code>',
    );
    assertStringIncludes(
      body,
      '<code class="mono">Developer ID Application: &lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons (BBBBBBBBBB)</code>',
    );
    assert(!body.includes("<script>alert(1)"), "a hostile name never reaches the page as markup");
    assert(body.indexOf("A Name") < body.indexOf("Sons"), "rows keep the keychain's order");
    // The export line is the FIRST identity, single-quoted for a shell (escaped once more for HTML).
    assertStringIncludes(
      body,
      "export DENEXT_CODESIGN_IDENTITY=&#39;Developer ID Application: A Name (AAAAAAAAAA)&#39;",
    );
    assert(
      !body.includes("export DENEXT_CODESIGN_IDENTITY=..."),
      "no placeholder when it can answer",
    );

    // The JSON twin carries the same list, unescaped, because JSON is not HTML.
    const api = await (await call(dir, "/api/desktop")).json();
    assertEquals(api.identities, identities);
  } finally {
    setSigningIdentitySource();
    if (had !== undefined) Deno.env.set(KEY, had);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the copy-paste export line single-quotes the identity, so a hostile name runs nothing", () => {
  // A keychain identity is text the panel did not write. Inside `"…"` a shell still expands
  // `$(…)` and backticks; only `'…'` is inert, and the one character it cannot hold is spelled
  // out as `'\''`.
  const hostile = "Developer ID Application: $(touch /tmp/pwned) `id` $HOME O'Brien (TEAMID)";
  const word = shellQuote(hostile);
  assertEquals(
    word,
    "'Developer ID Application: $(touch /tmp/pwned) `id` $HOME O'\\''Brien (TEAMID)'",
  );
  // Round-trips through a real shell as the literal name, expansions and all.
  const line = `export DENEXT_CODESIGN_IDENTITY=${word}`;
  const { stdout } = new Deno.Command("sh", {
    args: ["-c", `${line}; printf '%s' "$DENEXT_CODESIGN_IDENTITY"`],
    env: { HOME: "/nope" },
  }).outputSync();
  assertEquals(new TextDecoder().decode(stdout), hostile);
  assertEquals(shellQuote(""), "''", "an empty name is still one word");
});
