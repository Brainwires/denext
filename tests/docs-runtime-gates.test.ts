// Docs describe a runtime gate by the capability and how to detect it, never by a release
// number that needs updating as releases ship (the CHANGELOG, a dated record, may name one).
// 3.0.0-denext.19 was tagged but never published, so not even the CHANGELOG may gate on it. The
// desktop hooks that need a newer runtime (`onWillNavigate`, a verified `ctx.caller`) must say
// what detects them and what happens without them; the `ctx.caller` example must not refuse every
// call where the runtime can't mark frames. The generated API reference must carry the 4.17
// exports, and a few reference rows must exist.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const read = (path: string): Promise<string> => Deno.readTextFile(join(ROOT, path));

/** The CHANGELOG's `[Unreleased]` section. */
function unreleasedOf(changelog: string): string {
  const start = changelog.indexOf("## [Unreleased]");
  return changelog.slice(start, changelog.indexOf("\n## [", start + 1));
}

/** The text a reader learns the runtime gates from (the CHANGELOG only above its first release). */
async function publicTexts(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const changelog = await read("CHANGELOG.md");
  out.set("CHANGELOG.md [Unreleased]", unreleasedOf(changelog));
  for (
    const path of [
      "AGENTS.md",
      "FEATURES.md",
      "KNOWN-LIMITATIONS.md",
      "site/app/docs/deploy/content.md",
      "site/app/docs/toolchain/content.md",
      "site/app/docs/desktop/page.tsx",
      "src/server/safe-fetch.ts",
      "src/build/jail-exceptions.ts",
      "src/build/jail-scripts.ts",
      "ROADMAP.md",
      "site/app/docs/runtime-reference/content.md",
      "src/desktop/extension.ts",
      "src/desktop/will-navigate.ts",
    ]
  ) out.set(path, await read(path));
  return out;
}

Deno.test("docs: runtime gates name a capability, not a release that was never published", async () => {
  const offenders: string[] = [];
  for (const [path, text] of await publicTexts()) {
    const pattern = path.startsWith("CHANGELOG")
      ? /3\.0\.0-denext\.19\b/
      : /(?<!2\.9\.7-)\bdenext\.(?:19|20)\b/; // 2.9.7-denext.N is an older line
    for (const line of text.split("\n")) {
      if (pattern.test(line) && !line.includes("JAIL_DECLARED_REDIRECTS_RELEASE")) {
        offenders.push(`${path}: ${line.trim()}`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("docs: onWillNavigate and a verified ctx.caller say what detects them", async () => {
  const agents = await read("AGENTS.md");
  const desktop = await read("site/app/docs/desktop/page.tsx");
  const limits = await read("KNOWN-LIMITATIONS.md");
  const changelog = await read("CHANGELOG.md");
  assert(agents.includes("only on a runtime that reports navigation events"));
  assert(agents.includes("on one that doesn't the hook is never called"));
  assert(agents.includes("only where the runtime marks frames"));
  assert(/a runtime without\s+<code>marksFrames<\/code>/.test(desktop));
  assert(desktop.includes("the hook is never called"));
  // The old sentence about `desktop.app.origin` no longer reads as if it were about the hook.
  assert(agents.includes("`desktop.app.origin` takes effect under denext's pinned"));
  assert(!agents.includes("(`runtimeHasNavigationEvents()`). It takes effect under"));
  assert(limits.includes("`onWillNavigate` needs a runtime that reports navigation events"));
  assert(limits.includes("`ctx.caller.frame` is verified only on CEF and WKWebView"));
  // The CHANGELOG is the dated record: it names the release.
  const unreleased = unreleasedOf(changelog);
  assert(unreleased.includes("Runtime 3.0.0-denext.20 and later"));
});

Deno.test("docs: the ctx.caller example works where frames are not marked", async () => {
  const desktop = await read("site/app/docs/desktop/page.tsx");
  // Requiring `verified` refuses every call on WebView2, WebKitGTK and the pinned runtime.
  assert(!desktop.includes(`frame?.kind !== "main" || !frame.verified`));
  assert(desktop.includes(`frame?.verified ? frame.kind !== "main" : frame?.kind === "sub"`));
  // Popups are not reported, so an example must not branch on "window-open".
  assert(!desktop.includes(`event.kind === "window-open"`));
  assert(desktop.includes("WebView2 starts"));
});

Deno.test("docs: the runtime reference makes no newest-release claim", async () => {
  const text = await read("site/app/docs/runtime-reference/content.md");
  assert(!/the newest release/.test(text));
});

Deno.test("docs: the API reference carries the 4.17 exports", async () => {
  const reference = await read("site/app/docs/api/reference.json");
  for (
    const name of [
      "runtimeCookieJar",
      "RuntimeCookieJar",
      "FetchCookieJar",
      "DesktopCaller",
      "DesktopCallerFrame",
      "runtimeHasNavigationEvents",
      "DesktopWillNavigateEvent",
      "DesktopNavigationKind",
    ]
  ) assert(new RegExp(`"name": "${name}"`).test(reference), name);
});

Deno.test("docs: reference rows and names match the code", async () => {
  const auth = await read("site/app/docs/auth/content.md");
  assert(/^\| `\/native\/passkeys` +\| GET /m.test(auth));
  assert(/^\| `\/native\/passkeys\/:id` +\| DELETE /m.test(auth));
  const env = await read("site/app/docs/environment/content.md");
  assert(/^\| `DENEXT_HTML_REWRITER` /m.test(env));
  // There is no JobTimeoutError class: the error is an `Error` named so.
  const jobs = await read("site/app/docs/jobs/page.tsx");
  assert(jobs.includes(`<code>Error</code> whose <code>name</code> is`));
  const live = await read("site/app/docs/live/page.tsx");
  assert(live.includes("<code>ctx.resubscribe</code>"));
});
