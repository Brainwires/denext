// `start.tls` in the generated deploy files: how the generators read it (the deploy manifest, else
// the config's text), the Docker image / compose / .env.example / .dockerignore with and without
// it (golden snapshots under tests/fixtures/docker-stack/tls — rewrite them with
// `DENEXT_UPDATE_GOLDEN=1 deno test -A tests/deploy-tls.test.ts`), the warnings, and the flag a
// `build --compile` bakes for several certificates. The deploy presets' TLS goldens are in
// tests/deploy-presets.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse } from "@std/yaml";
import {
  configTextTls,
  configuredTls,
  deployTls,
  projectUnstableNet,
  TLS_CERT_DIR,
  tlsCompileFlags,
  tlsEnvNames,
  tlsServesLocalhost,
  tlsUnstableNetWarnings,
  withCertificateReads,
} from "../src/build/start-tls-deploy.ts";
import {
  type DockerOptions,
  dockerPlan,
  renderCompose,
  renderDockerfile,
  renderDockerignore,
} from "../src/build/docker-template.ts";
import { renderComposeDev, renderEnvExample } from "../src/build/docker-stack.ts";
import { resolveDocker } from "../src/build/docker-detect.ts";
import type { DeployServerTls } from "../src/deploy/manifest.ts";

const GOLDEN = new URL("./fixtures/docker-stack/tls/", import.meta.url);

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

/** Three certificates, one of them the `"*"` fallback (the docs' example). */
const SEVERAL: DeployServerTls = {
  certificates: [
    {
      hostnames: ["example.com", "www.example.com"],
      certFileEnv: "SITE_CERT",
      keyFileEnv: "SITE_KEY",
    },
    { hostnames: ["*.example.org"], certFileEnv: "ORG_CERT", keyFileEnv: "ORG_KEY" },
    { hostnames: ["*"], certFileEnv: "DEFAULT_CERT", keyFileEnv: "DEFAULT_KEY" },
  ],
};

/** One certificate (served for every name). */
const ONE: DeployServerTls = {
  certificates: [{ hostnames: ["example.com"], certFileEnv: "TLS_CERT", keyFileEnv: "TLS_KEY" }],
};

const START = [
  "deno",
  "run",
  "--allow-net",
  "--allow-read",
  "--allow-env",
  "--allow-write=.denext",
  "jsr:@denext/denext@^4.0.0/cli",
  "start",
  ".",
];

/** The plain (no stack) server image, fixed tag and network grant, with or without TLS. */
function plain(tls: DeployServerTls | null, over: Partial<DockerOptions> = {}): DockerOptions {
  return {
    mode: "server",
    denoTag: "2.9.7",
    netSplit: false,
    cli: ["--config", "deno.json", "jsr:@denext/denext@^4.0.0/cli"],
    startCommand: START,
    tls,
    ...over,
  };
}

/** The stack (Postgres + migrations + dev overlay) with TLS. */
const STACK: DockerOptions = plain(SEVERAL, {
  postgres: true,
  migrate: true,
  dashboard: true,
  dev: true,
  migrateCommand: ["deno", "task", "migrate"],
});

Deno.test("deployTls: the manifest's certificates, null for plain HTTP", () => {
  assertEquals(deployTls(undefined), null);
  assertEquals(deployTls({ certificates: [] }), null);
  assertEquals(deployTls({ certificates: [...SEVERAL.certificates] }), SEVERAL);
});

Deno.test("configTextTls: start.tls's literal certificates, comments and other blocks ignored", () => {
  const text = `
// start: { tls: { certificates: [{ hostnames: ["x"], certFileEnv: "NO", keyFileEnv: "NO" }] } }
export default {
  live: { tls: { certificates: [{ certFileEnv: "LIVE", keyFileEnv: "LIVE" }] } },
  start: {
    limits: { memory: "512m" },
    tls: {
      certificates: [
        { hostnames: ["example.com", 'www.example.com'], certFileEnv: "SITE_CERT", keyFileEnv: 'SITE_KEY' },
        /* computed: not literal */ { hostnames: ["a"], certFileEnv: name, keyFileEnv: "K" },
        { certFileEnv: \`ORG_CERT\`, keyFileEnv: "ORG_KEY" },
      ],
    },
  },
};`;
  assertEquals(configTextTls(text), {
    certificates: [
      {
        hostnames: ["example.com", "www.example.com"],
        certFileEnv: "SITE_CERT",
        keyFileEnv: "SITE_KEY",
      },
      { hostnames: [], certFileEnv: "ORG_CERT", keyFileEnv: "ORG_KEY" },
    ],
  });
  assertEquals(configTextTls("export default { start: { limits: {} } };"), null);
  assertEquals(configTextTls("export default { start: { tls: { certificates: [] } } };"), null);
  assertEquals(configTextTls("export default {};"), null);
});

Deno.test("configuredTls: the last build's manifest wins over the config's text", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tls_cfg_" });
  try {
    assertEquals(await configuredTls(dir), null, "no config, no build");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { start: { tls: { certificates: [{ hostnames: ["*"], certFileEnv: "C", keyFileEnv: "K" }] } } };`,
    );
    assertEquals(await configuredTls(dir), {
      certificates: [{ hostnames: ["*"], certFileEnv: "C", keyFileEnv: "K" }],
    });
    await Deno.mkdir(join(dir, ".denext"));
    const manifest = join(dir, ".denext", "deploy-manifest.json");
    // A manifest from before the field: the text still decides.
    await Deno.writeTextFile(manifest, JSON.stringify({ server: { limits: [] } }));
    assertEquals((await configuredTls(dir))?.certificates[0].certFileEnv, "C");
    // The evaluated config said plain HTTP.
    await Deno.writeTextFile(manifest, JSON.stringify({ server: { tls: null } }));
    assertEquals(await configuredTls(dir), null);
    await Deno.writeTextFile(manifest, JSON.stringify({ server: { tls: SEVERAL } }));
    assertEquals(await configuredTls(dir), SEVERAL);
    await Deno.writeTextFile(manifest, "{ not json");
    assertEquals((await configuredTls(dir))?.certificates[0].certFileEnv, "C");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tlsEnvNames / tlsServesLocalhost: each variable once; the probe's handshake", () => {
  assertEquals(tlsEnvNames(SEVERAL), [
    "SITE_CERT",
    "SITE_KEY",
    "ORG_CERT",
    "ORG_KEY",
    "DEFAULT_CERT",
    "DEFAULT_KEY",
  ]);
  const shared: DeployServerTls = {
    certificates: [
      { hostnames: ["a.test"], certFileEnv: "CERT", keyFileEnv: "KEY" },
      { hostnames: ["b.test"], certFileEnv: "CERT", keyFileEnv: "KEY" },
    ],
  };
  assertEquals(tlsEnvNames(shared), ["CERT", "KEY"]);
  assert(tlsServesLocalhost(ONE), "one certificate is served for every name");
  assert(tlsServesLocalhost(SEVERAL), '"*" serves localhost');
  assert(!tlsServesLocalhost(shared));
  assert(tlsServesLocalhost({
    certificates: [...shared.certificates, {
      hostnames: ["localhost"],
      certFileEnv: "L",
      keyFileEnv: "L",
    }],
  }));
});

Deno.test("projectUnstableNet / tlsUnstableNetWarnings: several certificates need it in deno.json", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tls_unstable_" });
  try {
    assertEquals(await projectUnstableNet(dir), false);
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "unstable": ["kv"] }`);
    assertEquals(await projectUnstableNet(dir), false);
    await Deno.writeTextFile(join(dir, "deno.json"), `{ "unstable": ["kv", "net"] }`);
    assertEquals(await projectUnstableNet(dir), true);
    await Deno.remove(join(dir, "deno.json"));
    await Deno.writeTextFile(join(dir, "deno.jsonc"), `{ // c\n "unstable": ["net"] }`);
    assertEquals(await projectUnstableNet(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(tlsUnstableNetWarnings(ONE, false, "x"), []);
  assertEquals(tlsUnstableNetWarnings(null, false, "x"), []);
  assertEquals(tlsUnstableNetWarnings(SEVERAL, true, "x"), []);
  const [warning] = tlsUnstableNetWarnings(SEVERAL, false, "docker");
  assertStringIncludes(warning, "docker: start.tls lists 3 certificates");
  assertStringIncludes(warning, '"unstable": ["net"]');
});

Deno.test("tlsCompileFlags: --unstable-net for several certificates (the compile config has no unstable)", () => {
  assertEquals(tlsCompileFlags(undefined), []);
  assertEquals(tlsCompileFlags(ONE), []);
  assertEquals(tlsCompileFlags(SEVERAL), ["--unstable-net"]);
});

Deno.test("withCertificateReads: a scoped --allow-read gains the certificate directory", () => {
  assertEquals(withCertificateReads(START, "/certs"), START, "unscoped already reads it");
  assertEquals(
    withCertificateReads(["deno", "run", "--allow-read=.,/tmp", "x"], "/certs"),
    ["deno", "run", "--allow-read=.,/tmp,/certs", "x"],
  );
  assertEquals(
    withCertificateReads(["deno", "run", "--allow-read=/certs", "x"], "/certs"),
    ["deno", "run", "--allow-read=/certs", "x"],
  );
});

Deno.test("golden: the server image with and without start.tls", async () => {
  await golden("Dockerfile.plain", renderDockerfile(plain(null)));
  await golden("Dockerfile.tls", renderDockerfile(plain(ONE)));
  await golden("docker-compose.plain.yml", renderCompose(plain(null)));
  await golden("docker-compose.tls.yml", renderCompose(plain(ONE)));
  await golden("env.example.tls", renderEnvExample(plain(ONE)));
  await golden("dockerignore.plain", renderDockerignore(plain(null)));
  await golden("dockerignore.tls", renderDockerignore(plain(ONE)));
  await golden("docker-compose.stack-tls.yml", renderCompose(STACK));
  await golden("env.example.stack-tls", renderEnvExample(STACK));
  await golden("compose.dev.stack-tls.yml", renderComposeDev(STACK, 3000));
});

Deno.test("Dockerfile with start.tls: an https probe, the certificates outside the image", () => {
  const tls = renderDockerfile(plain(ONE));
  assertStringIncludes(
    tls,
    `CMD ["deno", "eval", "--unsafely-ignore-certificate-errors=localhost", "fetch('https://localhost:3000/_denext/health')`,
  );
  assert(!tls.includes("http://127.0.0.1"), "no plain-HTTP probe");
  assertStringIncludes(tls, `mount them read-only at ${TLS_CERT_DIR}`);
  // The plain image is what it was.
  const http = renderDockerfile(plain(null));
  assertStringIncludes(http, `fetch('http://127.0.0.1:3000/_denext/health')`);
  assert(!http.includes("start.tls"));
  // A start task that scopes its reads gets the certificate directory.
  const scoped = renderDockerfile(
    plain(ONE, { startCommand: START.map((w) => w === "--allow-read" ? "--allow-read=." : w) }),
  );
  assertStringIncludes(scoped, `"--allow-read=.,${TLS_CERT_DIR}"`);
  // The static image serves files with the std file server: start.tls never reaches it.
  const fileServer = renderDockerfile(plain(ONE, { mode: "static" }));
  assert(!fileServer.includes("https://"), fileServer);
  assertEquals(renderDockerignore(plain(ONE, { mode: "static" })).includes("certs"), false);
});

Deno.test("compose with start.tls: certs mounted read-only, the variables required, https probes", () => {
  type Doc = {
    services: Record<string, {
      volumes?: string[];
      environment?: Record<string, string> | string[];
      healthcheck?: { test: string[] };
    }>;
  };
  const one = parse(renderCompose(plain(ONE))) as Doc;
  assertEquals(one.services.web.volumes, [`./certs:${TLS_CERT_DIR}:ro`]);
  assertEquals(one.services.web.environment, [
    "NODE_ENV=production",
    "TLS_CERT=${TLS_CERT:?set it in .env (see .env.example)}",
    "TLS_KEY=${TLS_KEY:?set it in .env (see .env.example)}",
  ]);
  const stack = parse(renderCompose(STACK)) as Doc;
  const env = stack.services.web.environment as Record<string, string>;
  for (const name of tlsEnvNames(SEVERAL)) {
    assertEquals(env[name], `\${${name}:?set it in .env (see .env.example)}`);
  }
  assertEquals(stack.services.web.volumes, [`./certs:${TLS_CERT_DIR}:ro`]);
  assertStringIncludes(stack.services.web.healthcheck!.test.join(" "), "https://localhost:3000");
  // The migrations container serves nothing: no certificates.
  assertEquals((stack.services.migrate.environment as Record<string, string>).SITE_CERT, undefined);
  // `denext dev` serves plain HTTP: the overlay probes it so.
  const dev = parse(renderComposeDev(STACK, 3000)) as Doc;
  assertStringIncludes(dev.services.web.healthcheck!.test.join(" "), "http://127.0.0.1:3000");
  assert(!renderComposeDev(plain(null, { postgres: true }), 3000).includes("healthcheck"));
  // .env.example lists them empty (they are required), never a value.
  const example = renderEnvExample(plain(ONE));
  assertStringIncludes(example, "\nTLS_CERT=\n");
  assertStringIncludes(example, "\nTLS_KEY=\n");
  assertStringIncludes(example, "PEM private key file");
});

Deno.test("dockerPlan: start.tls writes .env.example without a stack", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tls_plan_" });
  try {
    const names = async (o: DockerOptions) =>
      (await dockerPlan(dir, o)).map((f) => f.path.slice(dir.length + 1));
    assertEquals(await names(plain(null)), ["Dockerfile", "docker-compose.yml", ".dockerignore"]);
    assertEquals(await names(plain(ONE)), [
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
      ".env.example",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveDocker: start.tls from the config, with the warnings it needs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tls_resolve_" });
  const config = (certs: string) =>
    Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { start: { tls: { certificates: [${certs}] } } };`,
    );
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ tasks: {} }));
    assertEquals((await resolveDocker(dir)).options.tls, undefined, "plain HTTP");
    await config(`{ hostnames: ["a.test"], certFileEnv: "A", keyFileEnv: "AK" },
      { hostnames: ["b.test"], certFileEnv: "B", keyFileEnv: "BK" }`);
    const several = await resolveDocker(dir);
    assertEquals(tlsEnvNames(several.options.tls!), ["A", "AK", "B", "BK"]);
    assert(
      several.warnings.some((w) => w.includes('"unstable": ["net"]')),
      several.warnings.join("\n"),
    );
    assert(
      several.warnings.some((w) => w.includes('"localhost" or "*"')),
      several.warnings.join("\n"),
    );
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ unstable: ["net"] }));
    await config(`{ hostnames: ["a.test"], certFileEnv: "A", keyFileEnv: "AK" },
      { hostnames: ["*"], certFileEnv: "B", keyFileEnv: "BK" }`);
    assertEquals((await resolveDocker(dir)).warnings, []);
    // The static image: left out, with a warning.
    const spa = await resolveDocker(dir, { target: "spa" });
    assertEquals(spa.options.tls, undefined);
    assert(spa.warnings.some((w) => w.includes("static (SPA) image")), spa.warnings.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
