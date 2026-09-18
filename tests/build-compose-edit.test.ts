import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml";
import {
  applyComposeEdits,
  type ComposeOp,
  type ComposeService,
  inspectCompose,
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
      "services:\n  a:\n    image: x\n---\nservices:\n  b:\n    image: y\n", // multi-document
      "services:\n  web:\n    image: [unclosed\n", // does not parse
      "--- {services: {web: {image: a}}}\n", // content on a document marker
      "volumes: {}\n", // no services
    ]
  ) assertEquals(readCompose(text), null, text);
});

/**
 * An alias bomb: nine anchors, each a list of nine aliases of the one before, hung on a service
 * field. Under 600 bytes, and `@std/yaml` parses it in milliseconds — but anything that walks
 * the parse as a tree visits 9^9 nodes, which is what used to hold the UI for ten seconds and
 * then throw "Invalid string length".
 */
function aliasBomb(levels = 9, width = 9): string {
  let text = 'x-a0: &a0 ["lol"]\n';
  for (let i = 1; i < levels; i++) {
    text += `x-a${i}: &a${i} [${Array(width).fill(`*a${i - 1}`).join(", ")}]\n`;
  }
  return `${text}services:\n  web:\n    image: nginx\n    environment: *a${levels - 1}\n`;
}

Deno.test("an alias bomb is opaque within a second, with the reason, not a hang or a throw", () => {
  const bomb = aliasBomb();
  assert(bomb.length < 600, "the bomb is small");
  const started = performance.now();
  const { model, reason } = inspectCompose(bomb);
  assertEquals(model, null);
  assertStringIncludes(reason ?? "", "expand to more than 10000 nodes");
  assertStringIncludes(reason ?? "", "cannot follow");
  assertEquals(readCompose(bomb), null);
  const refused = refusal(bomb, [{ op: "set", service: "web", field: "image", value: "x" }]);
  assertStringIncludes(refused, "expand to more than");
  assert(performance.now() - started < 1000, "the three reads together stay under a second");

  // The cap is on EXPANSION, not on the use of aliases: a file that repeats one anchor a few
  // times is well inside it and still edits.
  const modest = aliasBomb(3, 3);
  assert(readCompose(modest) !== null, "a modest alias tree is still modelled");
  assertStringIncludes(
    edit(modest, [{ op: "set", service: "web", field: "image", value: "x" }]),
    "image: x",
  );
});

Deno.test("mixed line endings: each line keeps its break; a new line takes its neighbour's", () => {
  const text = 'services:\r\n  web:\n    image: a\r\n    ports:\n      - "1:1"\r\n';
  assert(readCompose(text), "a file mixing CRLF and LF is editable");
  assertEquals(
    edit(text, [{ op: "ports", service: "web", action: "add", value: "2:2" }]),
    text + '      - "2:2"\r\n',
  );
  assertEquals(
    edit(text, [{ op: "set", service: "web", field: "image", value: "b" }]),
    text.replace("image: a", "image: b"),
  );
  // a lone CR is a line break to a YAML parser, so it is one to the editor too
  const cr = "services:\r  web:\r    image: a\r";
  assertEquals(
    edit(cr, [{ op: "set", service: "web", field: "restart", value: "always" }]),
    "services:\r  web:\r    image: a\r    restart: always\r",
  );
});

Deno.test("a single document may open with --- and close with ...", () => {
  const text = "--- # compose\nservices:\n  web:\n    image: a\n...\n";
  assert(readCompose(text));
  assertEquals(
    edit(text, [
      { op: "set", service: "web", field: "image", value: "b" },
      { op: "set", service: "web", field: "restart", value: "always" },
    ]),
    "--- # compose\nservices:\n  web:\n    image: b\n    restart: always\n...\n",
  );
});

const MERGED = [
  "x-base: &base",
  "  image: nginx",
  "  restart: always",
  "services:",
  "  web:",
  "    <<: *base",
  "    ports:",
  '      - "80:80"',
  "  api:",
  "    <<: *base",
  "",
].join("\n");

Deno.test("merge keys: a service shows what it inherits; setting a field overrides it", () => {
  const web = readCompose(MERGED)!.services[0];
  assertEquals([web.image, web.restart, web.inherited], ["nginx", "always", ["image", "restart"]]);
  const next = edit(MERGED, [{ op: "set", service: "api", field: "image", value: "node" }]);
  assertStringIncludes(next, "  api:\n    image: node\n    <<: *base\n");
  assertEquals(readCompose(next)!.services.map((s) => s.image), ["nginx", "node"]);
  assertMatch(
    refusal(MERGED, [{ op: "set", service: "api", field: "image", value: null }]),
    /merge key/,
  );
});

Deno.test("an aliased or inherited list gets the service's own copy when edited", () => {
  const text = 'x-ports: &ports\n  - "80:80"\nservices:\n  web:\n    ports: *ports # shared\n' +
    "  api:\n    ports: *ports\n";
  const next = edit(text, [{ op: "ports", service: "web", action: "add", value: "443:443" }]);
  assertStringIncludes(
    next,
    '  web:\n    ports: # shared\n      - "80:80"\n      - "443:443"\n  api:\n    ports: *ports\n',
  );
  assertEquals(readCompose(next)!.services.map((s) => s.ports), [["80:80", "443:443"], ["80:80"]]);
  const env = 'x-env: &env\n  environment:\n    A: "1"\nservices:\n  web:\n    <<: *env\n' +
    "    image: x\n";
  const out = edit(env, [{ op: "env", service: "web", action: "set", key: "B", value: "2" }]);
  assertEquals(readCompose(out)!.services[0].environment, [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ]);
  assertEquals(
    readCompose(edit(env, [{ op: "env", service: "web", action: "delete", key: "A" }]))!
      .services[0].environment,
    [],
  );
});

Deno.test("editing an anchored node that an alias repeats says so in a note", () => {
  const text = "services:\n  base:\n    image: &img nginx\n  web:\n    image: *img\n";
  const r = applyComposeEdits(text, [
    { op: "set", service: "base", field: "image", value: "caddy" },
  ]);
  assert(r.ok);
  assertStringIncludes(r.source, "    image: &img caddy\n");
  assertEquals(readCompose(r.source)!.services.map((s) => s.image), ["caddy", "caddy"]);
  assertEquals(r.notes.length, 1);
  assertStringIncludes(r.notes[0], 'service "web"');
  const own = edit(text, [{ op: "set", service: "web", field: "image", value: "node" }]);
  assertEquals(readCompose(own)!.services.map((s) => s.image), ["nginx", "node"]);
  const plain = applyComposeEdits(GEN, [
    { op: "set", service: "web", field: "image", value: "x" },
  ]);
  assert(plain.ok);
  assertEquals(plain.notes, []);
});

Deno.test("a flow-style or aliased service is rewritten in block style by its first edit", () => {
  const flow = 'services:\n  web: { image: a, ports: ["80:80"] } # front\n  db:\n    image: pg\n';
  assertEquals(readCompose(flow)!.services[0].inline, "flow");
  assertEquals(
    edit(flow, [{ op: "set", service: "web", field: "image", value: "b" }]),
    'services:\n  web: # front\n    image: b\n    ports:\n      - "80:80"\n  db:\n    image: pg\n',
  );
  const alias = "services:\n  web: &web\n    image: a\n  web2: *web\n";
  assertEquals(readCompose(alias)!.services[1].inline, "alias");
  assertEquals(
    edit(alias, [{ op: "set", service: "web2", field: "image", value: "b" }]),
    "services:\n  web: &web\n    image: a\n  web2:\n    image: b\n",
  );
  assertMatch(
    refusal("services:\n  web: {}\n", [{ op: "set", service: "web", field: "image", value: "x" }]),
    /empty mapping/,
  );
});

Deno.test("flow-style lists are edited in place and keep their style", () => {
  const text = "services:\n  web:\n    image: x\n" +
    '    ports: ["80:80", "443:443"] # web\n    depends_on: [db]\n' +
    "  db:\n    image: pg\n  cache:\n    image: redis\n";
  const line3 = (ops: ComposeOp[]) => edit(text, ops).split("\n")[3];
  assertEquals(
    line3([{ op: "ports", service: "web", action: "add", value: "8080:8080" }]),
    '    ports: ["80:80", "443:443", "8080:8080"] # web',
  );
  assertEquals(
    line3([{ op: "ports", service: "web", action: "remove", index: 0 }]),
    '    ports: ["443:443"] # web',
  );
  assertEquals(
    line3([{ op: "ports", service: "web", action: "remove", index: 1 }]),
    '    ports: ["80:80"] # web',
  );
  assertEquals(
    line3([{ op: "ports", service: "web", action: "update", index: 1, value: "8443:443" }]),
    '    ports: ["80:80", "8443:443"] # web',
  );
  assertStringIncludes(
    edit(text, [{ op: "dependsOn", service: "web", action: "add", value: "cache" }]),
    "    depends_on: [db, cache]\n",
  );
  const gone = edit(text, [{ op: "dependsOn", service: "web", action: "remove", value: "db" }]);
  assert(!gone.includes("depends_on"), "the emptied flow field goes");
  assertEquals(
    edit("services:\n  web:\n    image: x\n    volumes: []\n", [
      { op: "volumes", service: "web", action: "add", value: "./data:/data" },
    ]),
    "services:\n  web:\n    image: x\n    volumes: [./data:/data]\n",
  );
});

Deno.test("a flow list over several lines keeps its layout", () => {
  const text = "services:\n  web:\n    image: x\n    ports: [\n" +
    '      "80:80", # http\n      "443:443"\n      ]\n    restart: always\n';
  assertEquals(
    edit(text, [{ op: "ports", service: "web", action: "add", value: "8080:8080" }]),
    text.replace('"443:443"\n', '"443:443", "8080:8080"\n'),
  );
  const out = edit(text, [{ op: "ports", service: "web", action: "remove", index: 1 }]);
  const web = readCompose(out)!.services[0];
  assertEquals([web.ports, web.restart], [["80:80"], "always"]);
});

Deno.test("a flow-style environment mapping is edited in place", () => {
  const text = 'services:\n  web:\n    image: x\n    environment: { A: "1", B: x }\n';
  assertEquals(
    edit(text, [{ op: "env", service: "web", action: "set", key: "B", value: "z" }]),
    text.replace("B: x", "B: z"),
  );
  assertEquals(
    edit(text, [{ op: "env", service: "web", action: "set", key: "C", value: "3" }]),
    text.replace("B: x }", 'B: x, C: "3" }'),
  );
  assertEquals(
    edit(text, [{ op: "env", service: "web", action: "delete", key: "A" }]),
    text.replace('A: "1", ', ""),
  );
});

Deno.test("a flow-style services: is rewritten as block mappings by the first edit", () => {
  const text = "services: { web: { image: a }, db: { image: pg } } # all\nvolumes: {}\n";
  const model = readCompose(text)!;
  assertEquals(model.services.map((s) => [s.name, s.inline]), [["web", "flow"], ["db", "flow"]]);
  assertEquals(
    edit(text, [{ op: "set", service: "web", field: "image", value: "b" }]),
    "services: # all\n  web:\n    image: b\n  db:\n    image: pg\nvolumes: {}\n",
  );
});

Deno.test("addService / removeService: added after the last service, removed whole", () => {
  const added = edit(GEN_PG, [{ op: "addService", service: "cache", image: "redis:7" }]);
  const cache = readCompose(added)!.services.at(-1)!;
  assertEquals([cache.name, cache.image, cache.commented], ["cache", "redis:7", false]);
  assertEquals(edit(added, [{ op: "removeService", service: "cache" }]), GEN_PG);
  assertMatch(refusal(GEN_PG, [{ op: "removeService", service: "db" }]), /depends on "db"/);
  assertMatch(
    refusal(GEN_PG, [{ op: "addService", service: "web", image: "x" }]),
    /already exists/,
  );
  assertMatch(
    refusal(GEN, [{ op: "addService", service: "db", image: "x" }]),
    /commented-out "db" exists/,
  );
  assertMatch(
    refusal(GEN_PG, [{ op: "addService", service: "bad name", image: "x" }]),
    /not a service name/,
  );
  assertMatch(refusal(GEN_PG, [{ op: "addService", service: "x" }]), /image or a build/);
  assertEquals(
    edit("services:\n", [{ op: "addService", service: "web", image: "nginx", build: "." }]),
    "services:\n  web:\n    image: nginx\n    build: .\n",
  );
  assertEquals(
    edit("services: {}\n", [{ op: "addService", service: "web", image: "nginx" }]),
    "services:\n  web:\n    image: nginx\n",
  );
  const noDb = readCompose(edit(GEN, [{ op: "removeService", service: "db" }]))!;
  assertEquals(noDb.services.map((s) => s.name), ["web"]);
  const lone = edit("services:\n  web:\n    image: x\n", [{ op: "removeService", service: "web" }]);
  assertEquals(lone, "services:\n");
});

Deno.test("build: a context path becomes a mapping when another key is set; a mapping edits in place", () => {
  const mapped = edit(GEN, [
    { op: "build", service: "web", key: "dockerfile", value: "Dockerfile.prod" },
  ]);
  assertStringIncludes(mapped, "    build:\n      context: .\n      dockerfile: Dockerfile.prod\n");
  assertStringIncludes(
    edit(mapped, [{ op: "build", service: "web", key: "target", value: "prod" }]),
    "      dockerfile: Dockerfile.prod\n      target: prod\n",
  );
  const moved = edit(mapped, [{ op: "set", service: "web", field: "build", value: "./app" }]);
  assertStringIncludes(moved, "      context: ./app\n      dockerfile: Dockerfile.prod\n");
  assertEquals(
    readCompose(edit(mapped, [{ op: "build", service: "web", key: "dockerfile", value: null }]))!
      .services[0].build,
    { context: "." },
  );
  assertMatch(
    refusal(GEN, [{ op: "build", service: "web", key: "dockerfile", value: null }]),
    /has no dockerfile/,
  );
  assertMatch(
    refusal(GEN, [{ op: "build", service: "web", key: "network" as "target", value: "x" }]),
    /unknown build key/,
  );
});

Deno.test("buildArg: args are set and deleted in the form the file writes them", () => {
  assertStringIncludes(
    edit(GEN, [{
      op: "buildArg",
      service: "web",
      action: "set",
      key: "NODE_VERSION",
      value: "22",
    }]),
    '    build:\n      context: .\n      args:\n        NODE_VERSION: "22"\n',
  );
  const list = "services:\n  web:\n    build:\n      context: .\n      args:\n        - A=1\n";
  assertStringIncludes(
    edit(list, [{ op: "buildArg", service: "web", action: "set", key: "B", value: "2" }]),
    "      args:\n        - A=1\n        - B=2\n",
  );
  assertEquals(
    edit(list, [{ op: "buildArg", service: "web", action: "delete", key: "A" }]),
    "services:\n  web:\n    build:\n      context: .\n",
  );
  assertMatch(
    refusal(list, [{ op: "buildArg", service: "web", action: "delete", key: "Z" }]),
    /have no Z/,
  );
});

Deno.test("declare: top-level volumes and networks are declared and dropped", () => {
  const text = "services:\n  web:\n    image: x\n    volumes:\n      - data:/data\n";
  const declared = edit(text, [{ op: "declare", kind: "volumes", action: "add", name: "data" }]);
  assertEquals(declared, text + "volumes:\n  data:\n");
  assertEquals(readCompose(declared)!.volumes, ["data"]);
  const two = edit(declared, [{ op: "declare", kind: "volumes", action: "add", name: "cache" }]);
  assertEquals(two, text + "volumes:\n  data:\n  cache:\n");
  assertEquals(
    edit(two, [{ op: "declare", kind: "volumes", action: "remove", name: "cache" }]),
    declared,
  );
  assertMatch(
    refusal(two, [{ op: "declare", kind: "volumes", action: "remove", name: "data" }]),
    /still uses data/,
  );
  assertEquals(
    edit(declared, [
      { op: "volumes", service: "web", action: "remove", value: "data:/data" },
      { op: "declare", kind: "volumes", action: "remove", name: "data" },
    ]),
    "services:\n  web:\n    image: x\n",
  );
  const spaced = "services:\n  web:\n    image: x\n\nvolumes:\n  data:\n";
  assertEquals(
    edit(spaced, [{ op: "declare", kind: "networks", action: "add", name: "front" }]),
    spaced + "\nnetworks:\n  front:\n",
  );
});

Deno.test("Compose's !reset and !override tags parse, and a field carrying one is editable", () => {
  const text = 'services:\n  web:\n    image: !reset null\n    ports: !override\n      - "80:80"\n';
  const web = readCompose(text)!.services[0];
  assertEquals([web.image, web.ports], [undefined, ["80:80"]]);
  const next = edit(text, [
    { op: "set", service: "web", field: "image", value: "nginx" },
    { op: "ports", service: "web", action: "add", value: "443:443" },
  ]);
  assertStringIncludes(
    next,
    '    image: nginx\n    ports: !override\n      - "80:80"\n      - "443:443"\n',
  );
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

Deno.test("dependsOn / volumes: add and remove by value, in the short or the long form", () => {
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
  assertEquals(readCompose(long)!.services[0].conditions, { db: "service_healthy" });
  assertEquals(
    edit(long, [{ op: "dependsOn", service: "web", action: "remove", value: "db" }]),
    "services:\n  web:\n    image: x\n  db:\n    image: y\n",
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

Deno.test("toggleService: a commented service with a blank line inside is enabled whole", () => {
  const text = [
    "services:",
    "  web:",
    "    image: web",
    "  # db:",
    "  #   image: postgres",
    "",
    "  #   restart: always",
    "",
  ].join("\n");
  const on = edit(text, [{ op: "toggleService", service: "db" }]);
  const db = readCompose(on)!.services.find((s) => s.name === "db")!;
  assertEquals([db.commented, db.image, db.restart], [false, "postgres", "always"]);
});

Deno.test("removing a field's only entry keeps the commented siblings inside it", () => {
  const text = [
    "services:",
    "  web:",
    "    image: web",
    "    ports:",
    '      - "3000:3000"',
    '      # - "9229:9229"',
    "    restart: always",
    "",
  ].join("\n");
  const out = edit(text, [{ op: "ports", service: "web", action: "remove", index: 0 }]);
  assertStringIncludes(out, '# - "9229:9229"');
  assert(!out.includes("ports:"), "the emptied field is gone");
  assertEquals(readCompose(out)!.services[0].restart, "always");
});

Deno.test("a Unicode line separator makes the file opaque, and an edit can't write one", () => {
  const [ls, nel] = [String.fromCharCode(0x2028), String.fromCharCode(0x85)];
  assertEquals(readCompose(`services:\n  web:\n    image: "a${ls}b"\n`), null);
  assertEquals(readCompose(`services:\n  web:\n    image: web${nel}\n`), null);
  refusal(GEN, [{ op: "set", service: "web", field: "image", value: `a${ls}b` }]);
});

Deno.test("networks: add and remove by value; the long form gains and loses keys", () => {
  const next = edit(GEN, [{ op: "networks", service: "web", action: "add", value: "backend" }]);
  assertEquals(readCompose(next)!.services[0].networks, ["backend"]);
  assertEquals(
    edit(next, [{ op: "networks", service: "web", action: "remove", value: "backend" }]),
    GEN,
  );
  const long = "services:\n  web:\n    image: nginx\n    networks:\n      backend:\n" +
    "        aliases:\n          - api\n";
  assertEquals(readCompose(long)!.services[0].networks, ["backend"]);
  const added = edit(long, [{ op: "networks", service: "web", action: "add", value: "front" }]);
  assertEquals(added, long + "      front:\n");
  assertEquals(readCompose(added)!.services[0].networks, ["backend", "front"]);
  assertEquals(
    edit(added, [{ op: "networks", service: "web", action: "remove", value: "front" }]),
    long,
  );
});

Deno.test("entry: a long-syntax port's keys are set, added and deleted in place", () => {
  const text = [
    "services:",
    "  web:",
    "    image: x",
    "    ports:",
    "      - target: 80 # container",
    '        published: "8080"',
    "        protocol: tcp",
    '      - "443:443"',
    "",
  ].join("\n");
  const port = (key: string, value: string | number | null): ComposeOp => ({
    op: "entry",
    service: "web",
    field: "ports",
    index: 0,
    key,
    value,
  });
  const set = edit(text, [port("published", "9090")]);
  assertEquals(changedLines(text, set), [5]);
  assertStringIncludes(set, '        published: "9090"\n');
  assertStringIncludes(edit(text, [port("target", 81)]), "      - target: 81 # container\n");
  assertStringIncludes(
    edit(text, [port("mode", "host")]),
    "        protocol: tcp\n        mode: host\n",
  );
  const dropped = edit(text, [port("target", null)]);
  assertStringIncludes(dropped, '      - published: "8080"\n        protocol: tcp\n');
  assertEquals(readCompose(dropped)!.services[0].ports[0], '{"published":"8080","protocol":"tcp"}');
  assertMatch(
    refusal(text, [{ ...port("target", 1), index: 1 } as ComposeOp]),
    /not a long-syntax/,
  );
  assertMatch(refusal(text, [port("Bad Key", 1)]), /not a key/);
  assertMatch(refusal(text, [port("name", null)]), /has no name/);
});

Deno.test("entry: a flow-style entry, an entry inside a flow list, and a boolean key", () => {
  const text = "services:\n  web:\n    image: x\n    volumes:\n" +
    "      - { type: bind, source: ./d, target: /d }\n" +
    '    ports: [{ target: 80, published: "8080" }]\n';
  assertStringIncludes(
    edit(text, [
      { op: "entry", service: "web", field: "volumes", index: 0, key: "read_only", value: true },
    ]),
    "      - { type: bind, source: ./d, target: /d, read_only: true }\n",
  );
  assertStringIncludes(
    edit(text, [
      { op: "entry", service: "web", field: "ports", index: 0, key: "published", value: "9090" },
    ]),
    '    ports: [{target: 80, published: "9090"}]\n',
  );
});

Deno.test("condition: a short depends_on list is rewritten in the long form; a long one in place", () => {
  const short = "services:\n  web:\n    image: x\n    depends_on:\n      - db\n      - cache\n" +
    "  db:\n    image: pg\n  cache:\n    image: redis\n";
  const long = edit(short, [
    { op: "condition", service: "web", value: "db", condition: "service_healthy" },
  ]);
  assertStringIncludes(
    long,
    "    depends_on:\n      db:\n        condition: service_healthy\n" +
      "      cache:\n        condition: service_started\n",
  );
  const again = edit(long, [
    {
      op: "condition",
      service: "web",
      value: "cache",
      condition: "service_completed_successfully",
    },
  ]);
  assertEquals(changedLines(long, again).length, 1);
  assertEquals(readCompose(again)!.services[0].conditions, {
    db: "service_healthy",
    cache: "service_completed_successfully",
  });
  const bare =
    "services:\n  web:\n    image: x\n    depends_on:\n      db:\n  db:\n    image: pg\n";
  assertStringIncludes(
    edit(bare, [{ op: "condition", service: "web", value: "db", condition: "service_healthy" }]),
    "      db:\n        condition: service_healthy\n",
  );
  assertStringIncludes(
    edit(short, [
      { op: "dependsOn", service: "web", action: "remove", value: "cache" },
      {
        op: "dependsOn",
        service: "web",
        action: "add",
        value: "cache",
        condition: "service_healthy",
      },
    ]),
    "      cache:\n        condition: service_healthy",
  );
  assertMatch(
    refusal(short, [{
      op: "condition",
      service: "web",
      value: "nope",
      condition: "service_healthy",
    }]),
    /does not list/,
  );
});

Deno.test("set build: replace a context path, insert one, delete it; a mapping build sets its context", () => {
  const replaced = edit(GEN, [{ op: "set", service: "web", field: "build", value: "./app" }]);
  assertEquals(readCompose(replaced)!.services[0].build, "./app");
  const inserted = edit("services:\n  web:\n    image: nginx\n", [
    { op: "set", service: "web", field: "build", value: "./app" },
  ]);
  assertEquals(readCompose(inserted)!.services[0].build, "./app");
  const cleared = edit(GEN, [{ op: "set", service: "web", field: "build", value: null }]);
  assertEquals(readCompose(cleared)!.services[0].build, undefined);
  const mapped =
    "services:\n  web:\n    build:\n      context: .\n      dockerfile: Dockerfile.prod\n";
  assertStringIncludes(
    edit(mapped, [{ op: "set", service: "web", field: "build", value: "./app" }]),
    "    build:\n      context: ./app\n      dockerfile: Dockerfile.prod\n",
  );
});
