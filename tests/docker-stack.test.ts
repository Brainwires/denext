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
  dashboard: true,
  dashboardLogs: true,
  dev: true,
  auth: true,
  backend: true,
  backendStorage: true,
  backendVault: true,
  realtimeLogical: true,
  bucket: "media",
  cli: ["--config", "deno.json", "jsr:@denext/denext@^4.0.0/cli"],
  migrateCommand: [
    "deno",
    "run",
    "-A",
    "--config",
    "deno.json",
    "jsr:@denext/denext@^4.0.0/cli",
    "migration",
    "up",
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
    user?: string;
    pull_policy?: string;
    networks?: string[];
  }>;
  volumes?: Record<string, null>;
  networks?: Record<string, { internal?: boolean }>;
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
  assertEquals(Object.keys(doc.services), [
    "web",
    "migrate",
    "db",
    "db-init",
    "minio",
    "minio-init",
    "dashboard",
    "dashboard-logs",
  ]);
  for (const name of ["web", "db", "minio", "dashboard"]) {
    assert(doc.services[name].healthcheck?.test.length, `${name} has a health check`);
    assertEquals(doc.services[name].restart, "unless-stopped");
  }
  for (const name of ["migrate", "db-init", "minio-init"]) {
    assertEquals(doc.services[name].restart, "no");
  }
  assertEquals(doc.services.web.depends_on, {
    db: { condition: "service_healthy" },
    "db-init": { condition: "service_completed_successfully" },
    "minio-init": { condition: "service_completed_successfully" },
    migrate: { condition: "service_completed_successfully" },
  });
  assertEquals(doc.services.migrate.depends_on, {
    "db-init": { condition: "service_completed_successfully" },
  });
  assertEquals(doc.services["db-init"].depends_on, { db: { condition: "service_healthy" } });
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
  assertEquals(Object.keys(doc.services), ["web", "db", "db-init"]);
  assertEquals(doc.services.db.image, "postgres:17-alpine");
  const exposed = compose({ mode: "server", postgres: true, exposeDb: true });
  assertEquals(exposed.services.db.ports, ["127.0.0.1:${DB_PORT:-5432}:5432"]);
  assertEquals(Object.keys(doc.volumes ?? {}), ["db-data"]);
});

Deno.test("the dashboard: the app's image and env, its password, loopback only, no socket", () => {
  const doc = compose(FULL);
  const dash = doc.services.dashboard;
  assertEquals(dash.image, doc.services.web.image);
  assertEquals(dash.pull_policy, "never");
  assertEquals(dash.command, [
    "deno",
    "run",
    "-A",
    ...FULL.cli!,
    "dashboard",
    "--host",
    "0.0.0.0",
    "--port",
    "3100",
  ]);
  // Published on this machine's loopback only.
  assertEquals(dash.ports, ["127.0.0.1:${DASHBOARD_PORT:-3100}:3100"]);
  // The app's own database and storage, plus the password (never required: a stack generated
  // before it keeps starting, with the dashboard locked).
  assertEquals(dash.environment?.DATABASE_URL, doc.services.web.environment?.DATABASE_URL);
  assertEquals(dash.environment?.DASHBOARD_PASSWORD, "${DASHBOARD_PASSWORD:-}");
  assertEquals(dash.environment?.DASHBOARD_LOGS_URL, "http://dashboard-logs:3101");
  // The running app, for the realtime, functions and health pages.
  assertEquals(dash.environment?.DASHBOARD_APP_URL, "http://web:3000");
  assertEquals(dash.depends_on, { "db-init": { condition: "service_completed_successfully" } });
  assertEquals(dash.volumes, undefined, "the dashboard never mounts the Docker socket");
  assertEquals(dash.user, undefined);
  assertStringIncludes(renderEnvExample(FULL), "\nDASHBOARD_PASSWORD=\n");
});

Deno.test("the log relay: the only service with the Docker socket, on a network of its own", () => {
  const doc = compose(FULL);
  const relay = doc.services["dashboard-logs"];
  assertEquals(relay.volumes, ["${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock:ro"]);
  assertEquals(relay.ports, undefined, "the relay publishes no port");
  assertEquals(relay.networks, ["dashboard-logs"]);
  assertEquals(relay.user, "root");
  assertEquals(relay.environment, { DASHBOARD_PASSWORD: "${DASHBOARD_PASSWORD:-}" });
  assertEquals(doc.services.dashboard.networks, ["default", "dashboard-logs"]);
  assertEquals(doc.networks, { "dashboard-logs": { internal: true } });
  for (const [name, service] of Object.entries(doc.services)) {
    if (name === "dashboard-logs") continue;
    assert(
      !(service.volumes ?? []).some((v) => v.includes("docker.sock")),
      `${name} must not mount the Docker socket`,
    );
  }
  // Without --dashboard-logs: no relay, no network, no socket anywhere.
  const plain = compose({ ...FULL, dashboardLogs: false });
  assertEquals(plain.services["dashboard-logs"], undefined);
  assertEquals(plain.networks, undefined);
  assertEquals(plain.services.dashboard.environment?.DASHBOARD_LOGS_URL, undefined);
  assert(!renderCompose({ ...FULL, dashboardLogs: false }).includes("docker.sock"));
});

Deno.test("the dashboard follows Postgres: on with it, off with --no-dashboard, never without", async () => {
  const detection: StackDetection = {
    features: {
      postgres: true,
      pgvector: false,
      storage: false,
      migrate: false,
      dashboard: true,
    },
    reasons: { postgres: "test", dashboard: "a database to manage" },
    auth: false,
    backend: false,
    backendStorage: false,
    backendVault: false,
    realtimeLogical: false,
    cli: ["jsr:@denext/denext/cli"],
    migrateCommand: [],
    warnings: [],
  };
  assertEquals(resolveStack(detection).dashboard, true);
  assertEquals(resolveStack(detection, { dashboard: false }).dashboard, false);
  assertEquals(resolveStack(detection, { postgres: false, dashboard: true }).dashboard, false);
  assertEquals(compose({ mode: "server", dashboard: true }).services.dashboard, undefined);
  assertEquals(stackEnv({ dashboard: true }).some((v) => v.name === "DASHBOARD_PASSWORD"), false);
  const dir = await Deno.makeTempDir({ prefix: "denext_dash_stack_" });
  try {
    await Deno.writeTextFile(join(dir, ".env"), "DATABASE_URL=postgres://a:b@h/d\n");
    const found = await detectDockerStack(dir);
    assertEquals(found.reasons.dashboard, "a database to manage");
    const asked = await resolveDocker(dir, { dashboardLogs: true });
    assertEquals([asked.options.dashboard, asked.options.dashboardLogs], [true, true]);
    const off = await resolveDocker(dir, { overrides: { dashboard: false }, dashboardLogs: true });
    assertEquals(off.options.dashboardLogs, undefined);
    assert(off.warnings.some((w) => w.includes("--dashboard-logs needs the dashboard")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
  const lines = vars.map((v) =>
    `\n${v.name}=${v.required ? "" : v.name === "S3_BUCKET" ? FULL.bucket : v.example ?? ""}\n`
  );
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
  // DENEXT_ACTION_ID_SECRET is listed for every stack (any app may have Server Actions).
  const all = (o: StackOptions) => stackEnv(o).map((v) => v.name);
  for (const o of [{}, { postgres: true }, { auth: true }, { backend: true }]) {
    assert(all(o).includes("DENEXT_ACTION_ID_SECRET"), JSON.stringify(o));
  }
  const names = (o: StackOptions) => all(o).filter((n) => n !== "DENEXT_ACTION_ID_SECRET");
  assertEquals(names({ postgres: true }), [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_APP_USER",
    "POSTGRES_APP_PASSWORD",
    "POSTGRES_DB",
  ]);
  assertEquals(names({ auth: true }), ["AUTH_SECRET", "DENEXT_RATE_LIMIT_LOCAL_ADDRESSES"]);
  assertEquals(names({ backend: true }), [
    "DENEXT_PUBLISHABLE_KEY",
    "DENEXT_SECRET_KEY",
    "DENEXT_JWT_SIGNING_KEYS",
    "DENEXT_JWT_SECRET",
    "GOTRUE_SMTP_HOST",
    "GOTRUE_SMTP_PORT",
    "GOTRUE_SMTP_USER",
    "GOTRUE_SMTP_PASS",
    "GOTRUE_SMTP_ADMIN_EMAIL",
    "GOTRUE_SMTP_SENDER_NAME",
    "DENEXT_RATE_LIMIT_LOCAL_ADDRESSES",
  ]);
  // The vault key is required, so it is listed only when `vault` is configured.
  assert(!names({ backend: true, postgres: true }).includes("DENEXT_VAULT_KEY"));
  assert(names({ backend: true, backendVault: true, postgres: true }).includes("DENEXT_VAULT_KEY"));
  assertEquals(names({ backendStorage: true }), ["DENEXT_STORAGE_SECRET"]);
  assert(names({ storage: true }).includes("MINIO_ROOT_PASSWORD"));
});

Deno.test("every Dockerfile serves on denext's toolchain, linked before its CMD", () => {
  // Up to 4.5.0 only a Postgres / backend image did: a plain app's `start` ran on the image's
  // stock Deno, so Deno.SQL (postgresClient(), the Prisma adapter) was missing in production.
  for (
    const options of [
      { mode: "server", denoTag: "2.9.7" },
      { mode: "server", denoTag: "2.9.7", postgres: true },
      { mode: "static", denoTag: "2.9.7" },
    ] as const
  ) {
    const file = renderDockerfile(options);
    // `toolchain path` installs the pinned build SHA-256-verified (the build already did).
    assertStringIncludes(file, "jsr:@denext/denext/cli toolchain path");
    const path = file.indexOf("ENV PATH=/deno-dir/toolchain-bin:$PATH");
    assert(path > 0, file);
    assert(path < file.indexOf("\nCMD "), "linked before the server starts");
    assert(path < file.indexOf("HEALTHCHECK"), "the probe runs on it too");
  }
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
import { denextAuth } from "@denext/auth";
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
  assertEquals(d.features, {
    postgres: false,
    pgvector: false,
    storage: false,
    migrate: false,
    dashboard: false,
  });
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
  assertEquals(d.migrateCommand.slice(-2), ["migration", "up"], "the backend's migrations first");
  assertEquals(d.features.migrate, false, "no migrations/: nothing for the service to do");
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
  const file = renderDockerfile({
    mode: "server",
    denoTag: "2.9.7",
    netSplit: false,
    ...resolveStack(d),
  });
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
  assertEquals(d.features, {
    postgres: true,
    pgvector: true,
    storage: false,
    migrate: true,
    dashboard: true,
  });
  assertEquals(d.migrateCommand, ["deno", "task", "migrate"], "the project's own task wins");
});

Deno.test("detect: @denext/backend + migrations/ → the migrations service runs `denext migration up`", async () => {
  // An app migration that grants to `anon` needs the backend's roles first: on a fresh database
  // only `denext migration up` applies them before migrations/ (the server's start comes later).
  const d = await detect({
    "deno.json": JSON.stringify({ tasks: { migrate: "deno run -A jobs/migrate.ts" } }),
    "denext.config.ts": BACKEND_CONFIG,
    "migrations/001_notes.sql": "create table notes (id int); grant select on notes to anon;\n",
  });
  assertEquals(d.features.migrate, true);
  assertStringIncludes(d.reasons.migrate!, "denext migration up");
  assertEquals(d.migrateCommand, [
    "deno",
    "run",
    "-A",
    "--config",
    "deno.json",
    "jsr:@denext/denext/cli",
    "migration",
    "up",
  ]);
  assertStringIncludes(d.warnings.join("\n"), "not the project's `migrate` task");
  const compose = renderCompose({ ...resolveStack(d), mode: "server" });
  assertStringIncludes(
    compose,
    'command: ["deno", "run", "-A", "--config", "deno.json", "jsr:@denext/denext/cli", "migration", "up"]',
  );
  assertStringIncludes(compose, "(denext migration up)");
  // Without the backend the project's own runner stays.
  const plain = await detect({
    "deno.json": JSON.stringify({ tasks: { migrate: "deno run -A jobs/migrate.ts" } }),
    "migrations/001.sql": "select 1;",
    "jobs/migrate.ts": "export default {};\n",
  });
  assertEquals(plain.migrateCommand, ["deno", "task", "migrate"]);
});

Deno.test('detect: realtime({ source: "logical" }) → wal_level=logical and REPLICATION for the app\'s role', async () => {
  const logical = await detect({
    "deno.json": "{}",
    "denext.config.ts": BACKEND_CONFIG.replace(
      "postgres: {},",
      'postgres: {},\n    realtime: realtime({ tables: { notes: {} }, source: "logical" }),',
    ),
  });
  assertEquals(logical.realtimeLogical, true);
  const compose = renderCompose({ ...resolveStack(logical), mode: "server" });
  assertStringIncludes(compose, 'command: ["postgres", "-c", "wal_level=logical"]');
  assertStringIncludes(
    compose,
    `ALTER ROLE :"u" WITH LOGIN CREATEROLE NOSUPERUSER REPLICATION PASSWORD :'p';`,
  );
  const notify = await detect({ "deno.json": "{}", "denext.config.ts": BACKEND_CONFIG });
  assertEquals(notify.realtimeLogical, false);
  const plain = renderCompose({ ...resolveStack(notify), mode: "server" });
  assert(!plain.includes("wal_level"));
  assert(!plain.includes("REPLICATION"));
  // Only inside a backend config: a `source: "logical"` elsewhere means nothing.
  const other = await detect({
    "deno.json": "{}",
    "denext.config.ts": 'const x = { source: "logical" };',
  });
  assertEquals(other.realtimeLogical, false);
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
  // Only the variable every stack lists (never an empty `environment:` mapping).
  assertEquals(Object.keys(doc.services.migrate.environment ?? {}), ["DENEXT_ACTION_ID_SECRET"]);
  assertEquals(doc.services.migrate.command, ["deno", "task", "migrate"]);
  assertEquals(doc.services.web.depends_on, {
    migrate: { condition: "service_completed_successfully" },
  });
});

/** A service's `environment` (empty when it has none). */
function envOf(doc: ComposeDoc, service: string): Record<string, string> {
  return doc.services[service].environment ?? {};
}

/** A service's `command`, first entry (the shell script of a `sh -c` one-shot). */
function scriptOf(doc: ComposeDoc, service: string): string {
  return (doc.services[service].command ?? [""])[0];
}

Deno.test("stack defaults: the app is not the superuser, per-IP limits on, presigned URLs reachable", () => {
  // The app connected as the Postgres superuser; the stack ran with per-IP auth limits off
  // (every client arrives from the Docker bridge); presigned URLs pointed at a MinIO port the
  // production file never published.
  const doc = compose(FULL);
  const web = envOf(doc, "web");
  const url = web.DATABASE_URL;
  assertStringIncludes(
    url,
    "postgres://${POSTGRES_APP_USER:-denext_app}:${POSTGRES_APP_PASSWORD:?",
  );
  assert(!url.includes("POSTGRES_USER") && !url.includes("${POSTGRES_PASSWORD"), url);
  assertEquals(envOf(doc, "migrate").DATABASE_URL, url, "migrations as the app role");
  assertEquals(
    envOf(doc, "db-init").PGUSER,
    "${POSTGRES_USER:-denext}",
    "only db-init is superuser",
  );
  const script = scriptOf(doc, "db-init");
  const parts = [
    "CREATE ROLE %I LOGIN",
    "\\gexec",
    `ALTER ROLE :"u" WITH LOGIN CREATEROLE NOSUPERUSER REPLICATION PASSWORD :'p'`,
    `ALTER DATABASE :"d" OWNER TO :"u"`,
    `ALTER SCHEMA public OWNER TO :"u"`,
    "CREATE EXTENSION IF NOT EXISTS vector",
  ];
  for (const part of parts) assertStringIncludes(script, part);
  const plain = scriptOf(compose({ mode: "server", postgres: true }), "db-init");
  assert(!plain.includes("vector"), "no pgvector, no extension");
  assert(!plain.includes("REPLICATION"), "no logical realtime, no REPLICATION");
  assertEquals(web.DENEXT_RATE_LIMIT_LOCAL_ADDRESSES, "${DENEXT_RATE_LIMIT_LOCAL_ADDRESSES:-1}");
  assertEquals(doc.services.minio.ports, ["127.0.0.1:${MINIO_PORT:-9000}:9000"]);
  assertEquals(web.S3_PUBLIC_ENDPOINT, "${S3_PUBLIC_ENDPOINT:-http://localhost:9000}");
  const dev = parse(renderComposeDev(FULL, 3000)) as { services: Record<string, unknown> };
  assertEquals(dev.services.minio, undefined, "published once, by the production file");
});

Deno.test("a Gleam app's image installs CA certificates before its build fetches Gleam packages", async () => {
  // The Gleam compiler fetches packages over TLS and denoland/deno ships no CA bundle: up to 4.5.0
  // the build failed ("HTTP error … builder error") until ca-certificates was installed by hand.
  const dir = await Deno.makeTempDir({ prefix: "denext_docker_gleam_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'import { gleam } from "denext/gleam";\nexport default { plugins: [gleam()] };\n',
    );
    const { options } = await resolveDocker(dir, { denoTag: "2.9.7" });
    for (const mode of ["server", "static"] as const) {
      const file = renderDockerfile({ ...options, mode });
      const certs = file.indexOf("apt-get install -y --no-install-recommends ca-certificates");
      assert(certs > 0, file);
      assert(certs < file.indexOf("USER deno"), "installed as root, before the build");
    }
    const plain = renderDockerfile({ mode: "server", denoTag: "2.9.7" });
    assert(!plain.includes("ca-certificates"), "only when the app compiles Gleam");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(".env.example lists DENEXT_ACTION_ID_SECRET for every stack: build and runtime, one value, left empty", async () => {
  for (const options of [FULL, { mode: "server", postgres: true } as DockerOptions]) {
    const example = renderEnvExample(options);
    const at = example.indexOf("\nDENEXT_ACTION_ID_SECRET=\n");
    assert(at > 0, "listed, and written empty");
    const comment = example.slice(example.lastIndexOf("\n\n", at) + 2, at).replaceAll("\n# ", " ");
    assertStringIncludes(comment, "Set it at build time and at runtime, the same value on every");
    assertStringIncludes(comment, "instance");
    // No `# Generate:` hint: `denext stack up` must not fill in a value the image was not built
    // with (a runtime-only value is ignored with a warning).
    assert(!comment.includes("# Generate:"), comment);
    // The app container receives it under its own name, optional.
    assertStringIncludes(
      renderCompose(options),
      "DENEXT_ACTION_ID_SECRET: ${DENEXT_ACTION_ID_SECRET:-",
    );
  }
  // The stack's .env generation keeps it empty rather than inventing one.
  const { fillEnv } = await import("../src/cli/commands/stack.ts");
  const { text, filled } = await fillEnv(renderEnvExample(FULL));
  assert(!filled.includes("DENEXT_ACTION_ID_SECRET"));
  assertStringIncludes(text, "\nDENEXT_ACTION_ID_SECRET=\n");
});
