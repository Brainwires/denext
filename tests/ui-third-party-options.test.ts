// A third-party plugin's published options schema, as the Plugins panel reads it: the version the
// project's lockfile resolved (else JSR's latest), each registry failure as a reason the page can
// show, the answer reused per version, and the schema itself cleaned before the form trusts it.
// The panel's own suite (ui-plugins-options.test.ts) drives the form; this pins the reader.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  publishedOptionsSchema,
  sanitizeOptionsSchema,
  type SchemaSource,
} from "../src/ui/features/third-party-options.ts";

/** A registry stand-in that records what was asked of it. */
function registry(
  answers: { latest?: string | null; config?: unknown; configFails?: string },
): { source: SchemaSource; calls: string[] } {
  const calls: string[] = [];
  const source: SchemaSource = {
    meta: (scope, name) => {
      calls.push(`meta @${scope}/${name}`);
      return Promise.resolve(
        answers.latest === null || answers.latest === undefined
          ? { ok: false, reason: "404 Not Found" } as never
          : { ok: true, latest: answers.latest },
      );
    },
    config: (scope, name, version) => {
      calls.push(`config @${scope}/${name}@${version}`);
      return Promise.resolve(
        answers.configFails !== undefined
          ? { ok: false, reason: answers.configFails } as never
          : { ok: true, value: answers.config },
      );
    },
  };
  return { source, calls };
}

const SCHEMA = {
  type: "object",
  properties: {
    mode: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "boolean" }] },
    extra: { type: "object", additionalProperties: { type: "string" } },
    open: { type: "object", additionalProperties: true },
  },
};

/** A temp project, optionally with a `deno.lock`. */
async function project(lock?: unknown): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "dnx-third-party-" });
  if (lock !== undefined) await Deno.writeTextFile(join(dir, "deno.lock"), JSON.stringify(lock));
  return dir;
}

Deno.test("published options: the lockfile's version is read, not JSR's latest, and a second read is cached", async () => {
  const dir = await project({
    version: "5",
    specifiers: { "jsr:@acme/plugin-locked@^1.2.0": "1.2.3", "npm:left-pad@1": "1.3.0" },
  });
  try {
    const { source, calls } = registry({
      latest: "9.9.9",
      config: { denext: { catalog: { optionsSchema: SCHEMA } } },
    });
    const first = await publishedOptionsSchema(dir, "@acme/plugin-locked", source);
    assertEquals(first.ok && first.version, "1.2.3");
    assertEquals(first.ok && Object.keys(first.schema.properties ?? {}), ["mode", "extra", "open"]);
    const again = await publishedOptionsSchema(dir, "@acme/plugin-locked", source);
    assertEquals(again.ok && again.version, "1.2.3");
    assertEquals(calls, ["config @acme/plugin-locked@1.2.3"], "no meta call, and one config read");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("published options: each way the registry fails is a reason, not a throw", async () => {
  const dir = await project(); // no lockfile: JSR's latest is asked for
  try {
    const unresolved = await publishedOptionsSchema(
      dir,
      "@acme/missing",
      registry({ latest: null }).source,
    );
    assertEquals(unresolved, {
      ok: false,
      reason: "could not resolve @acme/missing on jsr.io: 404 Not Found",
    });

    const unread = await publishedOptionsSchema(
      dir,
      "@acme/unread",
      registry({ latest: "1.0.0", configFails: "timed out" }).source,
    );
    assertEquals(unread, {
      ok: false,
      reason: "reading @acme/unread@1.0.0 from jsr.io failed: timed out",
    });

    for (const config of [null, { denext: "x" }, { denext: { catalog: [] } }, { denext: {} }]) {
      const none = await publishedOptionsSchema(
        dir,
        "@acme/plain",
        registry({ latest: "2.0.0", config }).source,
      );
      assertEquals(none, {
        ok: false,
        reason: "@acme/plain@2.0.0 publishes no denext.catalog.optionsSchema",
      }, JSON.stringify(config));
    }

    const unusable = await publishedOptionsSchema(
      dir,
      "@acme/odd",
      registry({
        latest: "3.0.0",
        config: { denext: { catalog: { optionsSchema: { type: "string" } } } },
      }).source,
    );
    assertEquals(unusable, {
      ok: false,
      reason:
        "@acme/odd@3.0.0's denext.catalog.optionsSchema is not an options schema the form can show",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("published options: an unreadable lockfile falls back to JSR's latest", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(join(dir, "deno.lock"), "{ not json");
    const { source, calls } = registry({
      latest: "4.0.0",
      config: { denext: { catalog: { optionsSchema: SCHEMA } } },
    });
    const got = await publishedOptionsSchema(dir, "@acme/fallback", source);
    assertEquals(got.ok && got.version, "4.0.0");
    assertEquals(calls, ["meta @acme/fallback", "config @acme/fallback@4.0.0"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sanitizeOptionsSchema: anyOf, additionalProperties and the property names are bounded", () => {
  const ok = sanitizeOptionsSchema(SCHEMA);
  assertEquals(ok?.properties?.open, { type: "object", additionalProperties: true });
  const tooMany = Array.from({ length: 21 }, () => ({ type: "string" }));
  assertEquals(
    sanitizeOptionsSchema({ type: "object", properties: { a: { anyOf: tooMany } } }),
    null,
    "more than 20 branches",
  );
  assertEquals(
    sanitizeOptionsSchema({ type: "object", properties: { a: { anyOf: "x" } } }),
    null,
    "anyOf must be a list",
  );
  assertEquals(
    sanitizeOptionsSchema({ type: "object", properties: { a: { anyOf: [{ enum: [{}] }] } } }),
    null,
    "one bad branch refuses the whole schema",
  );
  assertEquals(sanitizeOptionsSchema({ type: "object", properties: [] }), null);
  assertEquals(
    sanitizeOptionsSchema({ type: "object", properties: JSON.parse('{"__proto__":{}}') }),
    null,
    "a name that reaches the prototype",
  );
  assertEquals(
    sanitizeOptionsSchema({ type: "object", properties: { "a-b": { type: "string" } } }),
    null,
    "a name the config writer cannot own",
  );
  assertEquals(
    sanitizeOptionsSchema({ type: "object", properties: { a: { items: 7 } } }),
    null,
    "a child that is not a schema",
  );
});
