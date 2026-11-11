// scripts/sync-example-locks.ts: the `workspace.links` of an example's deno.lock are derived from
// the root deno.lock and the members' versions, written exactly as Deno writes them, so a build
// of the example (the pre-push budget build, an e2e run) leaves the committed lock unchanged.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  linkedLockFiles,
  printLock,
  syncExampleLocks,
  workspaceLinks,
  workspaceMembers,
} from "../scripts/sync-example-locks.ts";
import { removeTempDir } from "./helpers/temp.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** A workspace root with two members, an example lock (stale) and a few locks to skip. */
async function fixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_sync_locks_" });
  const write = async (rel: string, value: unknown) => {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), typeof value === "string" ? value : json(value));
  };
  await write("deno.json", {
    name: "@x/core",
    version: "2.0.0",
    workspace: ["./packages/plug", "./packages/bare/"],
  });
  await write("packages/plug/deno.json", { name: "@x/plug", version: "0.3.0" });
  await write("packages/bare/deno.json", { name: "@x/bare", version: "1.1.0" });
  await write("deno.lock", {
    version: "5",
    workspace: {
      dependencies: ["jsr:@std/path@1", "npm:ws@8"],
      members: { "packages/plug": { dependencies: ["jsr:@x/core@^2.0.0"] } },
    },
  });
  // Written by Deno at 1.0.0, before `bare` joined the workspace.
  await write("examples/app/deno.lock", {
    version: "5",
    specifiers: { "jsr:@std/path@1": "1.1.6" },
    workspace: {
      links: {
        "jsr:@x/core@1.0.0": { dependencies: ["jsr:@std/path@1"] },
        "jsr:@x/plug@0.2.0": { dependencies: ["jsr:@x/core@^1.0.0"] },
      },
    },
  });
  await write("examples/plain/deno.lock", { version: "5", specifiers: {} });
  await write("examples/app/node_modules/dep/deno.lock", { workspace: { links: {} } });
  await write("site/deno.lock", { version: "5", workspace: { links: {} } });
  return dir;
}

Deno.test("workspaceMembers: the root package and each member, with the root lock's dependency lists", async () => {
  const dir = await fixture();
  try {
    assertEquals([...workspaceMembers(dir)], [
      ["@x/core", { version: "2.0.0", dependencies: ["jsr:@std/path@1", "npm:ws@8"] }],
      ["@x/plug", { version: "0.3.0", dependencies: ["jsr:@x/core@^2.0.0"] }],
      ["@x/bare", { version: "1.1.0", dependencies: [] }],
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("workspaceLinks: every member at its version, sorted by key; no dependencies is {}", () => {
  const links = workspaceLinks(
    new Map([
      ["@x/plug", { version: "0.3.0", dependencies: ["jsr:@x/core@^2.0.0"] }],
      ["@x/core", { version: "2.0.0", dependencies: [] }],
    ]),
  );
  assertEquals(Object.keys(links), ["jsr:@x/core@2.0.0", "jsr:@x/plug@0.3.0"]);
  assertEquals(links["jsr:@x/core@2.0.0"], {});
  assertEquals(links["jsr:@x/plug@0.3.0"], { dependencies: ["jsr:@x/core@^2.0.0"] });
});

Deno.test("linkedLockFiles: the locks that link the workspace, never node_modules or a lock without links", async () => {
  const dir = await fixture();
  try {
    assertEquals(linkedLockFiles(dir), ["examples/app/deno.lock", "site/deno.lock"]);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("syncExampleLocks rewrites only the links, as Deno writes them, and is idempotent", async () => {
  const dir = await fixture();
  try {
    assertEquals(syncExampleLocks(dir), ["examples/app/deno.lock", "site/deno.lock"]);
    assertEquals(
      await Deno.readTextFile(join(dir, "examples/app/deno.lock")),
      json({
        version: "5",
        specifiers: { "jsr:@std/path@1": "1.1.6" },
        workspace: {
          links: {
            "jsr:@x/bare@1.1.0": {},
            "jsr:@x/core@2.0.0": { dependencies: ["jsr:@std/path@1", "npm:ws@8"] },
            "jsr:@x/plug@0.3.0": { dependencies: ["jsr:@x/core@^2.0.0"] },
          },
        },
      }),
    );
    assertEquals(syncExampleLocks(dir), [], "a second run changes nothing");
  } finally {
    await removeTempDir(dir);
  }
});

/** A lock as Deno prints it: `os` / `cpu` lists on one line, everything else as JSON.stringify. */
const DENO_PRINTED = `{
  "version": "5",
  "npm": {
    "@esbuild/darwin-arm64@0.25.5": {
      "integrity": "sha512-x",
      "os": ["darwin"],
      "cpu": ["arm64"]
    },
    "fsevents@2.3.3": {
      "integrity": "sha512-y",
      "os": ["darwin", "ios"],
      "cpu": []
    }
  },
  "workspace": {
    "links": {
      "jsr:@x/bare@1.1.0": {},
      "jsr:@x/core@2.0.0": {
        "dependencies": [
          "jsr:@std/path@1",
          "npm:ws@8"
        ]
      },
      "jsr:@x/plug@0.3.0": {
        "dependencies": [
          "jsr:@x/core@^2.0.0"
        ]
      }
    }
  }
}
`;

Deno.test("syncExampleLocks keeps Deno's one-line os / cpu lists (no rewrite for Deno to undo)", async () => {
  const dir = await fixture();
  try {
    const lock = join(dir, "examples/app/deno.lock");
    await Deno.writeTextFile(lock, DENO_PRINTED);
    syncExampleLocks(dir);
    assertEquals(
      await Deno.readTextFile(lock),
      DENO_PRINTED,
      "a current lock is left as Deno wrote it",
    );
    // A stale one is rewritten in the same format.
    await Deno.writeTextFile(lock, DENO_PRINTED.replace('"jsr:@x/bare@1.1.0": {},\n', ""));
    syncExampleLocks(dir);
    assertEquals(await Deno.readTextFile(lock), DENO_PRINTED);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("the repo's example locks link the current workspace (deno task sync:example-locks)", () => {
  const root = fromFileUrl(new URL("../", import.meta.url));
  const links = json(workspaceLinks(workspaceMembers(root)));
  for (const rel of linkedLockFiles(root)) {
    const lock = JSON.parse(Deno.readTextFileSync(join(root, rel)));
    assertEquals(json(lock.workspace.links), links, `${rel} is stale: run deno task regen`);
  }
});

Deno.test("the repo's example locks are printed as Deno prints them (a Deno run leaves them as they are)", () => {
  const root = fromFileUrl(new URL("../", import.meta.url));
  for (const rel of linkedLockFiles(root)) {
    const text = Deno.readTextFileSync(join(root, rel));
    assertEquals(printLock(JSON.parse(text)), text, `${rel}: run deno task regen`);
  }
});
