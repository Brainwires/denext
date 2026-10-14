// `denext generate docker`'s self-hosted stack: the compose / .env.example / dev-overlay /
// Dockerfile templates (golden snapshots under tests/fixtures/docker-stack — rewrite them with
// `DENEXT_UPDATE_GOLDEN=1 deno test -A tests/docker-stack.test.ts`), the one-list secret
// contract, the project detection, and how flags resolve against it.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse } from "@std/yaml";
import {
  renderComposeDev,
  renderEnvExample,
  STACK_ENV,
  stackEnv,
  type StackOptions,
} from "../src/build/docker-stack.ts";
import {
  detectDockerStack,
  resolveDocker,
  resolveStack,
  type StackDetection,
} from "../src/build/docker-detect.ts";
import {
  type DockerOptions,
  dockerPlan,
  renderCompose,
  renderDockerfile,
  renderDockerignore,
} from "../src/build/docker-template.ts";

const GOLDEN = new URL("./fixtures/docker-stack/", import.meta.url);

/** The full stack every golden file is rendered from (a fixed Deno tag and CLI specifier). */
const FULL: DockerOptions = {
  mode: "server",
  denoTag: "2.9.7",
  postgres: true,
  pgvector: true,
  storage: true,
  migrate: true,
  dev: true,
  auth: true,
  backend: true,
  backendStorage: true,
  backendVault: true,
  bucket: "media",
  cli: ["--config", "deno.json", "jsr:@denext/denext@^4.0.0/cli"],
  migrateCommand: [
    "deno",
    "run",
    "-A",
    "--config",
    "deno.json",
    "jsr:@denext/denext@^4.0.0/cli",
    "job",
    "migrate",
  ],
  startCommand: [
    "deno",
    "run",
    "--allow-net",
    "--allow-read",
    "--allow-env",
    "--allow-write=.denext",
    "jsr:@denext/denext@^4.0.0/cli",
    "start",
    ".",
  ],
};

/** Compare `text` with the golden file `name` (or rewrite it under DENEXT_UPDATE_GOLDEN=1). */
async function golden(name: string, text: string): Promise<void> {
  const url = new URL(name, GOLDEN);
  if (Deno.env.get("DENEXT_UPDATE_GOLDEN") === "1") {
    await Deno.mkdir(GOLDEN, { recursive: true });
    await Deno.writeTextFile(url, text);
    return;
  }
  assertEquals(text, await Deno.readTextFile(url), `golden ${name}`);
}

interface ComposeDoc {
  services: Record<string, {
    image?: string;
    build?: string;
    restart?: string;
    ports?: string[];
    command?: string[];
    environment?: Record<string, string>;
    healthcheck?: { test: string[] };
    depends_on?: Record<string, { condition: string }>;
    volumes?: string[];
  }>;
  volumes?: Record<string, null>;
}

function compose(options: DockerOptions): ComposeDoc {
  return parse(renderCompose(options)) as ComposeDoc;
}

Deno.test("golden: the full stack's compose file, .env.example, dev overlay and Dockerfile", async () => {
  await golden("docker-compose.yml", renderCompose(FULL));
  await golden("env.example", renderEnvExample(FULL));
  await golden("compose.dev.yml", renderComposeDev(FULL, 3000));
  await golden("Dockerfile", renderDockerfile(FULL));
  await golden("dockerignore", renderDockerignore());
});

Deno.test("every long-running service has a health check; the app waits on each dependency", () => {
  const doc = compose(FULL);
  assertEquals(Object.keys(doc.services), ["web", "migrate", "db", "minio", "minio-init"]);
  for (const name of ["web", "db", "minio"]) {
    assert(doc.services[name].healthcheck?.test.length, `${name} has a health check`);
    assertEquals(doc.services[name].restart, "unless-stopped");
  }
  for (const name of ["migrate", "minio-init"]) assertEquals(doc.services[name].restart, "no");
  assertEquals(doc.services.web.depends_on, {
    db: { condition: "service_healthy" },
    "minio-init": { condition: "service_completed_successfully" },
    migrate: { condition: "service_completed_successfully" },
  });
  assertEquals(doc.services.migrate.depends_on, { db: { condition: "service_healthy" } });
  assertEquals(doc.services["minio-init"].depends_on, { minio: { condition: "service_healthy" } });
  assertEquals(doc.services.db.image, "pgvector/pgvector:pg17");
  assertEquals(doc.services.db.ports, undefined, "no host port for the database by default");
  assertEquals(Object.keys(doc.volumes ?? {}), ["db-data", "storage-data"]);
  // The app and the migrations service share one image (built once, never pulled).
  assertEquals(doc.services.migrate.image, doc.services.web.image);
  assertEquals(doc.services.migrate.command, FULL.migrateCommand);
  assertStringIncludes(doc.services["minio-init"].command?.[0] ?? "", "mc mb --ignore-existing");
});

Deno.test("Postgres alone: plain 17 image, opt-in loopback port, no storage or migrations", () => {
  const doc = compose({ mode: "server", postgres: true });
  assertEquals(Object.keys(doc.services), ["web", "db"]);
  assertEquals(doc.services.db.image, "postgres:17-alpine");
  const exposed = compose({ mode: "server", postgres: true, exposeDb: true });
  assertEquals(exposed.services.db.ports, ["127.0.0.1:${DB_PORT:-5432}:5432"]);
  assertEquals(Object.keys(doc.volumes ?? {}), ["db-data"]);
});

/** The `${NAME:?…}` / `${NAME:-…}` reference a variable gets in the compose file. */
function refOf(v: { name: string; required: boolean }): string {
  return `\${${v.name}:${v.required ? "?" : "-"}`;
}

Deno.test("STACK_ENV is the one list: .env.example comes from it, required secrets left empty", () => {
  const vars = stackEnv(FULL);
  assertEquals(vars.length, STACK_ENV.length, "the full stack needs every variable");
  const example = renderEnvExample(FULL);
  // Required secrets are written EMPTY, so a copied .env.example can never start the stack.
  const lines = vars.map((v) => `\n${v.name}=${v.required ? "" : v.example ?? ""}\n`);
  for (const line of lines) assertStringIncludes(example, line);
  // An optional variable with no example is written EMPTY — never the literal `undefined`
  // (which compose would hand the app as a real value, e.g. a guessable secret key).
  for (const line of example.split("\n")) {
    assert(!/=(undefined|null)$/.test(line), `no literal undefined/null value: ${line}`);
  }
  const hints = vars.flatMap((v) => v.generate ? [`# Generate: ${v.generate}`] : []);
  for (const hint of hints) assertStringIncludes(example, hint);
  assert(!/change-me|password123|secret123/.test(example), "no placeholder secret values");
});

Deno.test("STACK_ENV: the app's secrets reach the app and migrations; required ones fail fast", () => {
  const vars = stackEnv(FULL);
  const doc = compose(FULL);
  for (const v of vars.filter((v) => v.app)) {
    assertStringIncludes(doc.services.web.environment?.[v.name] ?? "", refOf(v));
    assertStringIncludes(doc.services.migrate.environment?.[v.name] ?? "", refOf(v));
  }
  const text = renderCompose(FULL);
  for (const v of vars.filter((v) => v.required)) {
    assertStringIncludes(text, `\${${v.name}:?set it in .env (see .env.example)}`);
  }
});

Deno.test("the secrets follow the features: auth, backend, storage", () => {
  const names = (o: StackOptions) => stackEnv(o).map((v) => v.name);
  assertEquals(names({ postgres: true }), ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]);
  assertEquals(names({ auth: true }), ["AUTH_SECRET"]);
  assertEquals(names({ backend: true }), [
    "DENEXT_PUBLISHABLE_KEY",
    "DENEXT_SECRET_KEY",
    "DENEXT_JWT_SIGNING_KEYS",
    "DENEXT_JWT_SECRET",
  ]);
  // The vault key is required, so it is listed only when `vault` is configured.
  assert(!names({ backend: true, postgres: true }).includes("DENEXT_VAULT_KEY"));
  assert(names({ backend: true, backendVault: true, postgres: true }).includes("DENEXT_VAULT_KEY"));
  assertEquals(names({ backendStorage: true }), ["DENEXT_STORAGE_SECRET"]);
  assert(names({ storage: true }).includes("MINIO_ROOT_PASSWORD"));
});

Deno.test("the Dockerfile runs on denext's toolchain only when Postgres / the backend needs it", () => {
  const plain = renderDockerfile({ mode: "server", denoTag: "2.9.7" });
  assert(!plain.includes("toolchain"), "a plain app keeps the stock runtime");
  const pg = renderDockerfile({ mode: "server", denoTag: "2.9.7", postgres: true });
  assertStringIncludes(pg, "jsr:@denext/denext/cli toolchain path");
  assertStringIncludes(pg, "ENV PATH=/deno-dir/toolchain-bin:$PATH");
});

Deno.test("dockerPlan: the stack adds .env.example, --dev adds compose.dev.yml", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_docker_stack_" });
  try {
    const names = async (o: DockerOptions) =>
      (await dockerPlan(dir, o)).map((f) => f.path.slice(dir.length + 1));
    assertEquals(await names({ mode: "server" }), [
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
    ]);
    assertEquals(await names({ mode: "server", postgres: true, dev: true }), [
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
      ".env.example",
      "compose.dev.yml",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- detection -------------------------------------------------------------

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_docker_detect_" });
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

async function detect(files: Record<string, string>): Promise<StackDetection> {
  const dir = await project(files);
  try {
    return await detectDockerStack(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const BACKEND_CONFIG = `import { backend, s3 } from "@denext/backend";
import { denextAuth } from "denext/server";
export default {
  plugins: [backend({
    postgres: {},
    storage: { driver: s3({ region: "auto", bucket: "media" }), buckets: { a: {} } },
  })],
};
const auth = denextAuth({ secret: "x" });
`;

Deno.test("detect: a plain app needs nothing", async () => {
  const d = await detect({ "deno.json": "{}" });
  assertEquals(d.features, { postgres: false, pgvector: false, storage: false, migrate: false });
  assertEquals([d.auth, d.backend, d.backendStorage, d.backendVault], [false, false, false, false]);
  assertEquals(d.cli, ["--config", "deno.json", "jsr:@denext/denext/cli"]);
  assertEquals(d.warnings, []);
});

Deno.test("detect: @denext/backend → Postgres, s3() → MinIO with the literal bucket, auth", async () => {
  const d = await detect({
    "deno.json": JSON.stringify({
      tasks: { start: "deno run --allow-net jsr:@denext/denext@^4.0.0/cli start ." },
    }),
    "denext.config.ts": BACKEND_CONFIG,
  });
  assertEquals(d.features.postgres, true);
  assertEquals(d.features.storage, true);
  assertEquals(d.reasons.postgres, "@denext/backend in denext.config");
  assertEquals(d.bucket, "media");
  assertEquals([d.auth, d.backend, d.backendStorage], [true, true, true]);
  assertEquals(d.backendVault, false, "no vault configured: DENEXT_VAULT_KEY is not required");
  assertEquals(d.cli, ["--config", "deno.json", "jsr:@denext/denext@^4.0.0/cli"]);
  assertEquals(d.migrateCommand.slice(-2), ["job", "migrate"]);
  assertEquals(d.startCommand, [
    "deno",
    "run",
    "--allow-net",
    "jsr:@denext/denext@^4.0.0/cli",
    "start",
    ".",
  ]);
  assertEquals(resolveStack(d).startCommand, d.startCommand);
});

Deno.test("shutdown: the server is tini's direct child, so docker stop's SIGTERM drains it", async () => {
  // `deno task start` swallowed SIGTERM: docker stop waited out its grace period and SIGKILLed
  // the server (exit 137, no plugin teardowns). The image now runs the start task's own
  // `deno run` line, and tini signals the whole process group either way.
  const d = await detect({
    "deno.json": JSON.stringify({
      tasks: {
        start:
          "deno run --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext@^4.0.0/cli start .",
      },
    }),
  });
  const file = renderDockerfile({ mode: "server", denoTag: "2.9.7", ...resolveStack(d) });
  assertStringIncludes(
    file,
    'CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "--allow-write=.denext", "jsr:@denext/denext@^4.0.0/cli", "start", "."]',
  );
  assert(!file.includes('CMD ["deno", "task", "start"]'), "never deno task as the server's parent");
  assertStringIncludes(file, 'ENTRYPOINT ["/tini", "-g", "--", "docker-entrypoint.sh"]');
  // A start task that needs a shell (or isn't `deno run`) keeps `deno task start`, under tini -g.
  for (
    const start of [
      "deno run -A jsr:@denext/denext/cli start . && echo done",
      "PORT=4000 deno run -A jsr:@denext/denext/cli start .",
      "denext start",
    ]
  ) {
    const other = await detect({ "deno.json": JSON.stringify({ tasks: { start } }) });
    assertEquals(other.startCommand, undefined, start);
    const text = renderDockerfile({ mode: "server", denoTag: "2.9.7", ...resolveStack(other) });
    assertStringIncludes(text, 'CMD ["deno", "task", "start"]');
    assertStringIncludes(text, '"/tini", "-g"');
  }
  // The compose web service gives the drain + teardowns room before SIGKILL.
  assertStringIncludes(renderCompose(FULL), "stop_grace_period: 30s");
});

Deno.test("detect: backend({ vault }) requires DENEXT_VAULT_KEY", async () => {
  const d = await detect({
    "deno.json": "{}",
    "denext.config.ts": BACKEND_CONFIG.replace("postgres: {},", "postgres: {},\n    vault: {},"),
  });
  assertEquals(d.backendVault, true);
  const env = stackEnv(resolveStack(d)).map((v) => v.name);
  assert(env.includes("DENEXT_VAULT_KEY"));
});

Deno.test("detect: a Postgres DATABASE_URL in .env, migrations + runner, the vector extension", async () => {
  const d = await detect({
    "deno.json": JSON.stringify({ tasks: { migrate: "deno run -A jobs/migrate.ts" } }),
    ".env": "DATABASE_URL=postgres://u:p@localhost/db\n",
    "migrations/001_init.sql": "create extension if not exists vector;\n",
    "jobs/migrate.ts": "export default {};\n",
  });
  assertEquals(d.features, { postgres: true, pgvector: true, storage: false, migrate: true });
  assertEquals(d.migrateCommand, ["deno", "task", "migrate"], "the project's own task wins");
});

Deno.test("detect: migrations without jobs/migrate.ts warn and leave the service off", async () => {
  const d = await detect({ "deno.json": "{}", "migrations/001.sql": "select 1;" });
  assertEquals(d.features.migrate, false);
  assertStringIncludes(d.warnings[0], "jobs/migrate.ts");
});

Deno.test("resolveStack: flags override detection; --stack adds Postgres; pgvector implies it", async () => {
  const none = await detect({ "deno.json": "{}" });
  assertEquals(resolveStack(none).postgres, false);
  assertEquals(resolveStack(none, {}, true).postgres, true, "--stack");
  assertEquals(resolveStack(none, { pgvector: true }).postgres, true, "pgvector implies it");
  const off = resolveStack(none, { pgvector: true, postgres: false });
  assertEquals([off.postgres, off.pgvector], [false, false], "--no-postgres wins");
  const all = await detect({ "deno.json": "{}", "denext.config.ts": BACKEND_CONFIG });
  const r = resolveStack(all, { storage: false, migrate: true });
  assertEquals([r.postgres, r.storage, r.migrate], [true, false, true]);
});

Deno.test("resolveDocker: the static image drops detected services, refuses asked-for ones", async () => {
  const dir = await project({
    "deno.json": "{}",
    "denext.config.ts": `export default { mode: "spa" };\n` + BACKEND_CONFIG.replace(
      "export default",
      "const _unused =",
    ),
  });
  try {
    const r = await resolveDocker(dir);
    assertEquals(r.options.mode, "static");
    assertEquals([r.options.postgres, r.options.storage], [false, false]);
    assertStringIncludes(r.warnings.join("\n"), "static (SPA) image");
    await assertRejects(
      () => resolveDocker(dir, { overrides: { postgres: true } }),
      Error,
      "--postgres",
    );
    await assertRejects(() => resolveDocker(dir, { all: true }), Error, "--stack");
    const server = await resolveDocker(dir, { target: "server", port: 8080, exposeDb: true });
    assertEquals([server.options.mode, server.options.postgres], ["server", true]);
    assertEquals([server.options.port, server.options.exposeDb], [8080, true]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrations alone: no empty environment block (compose rejects a null mapping)", () => {
  const text = renderCompose({ mode: "server", migrate: true });
  const doc = parse(text) as ComposeDoc;
  assertEquals(Object.keys(doc.services), ["web", "migrate"]);
  assert(!("environment" in doc.services.migrate), "no `environment:` with nothing under it");
  assertEquals(doc.services.migrate.command, ["deno", "task", "migrate"]);
  assertEquals(doc.services.web.depends_on, {
    migrate: { condition: "service_completed_successfully" },
  });
});
