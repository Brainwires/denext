// `/services` — the supervised `services/` tree as `denext ui` shows it: the service files the
// project has (a directory walk, no import) and the status the running server last wrote to
// `.denext/services.json`. The page never runs project code, so everything it shows comes from
// those two reads; these tests pin what each shape of them renders, and that a snapshot anything
// could have written is shape-checked before it is trusted.

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { readServicesState } from "../src/ui/features/services.ts";
import { type Harness, stopUi, uiOn } from "./helpers/ui-panel.ts";

/** The services page's markup, as a no-JS browser reads it. */
async function page(h: Harness): Promise<string> {
  return await (await fetch(`${h.base}/services`, { headers: h.headers })).text();
}

/** The JSON twin. */
async function twin(h: Harness): Promise<Record<string, unknown>> {
  return await (await fetch(`${h.base}/api/services`, { headers: h.headers })).json();
}

const AT = Date.UTC(2026, 10, 15, 12, 0, 0);

/** A snapshot with a nested supervisor, one restarting child and one with a crash on record. */
const SNAPSHOT = {
  pid: 4242,
  updatedAt: AT,
  supervisors: [{
    name: "services",
    path: "services",
    kind: "supervisor",
    state: "running",
    restarts: 0,
    since: AT,
    strategy: "one_for_one",
    intensity: 3,
    period: 5000,
    children: [
      {
        name: "mailer",
        path: "services/mailer",
        kind: "service",
        state: "restarting",
        restarts: 2,
        since: AT,
        retryAt: AT + 4000,
        lastError: { message: "SMTP refused", at: AT + 1000 },
      },
      {
        name: "workers",
        path: "services/workers",
        kind: "supervisor",
        state: "failed",
        restarts: 1,
        since: AT,
        strategy: "rest_for_one",
        intensity: 1,
        period: 1000,
        children: [{
          name: "queue",
          path: "services/workers/queue",
          kind: "service",
          state: "stopping",
          since: AT,
        }],
      },
    ],
  }],
};

Deno.test("services: the walk lists module names, nested by '/', and skips private and non-module files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_services_" });
  try {
    for (
      const rel of [
        "services/mailer.ts",
        "services/workers/queue.tsx",
        "services/legacy.mjs",
        "services/_helper.ts", // private by convention
        "services/.hidden/x.ts", // a dot directory
        "services/README.md", // not a module
      ]
    ) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), "export default {};\n");
    }
    const state = await readServicesState(dir);
    assertEquals(state.files, ["legacy", "mailer", "workers/queue"]);
    assertEquals(state.snapshot, null, "no server ever wrote a snapshot");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("services: a `services` FILE (not a directory) lists nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_services_" });
  try {
    await Deno.writeTextFile(join(dir, "services"), "not a directory");
    assertEquals((await readServicesState(dir)).files, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("services: a snapshot that is not JSON, or not the snapshot's shape, is ignored", async () => {
  for (const text of ["{ not json", JSON.stringify({ pid: 1, supervisors: [] }), "null"]) {
    const dir = await Deno.makeTempDir({ prefix: "denext_ui_services_" });
    try {
      await Deno.mkdir(join(dir, ".denext"));
      await Deno.writeTextFile(join(dir, ".denext", "services.json"), text);
      assertEquals((await readServicesState(dir)).snapshot, null, text);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("services page: with neither files nor a snapshot it says how to get both", async () => {
  const h = await uiOn({}, {}, "denext_ui_services_");
  try {
    const body = await page(h);
    assertStringIncludes(body, "This project has no services/ directory");
    assertStringIncludes(body, "No status yet");
    assertEquals(await twin(h), { ok: true, dir: h.dir, files: [], snapshot: null });
  } finally {
    await stopUi(h);
  }
});

Deno.test("services page: the snapshot's tree renders depth first with state, restarts, the last error and the retry time", async () => {
  const h = await uiOn(
    {
      "services/mailer.ts": "export default {};\n",
      "services/workers/queue.ts": "export default {};\n",
      ".denext/services.json": JSON.stringify(SNAPSHOT),
    },
    {},
    "denext_ui_services_",
  );
  try {
    const body = await page(h);
    assertStringIncludes(body, "services/: mailer, workers/queue");
    assertStringIncludes(body, `Status as of ${new Date(AT).toISOString()} (process 4242)`);
    assertStringIncludes(body, "services — one_for_one, at most 3 restart(s) per 5000 ms");
    // A restarting child says when it starts again, not since when it has been restarting.
    assertStringIncludes(body, `again at ${new Date(AT + 4000).toISOString()}`);
    assertStringIncludes(body, `SMTP refused (${new Date(AT + 1000).toISOString()})`);
    // Rows are indented by depth, in start order.
    const paths = [...body.matchAll(/<td class="mono">( *services[^<]*)<\/td>/g)].map((m) => m[1]);
    assertEquals(paths, [
      "services",
      "  services/mailer",
      "  services/workers",
      "    services/workers/queue",
    ]);
    // A child with no recorded restarts reads 0.
    assertMatch(
      body,
      /services\/workers\/queue<\/td><td>[\s\S]*?stopping[\s\S]*?<\/td><td>0<\/td>/,
    );
    const json = await twin(h);
    assertEquals(json.files, ["mailer", "workers/queue"]);
    assertEquals((json.snapshot as { pid: number }).pid, 4242);
  } finally {
    await stopUi(h);
  }
});

Deno.test("services page: a snapshot with no supervisor says none is running", async () => {
  const h = await uiOn(
    {
      ".denext/services.json": JSON.stringify({ pid: 7, updatedAt: AT, supervisors: [] }),
    },
    {},
    "denext_ui_services_",
  );
  try {
    assertStringIncludes(await page(h), "No supervisor is running.");
  } finally {
    await stopUi(h);
  }
});
