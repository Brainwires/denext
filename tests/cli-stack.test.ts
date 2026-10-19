// `denext stack up|down|status|logs` over a scripted Docker: the compose commands it runs, the
// `.env` it fills from `.env.example` (generated secrets, a fresh key set), and what `status`
// prints — the publishable key always, the secret key and passwords only with --show-secrets.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fillEnv, runStack, stackStatus } from "../src/cli/commands/stack.ts";
import { parsePs, type StackIo } from "../src/cli/commands/stack-io.ts";

const PS = JSON.stringify([
  {
    Service: "web",
    State: "running",
    Health: "healthy",
    Publishers: [{ URL: "0.0.0.0", TargetPort: 8000, PublishedPort: 8000 }],
  },
  {
    Service: "db",
    State: "running",
    Health: "healthy",
    Publishers: [{ URL: "127.0.0.1", TargetPort: 5432, PublishedPort: 5433 }],
  },
  {
    Service: "minio",
    State: "running",
    Publishers: [{ URL: "127.0.0.1", TargetPort: 9000, PublishedPort: 9000 }],
  },
  { Service: "migrate", State: "exited" },
]);

function fakeIo(options: { psCode?: number; upCode?: number } = {}) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  let generated = 0;
  const io: StackIo = {
    docker: (args) => {
      calls.push(args);
      if (args.includes("ps")) {
        return Promise.resolve({ code: options.psCode ?? 0, stdout: PS, stderr: "no compose" });
      }
      if (args.includes("up")) {
        return Promise.resolve({ code: options.upCode ?? 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    generate: async (ctx, dir) => {
      generated++;
      assertEquals(ctx.flags.stack, true, "the full stack by default");
      await Deno.writeTextFile(`${dir}/docker-compose.yml`, "services: {}\n");
      await Deno.writeTextFile(
        `${dir}/.env.example`,
        [
          "# Postgres password.",
          "# Generate: openssl rand -hex 24",
          "POSTGRES_PASSWORD=",
          "POSTGRES_USER=denext",
          "# Generate: openssl rand -base64 32",
          "DENEXT_STORAGE_SECRET=",
          "# Generate: denext backend keys",
          "DENEXT_PUBLISHABLE_KEY=",
          "# Generate: denext backend keys",
          "DENEXT_SECRET_KEY=",
          "# Generate: denext backend keys",
          "DENEXT_JWT_SIGNING_KEYS=",
          "# Generate: denext backend keys --legacy",
          "DENEXT_JWT_SECRET=",
          "",
        ].join("\n"),
      );
    },
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
  };
  return { io, calls, lines, errors, generated: () => generated };
}

function ctx(
  root: string,
  positionals: string[],
  flags: Record<string, string | boolean> = {},
  json = false,
) {
  return {
    positionals,
    flags,
    global: { cwd: root, json, verbose: false, quiet: false },
    rest: [],
  };
}

Deno.test("fillEnv: random secrets, a fresh key set, everything else as written", async () => {
  const { text, filled } = await fillEnv(
    "# Generate: openssl rand -hex 24\nA=\nB=kept\n# Generate: denext backend keys\n" +
      "DENEXT_PUBLISHABLE_KEY=\n# Generate: something else\nC=\n# Generate: denext backend keys\nUNKNOWN=\n",
  );
  assertEquals(filled, ["A", "DENEXT_PUBLISHABLE_KEY"]);
  assertMatch(text, /^A=[0-9a-f]{48}$/m);
  assertMatch(text, /^DENEXT_PUBLISHABLE_KEY=sb_publishable_/m);
  assertStringIncludes(text, "B=kept\n");
  assertStringIncludes(text, "\nC=\n");
  assertStringIncludes(text, "\nUNKNOWN=\n");
});

Deno.test("parsePs / stackStatus: URLs, keys, secrets only when asked", () => {
  assertEquals(parsePs(""), []);
  const lines = parsePs('{"Service":"web","State":"running"}\n{"Service":"db","State":"exited"}');
  assertEquals(lines.map((r) => r.Service), ["web", "db"]);
  const env = {
    POSTGRES_USER: "app",
    POSTGRES_PASSWORD: "pw123",
    POSTGRES_DB: "appdb",
    DENEXT_PUBLISHABLE_KEY: "sb_publishable_x",
    DENEXT_SECRET_KEY: "sb_secret_y",
  };
  const hidden = stackStatus(parsePs(PS), env, false);
  assertEquals(hidden.apiUrl, "http://localhost:8000");
  assertEquals(hidden.restUrl, "http://localhost:8000/rest/v1");
  assertEquals(hidden.databaseUrl, "postgres://app:•••@localhost:5433/appdb");
  assertEquals(hidden.s3Url, "http://localhost:9000");
  assertEquals(hidden.publishableKey, "sb_publishable_x");
  assertEquals(hidden.secretKey, undefined);
  const shown = stackStatus(parsePs(PS), env, true);
  assertEquals(shown.databaseUrl, "postgres://app:pw123@localhost:5433/appdb");
  assertEquals(shown.secretKey, "sb_secret_y");
  assertEquals(stackStatus([], {}, true).services, []);
  // The dashboard: its loopback URL (on 127.0.0.1, where its cookie lives); the password only
  // with --show-secrets.
  const dash = [{
    Service: "dashboard",
    State: "running",
    Publishers: [{ URL: "127.0.0.1", TargetPort: 3100, PublishedPort: 3105 }],
  }];
  const withPassword = { DASHBOARD_PASSWORD: "dashboard secret 12" };
  assertEquals(stackStatus(dash, withPassword, false).dashboardUrl, "http://127.0.0.1:3105");
  assertEquals(stackStatus(dash, withPassword, false).dashboardPassword, undefined);
  assertEquals(stackStatus(dash, withPassword, true).dashboardPassword, "dashboard secret 12");
});

Deno.test("stack up: writes the stack and .env when missing, compose up --wait, then status", async () => {
  const root = await Deno.makeTempDir({ prefix: "dnx-stack-" });
  try {
    const fake = fakeIo();
    assertEquals(await runStack(ctx(root, ["up"], { build: true }), fake.io), 0);
    assertEquals(fake.generated(), 1);
    assertEquals(fake.calls.find((c) => c.includes("up")), [
      "compose",
      "-f",
      "docker-compose.yml",
      "up",
      "-d",
      "--wait",
      "--build",
    ]);
    const env = await Deno.readTextFile(`${root}/.env`);
    assertMatch(env, /^POSTGRES_PASSWORD=[0-9a-f]{48}$/m);
    assertMatch(env, /^DENEXT_SECRET_KEY=sb_secret_/m);
    assertStringIncludes(env, "\nDENEXT_JWT_SECRET=\n", "the legacy secret stays opt-in");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(`${root}/.env`)).mode! & 0o777, 0o600);
    }
    const out = fake.lines.join("\n");
    assertStringIncludes(out, "Wrote .env from .env.example");
    assertStringIncludes(out, "API URL          http://localhost:8000");
    assertStringIncludes(out, "DB URL           postgres://denext:•••@localhost:5433/denext");
    assert(!out.includes("sb_secret_"), "no secret key without --show-secrets");
    assertStringIncludes(out, "--show-secrets");
    // A second up: nothing regenerated, .env kept.
    const again = fakeIo();
    assertEquals(await runStack(ctx(root, ["up"]), again.io), 0);
    assertEquals(again.generated(), 0);
    assertEquals(await Deno.readTextFile(`${root}/.env`), env);
    // --show-secrets, --json
    const json = fakeIo();
    assertEquals(await runStack(ctx(root, ["status"], { "show-secrets": true }, true), json.io), 0);
    const status = JSON.parse(json.lines.join("\n"));
    assertMatch(status.secretKey, /^sb_secret_/);
    assertEquals(status.services.length, 4);
    // --dev needs the overlay.
    const dev = fakeIo();
    assertEquals(await runStack(ctx(root, ["up"], { dev: true }), dev.io), 1);
    assertStringIncludes(dev.errors[0], "compose.dev.yml");
    await Deno.writeTextFile(`${root}/compose.dev.yml`, "services: {}\n");
    assertEquals(await runStack(ctx(root, ["up"], { dev: true }), dev.io), 0);
    assertEquals(dev.calls[0].slice(0, 5), [
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "compose.dev.yml",
    ]);
    // A failing compose.
    const broken = fakeIo({ upCode: 3 });
    assertEquals(await runStack(ctx(root, ["up"]), broken.io), 1);
    assertStringIncludes(broken.errors[0], "exited 3");
    const ps = fakeIo({ psCode: 1 });
    assertEquals(await runStack(ctx(root, ["status"]), ps.io), 1);
    assertStringIncludes(ps.errors[0], "no compose");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stack down / logs / unknown", async () => {
  const fake = fakeIo();
  assertEquals(await runStack(ctx("/p", ["down"], { volumes: true }), fake.io), 0);
  assertEquals(fake.calls[0], ["compose", "-f", "docker-compose.yml", "down", "--volumes"]);
  assertStringIncludes(fake.lines[0], "volumes were removed");
  await runStack(ctx("/p", ["down"]), fake.io);
  assertEquals(fake.lines[1], "Stopped.");
  await runStack(ctx("/p", ["logs", "db"], { follow: true }), fake.io);
  assertEquals(fake.calls[2], ["compose", "-f", "docker-compose.yml", "logs", "--follow", "db"]);
  assertEquals(await runStack(ctx("/p", ["sideways"]), fake.io), 1);
  assertStringIncludes(fake.errors[0], 'unknown action "sideways"');
  assertEquals(await runStack(ctx("/p", []), fake.io), 1);
  const empty = fakeIo();
  empty.io.docker = () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  await runStack(ctx("/p", ["status"]), empty.io);
  assertEquals(empty.lines, ["The stack is not running (denext stack up)."]);
});

Deno.test("dockerCli: runs docker, or says it is missing", async () => {
  const { dockerCli } = await import("../src/cli/commands/stack.ts");
  try {
    const out = await dockerCli(["--version"], ".", true);
    assertStringIncludes(out.stdout + out.stderr, "ocker");
    await dockerCli(["--version"], ".", false);
  } catch (error) {
    assertStringIncludes((error as Error).message, "docker is not on PATH");
  }
});

Deno.test("dockerCli: a machine without docker gets the install hint, not a spawn error", async () => {
  // `Command.output()` throws a missing binary synchronously; a child with an empty PATH has no
  // docker on any OS.
  const empty = await Deno.makeTempDir({ prefix: "dnx-no-docker-" });
  try {
    const stack = new URL("../src/cli/commands/stack.ts", import.meta.url).href;
    const code = `const { dockerCli } = await import(${JSON.stringify(stack)});
try { await dockerCli(["--version"], ".", true); console.log("ran"); }
catch (error) { console.log(error.message); }`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", code],
      env: { PATH: empty, Path: empty },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assertStringIncludes(text, "docker is not on PATH");
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("stack up: a missing .env over an existing database volume is refused, not regenerated", async () => {
  // Re-running `stack up` after deleting .env wrote a NEW POSTGRES_PASSWORD that the existing
  // db-data volume (initialised with the old one) refused; the app then failed every query.
  const root = await Deno.makeTempDir({ prefix: "dnx-stack-vol-" });
  try {
    await Deno.writeTextFile(`${root}/docker-compose.yml`, "services: {}\n");
    await Deno.writeTextFile(
      `${root}/.env.example`,
      "# Generate: openssl rand -hex 24\nPOSTGRES_PASSWORD=\n",
    );
    const calls: string[][] = [];
    const errors: string[] = [];
    const io: StackIo = {
      docker: (args) => {
        calls.push(args);
        if (args.includes("config")) {
          return Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ name: "myapp", services: { db: {}, web: {} } }),
            stderr: "",
          });
        }
        if (args[0] === "volume") {
          const known = args[2] === "myapp_db-data";
          return Promise.resolve({ code: known ? 0 : 1, stdout: "", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
      },
      generate: () => Promise.resolve(),
      log: () => {},
      error: (line) => void errors.push(line),
    };
    assertEquals(await runStack(ctx(root, ["up"]), io), 1);
    assertStringIncludes(errors[0], "myapp_db-data");
    assertStringIncludes(errors[0], "denext stack down --volumes");
    assert(!calls.some((c) => c.includes("up")), "compose up never ran");
    let wrote = true;
    try {
      await Deno.stat(`${root}/.env`);
    } catch {
      wrote = false;
    }
    assertEquals(wrote, false, "no new .env written");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
