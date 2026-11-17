// Docs describe a runtime gate by the capability and how to detect it, never by a release
// number that needs updating as releases ship (the CHANGELOG, a dated record, may name one).
// 3.0.0-denext.19 was tagged but never published, so not even the CHANGELOG may gate on it. The
// desktop hooks that need a newer runtime (`onWillNavigate`, a verified `ctx.caller`) must say
// what detects them and what happens without them; the `ctx.caller` example must not refuse every
// call where the runtime can't mark frames. The generated API reference must carry the 4.17
// exports, and a few reference rows must exist.
//
// The CHANGELOG checks read every section, never just `[Unreleased]`: a release commit folds
// `[Unreleased]` into the version's section and leaves it empty, so a check bound to it fails on
// the release commit and every commit after (4.17.0's did). The last test runs them against a
// CHANGELOG rolled the way `deno task release` rolls it.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { foldPrereleases, groupByHeading, splitSections } from "../scripts/release.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const read = (path: string): Promise<string> => Deno.readTextFile(join(ROOT, path));

/** Every top-level entry (a `- ` bullet with its continuation lines) in every CHANGELOG section. */
function changelogEntries(changelog: string): string[] {
  return splitSections(changelog).flatMap(([, body]) => [...groupByHeading(body).values()].flat());
}

/** CHANGELOG lines that gate on 3.0.0-denext.19, which was tagged but never published. */
function changelogGateOffenders(changelog: string): string[] {
  return changelog.split("\n").filter((line) => /3\.0\.0-denext\.19\b/.test(line))
    .map((line) => `CHANGELOG.md: ${line.trim()}`);
}

/** The will-navigate entry names the release that shipped it, in whichever section holds it. */
function changelogNamesNavigationRelease(changelog: string): boolean {
  const entries = changelogEntries(changelog).filter((e) =>
    e.startsWith("- **Desktop: a will-navigate hook.**")
  );
  return entries.length === 1 && entries[0].includes("Runtime 3.0.0-denext.20 and later");
}

/** The text a reader learns the runtime gates from (the CHANGELOG is checked on its own). */
async function publicTexts(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
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
  const offenders = changelogGateOffenders(await read("CHANGELOG.md"));
  for (const [path, text] of await publicTexts()) {
    const pattern = /(?<!2\.9\.7-)\bdenext\.(?:19|20)\b/; // 2.9.7-denext.N is an older line
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
  assert(changelogNamesNavigationRelease(changelog));
});

Deno.test("docs: the CHANGELOG checks hold on a release commit (an empty [Unreleased])", async () => {
  const changelog = await read("CHANGELOG.md");
  const marker = "## [Unreleased]";
  const date = "2099-01-01";
  const rolled = {
    // A stable release folds [Unreleased] (and the rc sections) into the version's section.
    stable: foldPrereleases(changelog, "99.0.0", date),
    // A prerelease puts its header right under [Unreleased].
    prerelease: changelog.replace(marker, `${marker}\n\n## [99.0.0-rc.1] - ${date}`),
  };
  for (const [kind, text] of Object.entries(rolled)) {
    const unreleased = splitSections(text).find(([h]) => h === marker);
    assert(unreleased, `${kind}: keeps an [Unreleased] header`);
    assertEquals(unreleased[1].trim(), "", `${kind}: [Unreleased] is empty`);
    assertEquals(changelogGateOffenders(text), [], kind);
    assert(changelogNamesNavigationRelease(text), kind);
  }
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

/** A runtime release number: denext's Deno / Deno Desktop runtime (`3.0.0-rc.N`, `3.0.0-denext.N`, `2.9.7-denext.N`). */
const RUNTIME_RELEASE = /\b(?:3\.0\.0-(?:rc|denext)\.\d+|2\.9\.[78]-denext\.\d+)\b/;

/**
 * Docs directories whose subject IS runtime versions (the release record, the runtime release
 * table, the toolchain's version history), and the generated API reference (checked below,
 * symbol by symbol, from the JSDoc it is built from).
 */
const VERSION_PAGES = new Set([
  "changelog",
  "runtime-reference",
  "toolchain",
  "desktop-runtime",
  "api",
]);

/**
 * Lines that may name a runtime release, each with why: a dated record, not a gate. Matched by a
 * substring of the line. Add an entry only for text whose subject is a version, never for a gate.
 */
const VERSION_ALLOWLIST: { path: string; line: string; why: string }[] = [
  // A dated hardware-verification record (the toolchain a VM run used, and what it printed),
  // not a gate: it says when Windows on Arm last ran outside CI.
  {
    path: "KNOWN-LIMITATIONS.md",
    line: "2.9.7-denext.21, 2026-10-19; later runtimes are covered by CI's",
    why: "dated verification record",
  },
  {
    path: "KNOWN-LIMITATIONS.md",
    line: "(`deno --version` reports `2.9.7-denext.21`",
    why: "the output that dated run printed",
  },
];

/** Every Markdown / page source a reader learns runtime gates from, outside the version pages. */
async function gateTexts(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of ["AGENTS.md", "README.md", "KNOWN-LIMITATIONS.md", "FEATURES.md"]) {
    out.set(path, await read(path));
  }
  const docs = join(ROOT, "site/app/docs");
  async function visit(dir: string, rel: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (rel === "" && VERSION_PAGES.has(e.name)) continue;
        await visit(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (/\.(?:md|tsx)$/.test(e.name)) {
        const path = `site/app/docs/${rel ? `${rel}/` : ""}${e.name}`;
        out.set(path, await Deno.readTextFile(join(dir, e.name)));
      }
    }
  }
  await visit(docs, "");
  return out;
}

/** `<path>: <line>` for every line naming a runtime release that the allowlist doesn't cover. */
export function versionPinOffenders(texts: Map<string, string>): string[] {
  const offenders: string[] = [];
  for (const [path, text] of texts) {
    for (const line of text.split("\n")) {
      if (!RUNTIME_RELEASE.test(line)) continue;
      if (VERSION_ALLOWLIST.some((a) => a.path === path && line.includes(a.line))) continue;
      offenders.push(`${path}: ${line.trim()}`);
    }
  }
  return offenders;
}

Deno.test("docs: no runtime release numbers outside the CHANGELOG and the version pages", async () => {
  const texts = await gateTexts();
  assert(texts.has("site/app/docs/desktop/page.tsx"));
  assert(!texts.has("site/app/docs/runtime-reference/content.md"));
  assertEquals(versionPinOffenders(texts), []);
});

Deno.test("docs: the API reference (public JSDoc) names no runtime release", async () => {
  const reference = JSON.parse(await read("site/app/docs/api/reference.json")) as {
    groups: { module: string; symbols: unknown[] }[];
  };
  const offenders = new Set<string>();
  const releaseIn = (key: string, value: unknown): boolean =>
    typeof value === "string" && key !== "signature" && RUNTIME_RELEASE.test(value);
  const visit = (node: unknown, where: string): void => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, where));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const here = o.name ? `${where}.${o.name}` : where;
    for (const [key, value] of Object.entries(o)) {
      if (releaseIn(key, value)) offenders.add(here);
      else visit(value, here);
    }
  };
  for (const group of reference.groups) visit(group.symbols, group.module);
  assertEquals([...offenders], []);
});

Deno.test("versionPinOffenders: flags a gate, keeps an allowlisted line", () => {
  const texts = new Map([
    ["AGENTS.md", "works on runtime 3.0.0-denext.12+"],
    [
      "KNOWN-LIMITATIONS.md",
      "under runtime 2.9.7-denext.20 only\nwhere the runtime has pty\n" +
      "  2.9.7-denext.21, 2026-10-19; later runtimes are covered by CI's job",
    ],
  ]);
  assertEquals(versionPinOffenders(texts), [
    "AGENTS.md: works on runtime 3.0.0-denext.12+",
    "KNOWN-LIMITATIONS.md: under runtime 2.9.7-denext.20 only",
  ]);
});
