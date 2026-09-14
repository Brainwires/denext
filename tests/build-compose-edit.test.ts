import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml";
import {
  applyComposeEdits,
  type ComposeOp,
  type ComposeService,
  readCompose,
} from "../src/build/compose-edit.ts";
import { renderCompose } from "../src/build/docker-template.ts";

const GEN = renderCompose({ mode: "server" });
const GEN_STATIC = renderCompose({ mode: "static", port: 8080 });
const GEN_PG = renderCompose({ mode: "server", postgres: true });

/** The edited source of a successful call (fails the test on a refusal). */
function edit(text: string, ops: ComposeOp[]): string {
  const r = applyComposeEdits(text, ops);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.source;
}

/** The reason of a refused call (fails the test on success). */
function refusal(text: string, ops: ComposeOp[]): string {
  const r = applyComposeEdits(text, ops);
  if (r.ok) throw new Error("expected a refusal");
  assertEquals("source" in r, false);
  return r.reason;
}

/** The indices of lines that differ between two same-length texts. */
function changedLines(a: string, b: string): number[] {
  const x = a.split("\n");
  const y = b.split("\n");
  assertEquals(x.length, y.length, "same line count");
  return x.flatMap((l, i) => l === y[i] ? [] : [i]);
}

Deno.test("readCompose: every generated variant parses, sentinel set", () => {
  for (const text of [GEN, GEN_STATIC, GEN_PG]) {
    const model = readCompose(text);
    assert(model, "generated compose is editable");
    assertEquals(model.sentinel, true);
    const web: ComposeService | undefined = model.services.find((s) => s.name === "web");
    assertEquals(web?.build, ".");
    assertEquals(web?.restart, "unless-stopped");
    assertEquals(web?.envForm, "list");
    assertEquals(web?.environment[0], { key: "NODE_ENV", value: "production" });
  }
  const plain = readCompose(GEN)!;
  assertEquals(plain.services.map((s) => [s.name, s.commented]), [["web", false], ["db", true]]);
  assertEquals(plain.services[0].ports, ["3000:3000"]);
  assertEquals(plain.volumes, []);
  assertEquals(readCompose(GEN_STATIC)!.services[0].ports, ["8080:8080"]);
  const pg = readCompose(GEN_PG)!;
  assertEquals(pg.volumes, ["denext-db"]);
  const db = pg.services.find((s) => s.name === "db")!;
  assertEquals(db.commented, false);
  assertEquals(db.envForm, "map");
  assertEquals(db.dependsOn, []);
  assertEquals(pg.services[0].dependsOn, ["db"]);
  assertEquals(readCompose("services:\n  a:\n    image: x\n")!.sentinel, false);
});

Deno.test("readCompose: line numbers point at each service's name line", () => {
  const lines = GEN.split("\n");
  const model = readCompose(GEN)!;
  assertEquals(model.services[0].line, lines.indexOf("  web:") + 1);
  assertEquals(model.services[1].line, lines.indexOf("  # db:") + 1);
  assertEquals(model.services[1].image, "postgres:16-alpine", "commented service is described");
});

Deno.test("readCompose: unsupported shapes are opaque (null)", () => {
  for (
    const text of [
      "- a\n- b\n", // top level is a list
      "services:\n  - web\n", // services is a list
      "services:\n  web: nginx\n", // service is a scalar
      "x-common: &c\n  image: a\nservices:\n  web:\n    <<: *c\n", // anchors + merge keys
      "services:\n  web:\n    image: &i nginx\n", // an anchor alone
      "services: { web: { image: a } }\n", // flow-style services
      "services:\n  web: { image: a }\n", // flow-style service
      "services:\n  a:\n    image: x\n---\nservices:\n  b:\n    image: y\n", // multi-document
      "services:\n  web:\n    image: [unclosed\n", // does not parse
      "services:\r\n  web:\n    image: x\r\n", // mixed line endings
      "volumes: {}\n", // no services
    ]
  ) assertEquals(readCompose(text), null, text);
});

Deno.test("set image: one line changes; comments and neighbours are byte-identical", () => {
  const next = edit(GEN_PG, [{
    op: "set",
    service: "db",
    field: "image",
    value: "postgres:17-alpine",
  }]);
  const changed = changedLines(GEN_PG, next);
  assertEquals(changed.length, 1);
  assertEquals(next.split("\n")[changed[0]], "    image: postgres:17-alpine");
  assertStringIncludes(next, "    # env_file: .env");
  // an inline comment survives an in-place rewrite; a missing image lands first
  const src = "services:\n  api:\n    build: .\n    restart: always # keep\n";
  assertEquals(
    edit(src, [{ op: "set", service: "api", field: "restart", value: "no" }]),
    'services:\n  api:\n    build: .\n    restart: "no" # keep\n',
  );
  assertEquals(
    edit(src, [{ op: "set", service: "api", field: "image", value: "nginx" }]),
    "services:\n  api:\n    image: nginx\n    build: .\n    restart: always # keep\n",
  );
  assertEquals(
    edit(src, [{ op: "set", service: "api", field: "restart", value: null }]),
    "services:\n  api:\n    build: .\n",
  );
});

Deno.test("ports add: appends at the list's own indentation, or creates the list", () => {
  const next = edit(GEN, [{ op: "ports", service: "web", action: "add", value: "9229:9229" }]);
  assertStringIncludes(
    next,
    '    ports:\n      - "3000:3000"\n      - "9229:9229"\n    environment:',
  );
  // compact sequence (items at the key's indentation) keeps its style
  const compact = 'services:\n  api:\n    image: x\n    ports:\n    - "80:80"\n';
  assertEquals(
    edit(compact, [{ op: "ports", service: "api", action: "add", value: "443:443" }]),
    compact + '    - "443:443"\n',
  );
  // absent: created after image/build
  assertEquals(
    edit("services:\n  api:\n    image: x\n    restart: always\n", [{
      op: "ports",
      service: "api",
      action: "add",
      value: "8000:8000",
    }]),
    'services:\n  api:\n    image: x\n    ports:\n      - "8000:8000"\n    restart: always\n',
  );
});

Deno.test("ports update/remove by index; removing the last entry drops the key", () => {
  const two = edit(GEN, [{ op: "ports", service: "web", action: "add", value: "9229:9229" }]);
  const updated = edit(two, [{
    op: "ports",
    service: "web",
    action: "update",
    index: 0,
    value: "4000:3000",
  }]);
  assertEquals(readCompose(updated)!.services[0].ports, ["4000:3000", "9229:9229"]);
  assertEquals(changedLines(two, updated).length, 1);
  const removed = edit(two, [{ op: "ports", service: "web", action: "remove", index: 1 }]);
  assertEquals(removed, GEN);
  const none = edit(GEN, [{ op: "ports", service: "web", action: "remove", index: 0 }]);
  assert(!none.includes('ports:\n      - "3000'), "the whole field went");
  assertEquals(readCompose(none)!.services[0].ports, []);
  assertMatch(
    refusal(GEN, [{ op: "ports", service: "web", action: "update", index: 5, value: "1:1" }]),
    /no entry #5/,
  );
});

Deno.test("env: map form and list form are preserved; delete works in both", () => {
  // map form (db in the Postgres variant)
  const map = edit(GEN_PG, [
    { op: "env", service: "db", action: "set", key: "POSTGRES_DB", value: "app" },
    { op: "env", service: "db", action: "set", key: "PGDATA", value: "/data" },
    { op: "env", service: "db", action: "delete", key: "POSTGRES_USER" },
  ]);
  assertStringIncludes(
    map,
    "    environment:\n      POSTGRES_PASSWORD: denext\n      POSTGRES_DB: app\n      PGDATA: /data\n",
  );
  // list form (web)
  const list = edit(GEN, [
    { op: "env", service: "web", action: "set", key: "NODE_ENV", value: "development" },
    { op: "env", service: "web", action: "set", key: "DEBUG", value: "1" },
  ]);
  assertStringIncludes(list, "    environment:\n      - NODE_ENV=development\n      - DEBUG=1\n");
  assertEquals(readCompose(list)!.services[0].envForm, "list");
  const gone = edit(list, [{ op: "env", service: "web", action: "delete", key: "DEBUG" }]);
  assertEquals(readCompose(gone)!.services[0].environment, [{
    key: "NODE_ENV",
    value: "development",
  }]);
  assertMatch(
    refusal(GEN, [{ op: "env", service: "web", action: "delete", key: "NOPE" }]),
    /has no NOPE/,
  );
});

Deno.test("values YAML would mis-type are quoted and read back as the same string", () => {
  const values = ["true", "8080", "no", "a: b", "x # y", "", "*star", "5432:5432", 'it\'s "q"'];
  for (const value of values) {
    const next = edit(GEN_PG, [{ op: "env", service: "db", action: "set", key: "V", value }]);
    const env = (parse(next) as { services: { db: { environment: Record<string, unknown> } } })
      .services.db.environment;
    assertEquals(env.V, value, `round-trips ${JSON.stringify(value)}`);
  }
  const quoted = edit(GEN_PG, [{
    op: "env",
    service: "db",
    action: "set",
    key: "FLAG",
    value: "true",
  }]);
  assertStringIncludes(quoted, '      FLAG: "true"\n');
  const port = edit(GEN, [{ op: "ports", service: "web", action: "add", value: "80:80" }]);
  assertStringIncludes(port, '      - "80:80"\n');
});

Deno.test("toggleService: the db example uncomments byte-for-byte and re-comments exactly", () => {
  const on = edit(GEN, [{ op: "toggleService", service: "db" }]);
  const dbBlock = GEN_PG.slice(
    GEN_PG.indexOf("  db:\n"),
    GEN_PG.indexOf('"127.0.0.1:5432:5432"') + 21,
  );
  assertStringIncludes(on, `\n${dbBlock}\n`);
  const model = readCompose(on)!;
  assertEquals(model.services.map((s) => [s.name, s.commented]), [["web", false], ["db", false]]);
  assertEquals(edit(on, [{ op: "toggleService", service: "db" }]), GEN);
  // an active service goes out and back, too
  const off = edit(GEN, [{ op: "toggleService", service: "web" }]);
  assertEquals(readCompose(off)!.services.every((s) => s.commented), true);
  assertEquals(edit(off, [{ op: "toggleService", service: "web" }]), GEN);
});

Deno.test("duplicate keys and unknown or commented services are refused", () => {
  const dup =
    'services:\n  web:\n    image: x\n    ports:\n      - "1:1"\n    ports:\n      - "2:2"\n';
  assertMatch(
    refusal(dup, [{ op: "ports", service: "web", action: "add", value: "3:3" }]),
    /duplicate/,
  );
  assertMatch(
    refusal(GEN, [{ op: "set", service: "nope", field: "image", value: "x" }]),
    /no service named "nope"/,
  );
  assertMatch(
    refusal(GEN, [{ op: "set", service: "db", field: "image", value: "x" }]),
    /commented out/,
  );
});

Deno.test("dependsOn / volumes: add and remove by value; long form refused", () => {
  const next = edit(GEN_PG, [
    { op: "dependsOn", service: "web", action: "add", value: "cache" },
    { op: "volumes", service: "web", action: "add", value: "./data:/data" },
  ]);
  const web = readCompose(next)!.services[0];
  assertEquals(web.dependsOn, ["db", "cache"]);
  assertEquals(web.volumes, ["./data:/data"]);
  assertEquals(
    edit(next, [
      { op: "dependsOn", service: "web", action: "remove", value: "cache" },
      { op: "volumes", service: "web", action: "remove", value: "./data:/data" },
    ]),
    GEN_PG,
  );
  assertMatch(
    refusal(GEN_PG, [{ op: "dependsOn", service: "web", action: "add", value: "db" }]),
    /already lists/,
  );
  const long =
    "services:\n  web:\n    image: x\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: y\n";
  assertEquals(readCompose(long)!.services[0].dependsOn, ["db"]);
  assertMatch(
    refusal(long, [{ op: "dependsOn", service: "web", action: "remove", value: "db" }]),
    /edit it by hand/,
  );
});

Deno.test("a multi-op call applies in order and yields one diff; unknown top-level keys untouched", () => {
  const src = GEN + "networks:\n  default:\n    name: shared # keep me\n";
  const r = applyComposeEdits(src, [
    { op: "set", service: "web", field: "image", value: "app:1" },
    { op: "ports", service: "web", action: "add", value: "9229:9229" },
    { op: "ports", service: "web", action: "update", index: 1, value: "9230:9229" },
    { op: "env", service: "web", action: "set", key: "LOG", value: "debug" },
  ]);
  assert(r.ok);
  assertEquals(r.diff.match(/^--- /gm)?.length, 1, "one diff");
  assertEquals(r.diff.match(/^\+ /gm)?.length, 3, "three added lines");
  assertStringIncludes(r.diff, '+      - "9230:9229"');
  assert(r.source.endsWith("networks:\n  default:\n    name: shared # keep me\n"));
  const web = readCompose(r.source)!.services[0];
  assertEquals([web.image, web.ports], ["app:1", ["3000:3000", "9230:9229"]]);
});

Deno.test("CRLF stays CRLF; a missing trailing newline stays missing", () => {
  const crlf = GEN.replaceAll("\n", "\r\n");
  const next = edit(crlf, [{ op: "ports", service: "web", action: "add", value: "1:1" }]);
  assertEquals(next.split("\r\n").length - 1, next.split("\n").length - 1, "every newline is CRLF");
  assertEquals(
    next.replaceAll("\r\n", "\n"),
    edit(GEN, [{ op: "ports", service: "web", action: "add", value: "1:1" }]),
  );
  const bare = "services:\n  api:\n    image: x";
  assertEquals(
    edit(bare, [{ op: "set", service: "api", field: "restart", value: "always" }]),
    bare + "\n    restart: always",
  );
});

Deno.test("a failing op fails the whole call and leaves the text unchanged", () => {
  const before = GEN;
  const r = applyComposeEdits(before, [
    { op: "set", service: "web", field: "image", value: "app:1" },
    { op: "env", service: "web", action: "set", key: "BAD KEY", value: "x" },
  ]);
  assertEquals(r.ok, false);
  assertEquals(before, GEN);
  assertMatch(refusal("- a\n", [{ op: "toggleService", service: "web" }]), /not a mapping/);
});
