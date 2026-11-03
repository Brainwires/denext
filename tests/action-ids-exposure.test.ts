// Server Action ids are salted per build and only referenced actions are callable (Next.js 15's
// model): an id is an HMAC of `module#export` under the build's secret
// (src/server/action-ids.ts), and the server registers only the exports of a `"use server"`
// module that the app's modules import (src/build/action-references.ts). An export nothing
// imports answers like a random id (409, unknown action) in production; `denext dev` keeps it callable and warns.

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  ACTION_ID_SECRET_ENV,
  actionIdSecretDigest,
  setBuildActionIdSecret,
  setLegacyActionIds,
} from "../src/server/action-ids.ts";
import {
  ActionIdSecretError,
  readBuildInfo,
  resetActionIdHealthForTesting,
} from "../src/build/prod-server/manifest.ts";
import type { ProjectPaths } from "../src/build/paths.ts";
import { runHealthChecks } from "../src/server/health.ts";
import { handleAction } from "../src/server/action-handler.ts";
import { bindInlineAction, inlineServerReference } from "../src/server/action-bound.ts";
import {
  actionEndpoint,
  actionIdFor,
  getServerAction,
  registerServerReference,
  type ServerActionRef,
  setUnreferencedActionsPermissive,
  tagServerExports,
} from "../src/runtime/server-action.ts";
import { type GraphModule, referencedActionExports } from "../src/build/action-references.ts";
import { restoreActionIdStateAfterEachTest } from "./helpers/action-id-state.ts";
import { buildBoundaryManifest, resetModuleGraphCache } from "../src/build/module-graph.ts";
import { deserializeBoundary, serializeBoundary } from "../src/build/boundary-manifest.ts";

// The process-wide action-id state these tests change (`setBuildActionIdSecret`,
// `setLegacyActionIds`, `setUnreferencedActionsPermissive`, `DENEXT_ACTION_ID_SECRET`), restored
// after every test: a test that fails half-way must not leave the next one minting ids under its
// secret.
restoreActionIdStateAfterEachTest();

const ORIGIN = "http://app.test";
const SECRET_A = "build-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "build-secret-bbbbbbbbbbbbbbbbbbbbbbbb";

/** POST `/_denext/action/<id>` as the hydrated client does. */
async function call(id: string, args: unknown[] = []): Promise<{ status: number; body: unknown }> {
  const res = await handleAction(
    new Request(ORIGIN + actionEndpoint(id), {
      method: "POST",
      headers: {
        origin: ORIGIN,
        host: "app.test",
        "content-type": "application/json",
        "x-denext-action": "1",
      },
      body: JSON.stringify({ args }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** Run `fn` with `DENEXT_ACTION_ID_SECRET` set to `value` (unset for undefined). */
function withEnvSecret<T>(value: string | undefined, fn: () => T): T {
  const prev = Deno.env.get(ACTION_ID_SECRET_ENV);
  if (value === undefined) Deno.env.delete(ACTION_ID_SECRET_ENV);
  else Deno.env.set(ACTION_ID_SECRET_ENV, value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete(ACTION_ID_SECRET_ENV);
    else Deno.env.set(ACTION_ID_SECRET_ENV, prev);
  }
}

/** The legacy (unsalted) id of `module#export`. */
function legacyId(moduleId: string, name: string): string {
  setLegacyActionIds(true);
  try {
    return actionIdFor(moduleId, name);
  } finally {
    setLegacyActionIds(false);
  }
}

Deno.test("action ids: a build's secret salts them; the same secret mints the same ids", () => {
  withEnvSecret(undefined, () => {
    try {
      setBuildActionIdSecret(SECRET_A);
      const a = actionIdFor("mod", "save");
      assertMatch(a, /^a[\w-]{27}$/, "opaque base64url, no `.`");
      assertEquals(actionIdFor("mod", "save"), a, "stable within a build");
      assertNotEquals(actionIdFor("mod", "remove"), a);
      // Another instance serving the same build (its manifest's secret) agrees.
      setBuildActionIdSecret(null);
      setBuildActionIdSecret(SECRET_A);
      assertEquals(actionIdFor("mod", "save"), a);
      // A new build: new ids, and neither is the predictable legacy hash.
      setBuildActionIdSecret(SECRET_B);
      assertNotEquals(actionIdFor("mod", "save"), a);
      assertNotEquals(a, legacyId("mod", "save"));
      assertMatch(legacyId("mod", "save"), /^a[0-9a-z]+$/);
    } finally {
      setBuildActionIdSecret(null);
    }
  });
});

Deno.test("action ids: DENEXT_ACTION_ID_SECRET mints them when the build recorded none, so separate builds agree", () => {
  try {
    const one = withEnvSecret("shared-deploy-secret-123", () => {
      setBuildActionIdSecret(null);
      return actionIdFor("mod", "save");
    });
    const two = withEnvSecret("shared-deploy-secret-123", () => {
      setBuildActionIdSecret(null);
      return actionIdFor("mod", "save");
    });
    assertEquals(one, two, "two builds under one env secret");
    const other = withEnvSecret("another-deploy-secret-4", () => actionIdFor("mod", "save"));
    assertNotEquals(other, one);
    withEnvSecret("short", () => {
      assertThrows(() => actionIdFor("mod", "save"), Error, ACTION_ID_SECRET_ENV);
    });
    // The build's recorded secret is the one the client bundle carries ids for: authoritative.
    const recorded = withEnvSecret("shared-deploy-secret-123", () => {
      setBuildActionIdSecret(SECRET_A);
      return actionIdFor("mod", "save");
    });
    assertEquals(recorded, withEnvSecret(undefined, () => actionIdFor("mod", "save")));
    assertNotEquals(recorded, one);
  } finally {
    setBuildActionIdSecret(null);
  }
});

/** `readBuildInfo` over a `manifest.json` holding `manifest`, with `DENEXT_ACTION_ID_SECRET` as `env`. */
async function startWith(manifest: Record<string, unknown>, env: string | undefined) {
  const outDir = await Deno.makeTempDir({ prefix: "denext_action_secret_" });
  try {
    await Deno.writeTextFile(join(outDir, "manifest.json"), JSON.stringify(manifest));
    const paths = { outDir, projectDir: outDir } as unknown as ProjectPaths;
    const prev = Deno.env.get(ACTION_ID_SECRET_ENV);
    if (env === undefined) Deno.env.delete(ACTION_ID_SECRET_ENV);
    else Deno.env.set(ACTION_ID_SECRET_ENV, env);
    try {
      await readBuildInfo(paths);
      return actionIdFor("mod", "save");
    } finally {
      if (prev === undefined) Deno.env.delete(ACTION_ID_SECRET_ENV);
      else Deno.env.set(ACTION_ID_SECRET_ENV, prev);
    }
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
}

Deno.test("denext start: a runtime-only DENEXT_ACTION_ID_SECRET is ignored for a build that generated its own, with one warning and health up", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    resetActionIdHealthForTesting();
    const expected = withEnvSecret(undefined, () => {
      setBuildActionIdSecret(SECRET_A);
      return actionIdFor("mod", "save");
    });
    setBuildActionIdSecret(null);
    assertEquals((await runHealthChecks()).checks["action-ids"], undefined, "healthy before");
    // The build generated SECRET_A (the variable was not set then); ops sets another value now.
    assertEquals(
      await startWith({ actionIdSecret: SECRET_A }, "runtime-only-secret-xyz"),
      expected,
    );
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertMatch(warnings[0], /DENEXT_ACTION_ID_SECRET is set, but this build generated its own/);
    assertMatch(warnings[0], /set it where `denext build` runs too/);
    // The build's secret serves every action, so the instance stays in rotation.
    assertEquals((await runHealthChecks()).checks["action-ids"], undefined);
    // A second start in the same process (a re-read) warns no more.
    assertEquals(
      await startWith({ actionIdSecret: SECRET_A }, "runtime-only-secret-xyz"),
      expected,
    );
    assertEquals(warnings.length, 1, warnings.join("\n"));
    // The same value, or none: nothing to say.
    assertEquals(await startWith({ actionIdSecret: SECRET_A }, SECRET_A), expected);
    assertEquals(await startWith({ actionIdSecret: SECRET_A }, undefined), expected);
    assertEquals(warnings.length, 1);
    assertEquals((await runHealthChecks()).checks["action-ids"], undefined);
  } finally {
    console.warn = warn;
    setBuildActionIdSecret(null);
    resetActionIdHealthForTesting();
  }
});

Deno.test("denext start: a build minted under DENEXT_ACTION_ID_SECRET refuses to start without the same value", async () => {
  try {
    const built = {
      actionIdSecretEnv: true,
      actionIdSecretDigest: actionIdSecretDigest("shared-deploy-secret-123"),
    };
    const expected = withEnvSecret("shared-deploy-secret-123", () => {
      setBuildActionIdSecret(null);
      return actionIdFor("mod", "save");
    });
    // The same value: the ids the client bundle carries.
    assertEquals(await startWith(built, "shared-deploy-secret-123"), expected);
    // Unset: every action would be unknown, so the start fails and says what to set.
    const unset = await assertRejects(() => startWith(built, undefined), ActionIdSecretError);
    assertMatch(unset.message, /DENEXT_ACTION_ID_SECRET, which is not set here/);
    assertMatch(unset.message, /value `denext build` ran with/);
    assertEquals((await runHealthChecks()).checks["action-ids"], "down");
    resetActionIdHealthForTesting();
    // Another value: told apart by the recorded fingerprint.
    const other = await assertRejects(
      () => startWith(built, "another-deploy-secret-4"),
      ActionIdSecretError,
    );
    assertMatch(other.message, /set to another value here/);
    resetActionIdHealthForTesting();
    // A manifest from before the fingerprint was recorded can't tell: a set value is trusted.
    assertEquals(
      await startWith({ actionIdSecretEnv: true }, "shared-deploy-secret-123"),
      expected,
    );
    await assertRejects(
      () => startWith({ actionIdSecretEnv: true }, undefined),
      ActionIdSecretError,
    );
  } finally {
    setBuildActionIdSecret(null);
    resetActionIdHealthForTesting();
  }
});

Deno.test("an export no module references is refused like a random id; a referenced one runs", async () => {
  const mod = {
    save: async (n: number) => await `saved:${n}`,
    internalWipe: async () => await "wiped",
  };
  const moduleId = "exposure-prod-module";
  tagServerExports(mod, moduleId, "", ["save"]);
  const saveId = actionIdFor(moduleId, "save");
  const wipeId = actionIdFor(moduleId, "internalWipe");
  assertEquals(await call(saveId, [1]), { status: 200, body: { result: "saved:1" } });
  const refused = await call(wipeId);
  assertEquals(refused, await call("a-random-id-nobody-minted"), "indistinguishable from random");
  assertEquals(refused.status, 409);
  assertEquals(getServerAction(wipeId), undefined);
  // Still a server reference on the server (it can be called directly there).
  assertEquals((mod.internalWipe as unknown as ServerActionRef<[], string>).denextActionId, wipeId);
  // `exposed` omitted (a build without the analysis): every export, as before.
  const legacy = { other: async () => await "ok" };
  tagServerExports(legacy, "exposure-legacy-module");
  assertEquals((await call(actionIdFor("exposure-legacy-module", "other"))).status, 200);
});

Deno.test("dev keeps an unreferenced export callable and warns once that production refuses it", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  setUnreferencedActionsPermissive(true);
  try {
    const mod = { draft: async () => await "drafted" };
    tagServerExports(mod, "exposure-dev-module", "", []);
    const id = actionIdFor("exposure-dev-module", "draft");
    assertEquals(await call(id), { status: 200, body: { result: "drafted" } });
    await call(id);
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assertMatch(warnings[0], /exposure-dev-module#draft.*no module imports it/);
    // Once production tags it, it is gone.
    setUnreferencedActionsPermissive(false);
    tagServerExports(mod, "exposure-dev-module", "", []);
    assertEquals((await call(id)).status, 409);
  } finally {
    setUnreferencedActionsPermissive(false);
    console.warn = warn;
  }
});

Deno.test("a bound reference to a referenced export and an inline action still dispatch", async () => {
  const mod = {
    tag: async (label: string, n: number) => await `${label}:${n}`,
  };
  tagServerExports(mod, "exposure-bound-module", "", ["tag"]);
  const bound = (mod.tag as unknown as ServerActionRef<[string, number], string>).bind(
    null,
    "x",
  ) as unknown as ServerActionRef<[number], string>;
  assertEquals(await call(bound.denextActionId, [2]), { status: 200, body: { result: "x:2" } });
  // An inline `"use server"` closure (the transform's runtime): registered under its own id.
  const inline = inlineServerReference(
    actionIdFor("file:///app/page.tsx", "inline:0:add"),
    async (prefix: unknown, n: unknown) => await `${prefix}${n}`,
    1,
  );
  const site = bindInlineAction(inline, () => ["p"], "add");
  assertEquals(await call(site.denextActionId, [3]), { status: 200, body: { result: "p3" } });
});

Deno.test("a bound reference to an explicit id with a `.` resolves (split at the last `.`)", async () => {
  const del = registerServerReference("posts.delete", async (id: string) => await `deleted:${id}`);
  const bound = (del as unknown as ServerActionRef<[string], string>).bind(
    null,
    "p1",
  ) as unknown as ServerActionRef<[], string>;
  assert(bound.denextActionId.startsWith("posts.delete."));
  assertEquals(await call(bound.denextActionId), { status: 200, body: { result: "deleted:p1" } });
});

// ---- The reference analysis ------------------------------------------------------------------

/** A graph of in-memory modules: URL → [source, { written specifier → URL }]. */
function graph(
  mods: Record<string, [string, Record<string, string>?]>,
): { modules: GraphModule[]; read: (url: string) => Promise<string | null> } {
  const url = (name: string) => `file:///app/${name}`;
  return {
    modules: Object.entries(mods).map(([name, [, deps = {}]]) => ({
      specifier: url(name),
      dependencies: Object.entries(deps).map(([spec, to]) => ({
        specifier: spec,
        code: { specifier: url(to) },
      })),
    })),
    read: (u) => Promise.resolve(mods[u.slice("file:///app/".length)]?.[0] ?? null),
  };
}

Deno.test("referencedActionExports: named, default, re-exported and star-exported names", async () => {
  const { modules, read } = graph({
    "actions.ts": [`"use server";\nexport async function save() {}\nexport async function wipe() {}
export async function rename() {}\nexport default async function main() {}`],
    "more.ts": [
      `"use server";\nexport async function archive() {}\nexport async function purge() {}`,
    ],
    "barrel.ts": [
      `export { rename as renameItem } from "./actions.ts";\nexport * from "./more.ts";`,
      { "./actions.ts": "actions.ts", "./more.ts": "more.ts" },
    ],
    "button.tsx": [
      `"use client";\nimport main, { save } from "./actions.ts";\nimport type { Kind } from "./types.ts";`,
      { "./actions.ts": "actions.ts" },
    ],
    "page.tsx": [
      `import { renameItem, archive } from "./barrel.ts";\nexport default function P() {}`,
      { "./barrel.ts": "barrel.ts" },
    ],
  });
  const servers = new Map([
    ["file:///app/actions.ts", ["save", "wipe", "rename", "default"]],
    ["file:///app/more.ts", ["archive", "purge"]],
  ]);
  const refs = await referencedActionExports(modules, servers, read);
  assertEquals([...refs.get("file:///app/actions.ts") as Set<string>].sort(), [
    "default",
    "rename",
    "save",
  ]);
  assertEquals([...refs.get("file:///app/more.ts") as Set<string>], ["archive"]);
});

Deno.test("referencedActionExports: what it can't follow references every export", async () => {
  const { modules, read } = graph({
    "a.ts": [`"use server";\nexport async function x() {}`],
    "b.ts": [`"use server";\nexport async function y() {}`],
    "c.ts": [`"use server";\nexport async function z() {}`],
    "d.ts": [`"use server";\nexport async function w() {}`],
    "e.ts": [`"use server";\nexport async function v() {}\nexport async function u() {}`],
    "both.tsx": [`import { v } from "./e.ts";\nconst all = () => import("./e.ts");`, {
      "./e.ts": "e.ts",
    }],
    "ns.tsx": [`import * as acts from "./a.ts";`, { "./a.ts": "a.ts" }],
    "lazy.tsx": [`const m = () => import("./b.ts");`, { "./b.ts": "b.ts" }],
    // The graph's edge is spelled in a way the source does not show (an import-map rewrite).
    "rewritten.tsx": [`import { z } from "@/c";`, { "file:///app/c.ts": "c.ts" }],
    "broken.tsx": [`import { w } from "./d.ts"; export const = ;`, { "./d.ts": "d.ts" }],
  });
  const servers = new Map(
    ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((n) => [`file:///app/${n}`, []]),
  );
  const refs = await referencedActionExports(modules, servers, read);
  for (const s of servers.keys()) assertEquals(refs.get(s), "*", s);
});

Deno.test("buildBoundaryManifest records each action module's referenced exports", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_exposed_" }));
  try {
    await Deno.writeTextFile(
      join(app, "actions.ts"),
      `"use server";\nexport async function save() {}\nexport async function wipe() {}\n`,
    );
    await Deno.writeTextFile(
      join(app, "page.tsx"),
      `import { save } from "./actions.ts";\nexport default function P() { return save; }\n`,
    );
    resetModuleGraphCache();
    const bm = await buildBoundaryManifest(app, [join(app, "page.tsx")], {
      exportsOf: () => ["save", "wipe"],
    });
    const ref = [...bm.server.values()][0];
    assertEquals(ref.url, toFileUrl(join(app, "actions.ts")).href);
    assertEquals(ref.exposed, ["save"]);
    // It survives the build manifest round trip the production server reads.
    const back = deserializeBoundary(serializeBoundary(bm, app), app);
    assertEquals([...back.server.values()][0].exposed, ["save"]);
  } finally {
    resetModuleGraphCache();
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("a new build's secret re-tags the exports; a serverAction ref keeps its own id", async () => {
  const explicit = registerServerReference("exposure.explicit", async () => await "explicit");
  const mod: Record<string, unknown> = { save: async () => await "saved", explicit };
  try {
    setBuildActionIdSecret(SECRET_A);
    tagServerExports(mod, "exposure-retag-module", "", ["save", "explicit"]);
    const first = (mod.save as ServerActionRef<[], string>).denextActionId;
    setBuildActionIdSecret(SECRET_B);
    tagServerExports(mod, "exposure-retag-module", "", ["save", "explicit"]);
    const second = (mod.save as ServerActionRef<[], string>).denextActionId;
    assertNotEquals(second, first, "tagged again under the new secret");
    assertEquals(second, actionIdFor("exposure-retag-module", "save"));
    assertEquals((await call(second)).status, 200);
    assertEquals(explicit.denextActionId, "exposure.explicit");
  } finally {
    setBuildActionIdSecret(null);
  }
});

/** The build secret ids are minted under right now (the process-wide state's `build`). */
function currentBuildSecret(): unknown {
  const slot = (globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>)[
    Symbol.for("denext.shared.actionIdSecret")
  ];
  return slot?.build;
}

let secretBefore: unknown;
let leftBehind = false;
Deno.test("action-id state: a test that leaves a build secret set (as a failed one would)…", () => {
  secretBefore = currentBuildSecret();
  leftBehind = true;
  setBuildActionIdSecret("left-behind-secret-cccccccccccccccc");
  setUnreferencedActionsPermissive(true);
});

Deno.test("…hands the next test the state as it was (afterEach restores it)", () => {
  if (!leftBehind) return; // shuffled ahead of the test above: nothing was left to restore
  assertEquals(currentBuildSecret(), secretBefore);
  // The exposure policy is back too: production refuses unreferenced exports.
  const slot = (globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>)[
    Symbol.for("denext.shared.serverActionExposure")
  ];
  assertEquals(slot?.permissive, false);
});
