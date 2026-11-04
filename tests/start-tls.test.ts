// `start.tls` (src/server/tls-certificates.ts): HTTPS for the production server — one certificate
// on any Deno, several picked by SNI through `resolveCertificate` on denext's Deno from runtime
// 3.0.0-denext.3 — its config validation, and a real handshake per host name.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  FIRST_RESOLVE_CERTIFICATE_RUNTIME,
  supportsResolveCertificate,
} from "../src/build/deno-version.ts";
import {
  certificateFor,
  type CertifiedKeyPem,
  serveTlsOptions,
} from "../src/server/tls-certificates.ts";
import { loopbackOrigin } from "../src/server/remote-addr.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig, StartTls } from "../src/server/config.ts";

const FIXTURES = fromFileUrl(new URL("./fixtures/tls/", import.meta.url));

const TWO: StartTls = {
  certificates: [
    { hostnames: ["a.test"], certFileEnv: "A_CERT", keyFileEnv: "A_KEY" },
    { hostnames: ["*.b.test", "*"], certFileEnv: "B_CERT", keyFileEnv: "B_KEY" },
  ],
};

const files: Record<string, string> = {
  "/a.crt": "A-CERT",
  "/a.key": "A-KEY",
  "/b.crt": "B-CERT",
  "/b.key": "B-KEY",
};
const env = (name: string) =>
  ({ A_CERT: "/a.crt", A_KEY: "/a.key", B_CERT: "/b.crt", B_KEY: "/b.key" })[name];
const readFile = (path: string) => {
  const text = files[path];
  if (text === undefined) throw new Deno.errors.NotFound(`no ${path}`);
  return text;
};
const deps = { env, readFile, runtime: FIRST_RESOLVE_CERTIFICATE_RUNTIME, unstableNet: true };

Deno.test("supportsResolveCertificate: from runtime 3.0.0-denext.3 on", () => {
  assertEquals(FIRST_RESOLVE_CERTIFICATE_RUNTIME, "3.0.0-denext.3");
  for (const v of ["3.0.0-denext.3", "3.0.0-denext.4", "3.0.1"]) {
    assert(supportsResolveCertificate(v), v);
  }
  for (const v of ["3.0.0-denext.2", "3.0.0-rc.7", "2.9.7-denext.14", "2.9.8", "nonsense"]) {
    assert(!supportsResolveCertificate(v), v);
  }
});

Deno.test("certificateFor: exact, then the one-label wildcard, then '*'", () => {
  const a = { cert: "a", key: "a" };
  const w = { cert: "w", key: "w" };
  const any = { cert: "any", key: "any" };
  const certs = new Map<string, CertifiedKeyPem>([["a.test", a], ["*.b.test", w]]);
  assertEquals(certificateFor(certs, "a.test"), a);
  assertEquals(certificateFor(certs, "A.Test."), a);
  assertEquals(certificateFor(certs, "www.b.test"), w);
  assertEquals(certificateFor(certs, "b.test"), undefined);
  assertEquals(certificateFor(certs, "x.www.b.test"), undefined);
  assertEquals(certificateFor(certs, ""), undefined);
  certs.set("*", any);
  assertEquals(certificateFor(certs, "b.test"), any);
  assertEquals(certificateFor(certs, ""), any);
  assertEquals(certificateFor(certs, "www.b.test"), w);
});

Deno.test("serveTlsOptions: none, one certificate as cert/key on any runtime", () => {
  assertEquals(serveTlsOptions(undefined, deps), undefined);
  assertEquals(serveTlsOptions({ certificates: [] }, deps), undefined);
  const one = serveTlsOptions(
    { certificates: [TWO.certificates[0]] },
    { env, readFile, runtime: undefined, unstableNet: false },
  );
  assertEquals(one, { cert: "A-CERT", key: "A-KEY" });
});

Deno.test("serveTlsOptions: several certificates resolve by server name", () => {
  const tls = serveTlsOptions(TWO, deps);
  assert(tls && "resolveCertificate" in tls);
  assertEquals(tls.resolveCertificate("a.test"), { cert: "A-CERT", key: "A-KEY" });
  assertEquals(tls.resolveCertificate("api.b.test"), { cert: "B-CERT", key: "B-KEY" });
  assertEquals(tls.resolveCertificate(""), { cert: "B-CERT", key: "B-KEY" });
  const exact = serveTlsOptions({ certificates: [TWO.certificates[0], TWO.certificates[0]] }, deps);
  assert(exact && "resolveCertificate" in exact);
  assertThrows(() => exact.resolveCertificate("other.test"), Error, `"other.test"`);
});

Deno.test("serveTlsOptions: several certificates need runtime 3.0.0-denext.3 and --unstable-net", () => {
  const stock = assertThrows(() => serveTlsOptions(TWO, { ...deps, runtime: undefined }));
  assertStringIncludes((stock as Error).message, "3.0.0-denext.3, and this is a stock Deno");
  const older = assertThrows(() => serveTlsOptions(TWO, { ...deps, runtime: "3.0.0-denext.2" }));
  assertStringIncludes((older as Error).message, "this is runtime 3.0.0-denext.2");
  const flag = assertThrows(() => serveTlsOptions(TWO, { ...deps, unstableNet: false }));
  assertStringIncludes((flag as Error).message, `"unstable": ["net"]`);
});

Deno.test("serveTlsOptions: an unset variable or an unreadable file fails the start", () => {
  const unset = assertThrows(() => serveTlsOptions(TWO, { ...deps, env: () => undefined }));
  assertStringIncludes(
    (unset as Error).message,
    "start.tls.certificates[0].certFileEnv names $A_CERT",
  );
  const missing = assertThrows(() =>
    serveTlsOptions(TWO, { ...deps, env: (n) => (n === "B_KEY" ? "/nope.key" : env(n)) })
  );
  assertStringIncludes((missing as Error).message, "cannot read $B_KEY (/nope.key)");
});

Deno.test("loopbackOrigin: https for a TLS server", () => {
  const addr: Deno.NetAddr = { transport: "tcp", hostname: "0.0.0.0", port: 8443 };
  assertEquals(loopbackOrigin(addr), "http://127.0.0.1:8443");
  assertEquals(loopbackOrigin(addr, "https"), "https://127.0.0.1:8443");
});

Deno.test("start.tls: the config validator checks the certificates and their host names", () => {
  const check = (tls: unknown) => () => validateDenextConfig({ start: { tls } } as DenextConfig);
  check(undefined)();
  check(TWO)();
  const bad: [unknown, string][] = [
    ["yes", "start.tls"],
    [{ certificates: [] }, "start.tls.certificates"],
    [{ certificates: ["x"] }, "start.tls.certificates[0]"],
    [{ certificates: [{ hostnames: [], certFileEnv: "A", keyFileEnv: "B" }] }, "hostnames"],
    [{ certificates: [{ hostnames: ["a..test"], certFileEnv: "A", keyFileEnv: "B" }] }, "a..test"],
    [
      { certificates: [{ hostnames: ["a.*.test"], certFileEnv: "A", keyFileEnv: "B" }] },
      "a.*.test",
    ],
    [
      { certificates: [{ hostnames: ["a.test"], certFileEnv: "/etc/a.pem", keyFileEnv: "B" }] },
      "certFileEnv",
    ],
    [{ certificates: [{ hostnames: ["a.test"], certFileEnv: "A" }] }, "keyFileEnv"],
    [{
      certificates: [
        { hostnames: ["a.test"], certFileEnv: "A", keyFileEnv: "B" },
        { hostnames: ["A.test."], certFileEnv: "C", keyFileEnv: "D" },
      ],
    }, "listed by another certificate"],
  ];
  for (const [tls, needle] of bad) {
    const err = assertThrows(check(tls), Error, undefined, JSON.stringify(tls));
    assertStringIncludes(err.message, needle);
  }
});

/** Whether this process's Deno can run the handshake below (denext's Deno from 3.0.0-denext.3). */
function runtimeResolves(): boolean {
  const marker = (Deno.build as { denext?: string }).denext;
  return typeof marker === "string" && supportsResolveCertificate(marker);
}

Deno.test({
  name: "start.tls: one listener serves each host name its own certificate (SNI)",
  ignore: !runtimeResolves(),
  async fn() {
    // A child with --unstable-net: the test process itself may run without it.
    const serveTls = new URL("../src/server/tls-certificates.ts", import.meta.url).href;
    const serveUtils = new URL("../src/server/serve-utils.ts", import.meta.url).href;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-net",
        "--no-lock",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        "-",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
      env: {
        A_CERT: join(FIXTURES, "a.crt"),
        A_KEY: join(FIXTURES, "a.key"),
        B_CERT: join(FIXTURES, "b.crt"),
        B_KEY: join(FIXTURES, "b.key"),
        F_CERT: join(FIXTURES, "fallback.crt"),
        F_KEY: join(FIXTURES, "fallback.key"),
      },
    }).spawn();
    const script = `
      import { serveTlsOptions } from ${JSON.stringify(serveTls)};
      import { serveWithPortFallback } from ${JSON.stringify(serveUtils)};
      const tls = serveTlsOptions({ certificates: [
        { hostnames: ["a.test"], certFileEnv: "A_CERT", keyFileEnv: "A_KEY" },
        { hostnames: ["*.b.test"], certFileEnv: "B_CERT", keyFileEnv: "B_KEY" },
        { hostnames: ["*"], certFileEnv: "F_CERT", keyFileEnv: "F_KEY" },
      ] });
      const server = serveWithPortFallback({
        port: 0, hostname: "127.0.0.1", strict: true, tls,
        onListen: ({ port }) => console.log(port),
      }, (req) => new Response(new URL(req.url).protocol));
      await new Promise((r) => setTimeout(r, 30_000));
      await server.shutdown();
    `;
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(script));
    await writer.close();
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the server exited before it listened");
      line += value;
    }
    const port = Number(line.trim());
    try {
      /** The response body over TLS to 127.0.0.1 with `serverName` as SNI, trusting `ca`. */
      const get = async (serverName: string, ca: string): Promise<string> => {
        const tcp = await Deno.connect({ hostname: "127.0.0.1", port });
        const conn = await Deno.startTls(tcp, {
          hostname: serverName,
          caCerts: [await Deno.readTextFile(join(FIXTURES, ca))],
        });
        try {
          await conn.write(
            new TextEncoder().encode(
              `GET / HTTP/1.1\r\nHost: ${serverName}\r\nConnection: close\r\n\r\n`,
            ),
          );
          return await new Response(conn.readable).text();
        } catch (err) {
          conn.close();
          throw err;
        }
      };
      assertStringIncludes(await get("a.test", "a.crt"), "https:");
      assertStringIncludes(await get("api.b.test", "b.crt"), "https:");
      // No SNI (an IP address) gets the "*" certificate.
      assertStringIncludes(await get("127.0.0.1", "fallback.crt"), "https:");
      // a.test is not served b's certificate: trusting only b's fails the handshake.
      await assertRejectsAny(() => get("a.test", "b.crt"));
    } finally {
      child.kill();
      await reader.cancel().catch(() => {});
      await child.status;
    }
  },
});

/** That `fn` rejects, whatever with. */
async function assertRejectsAny(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("expected a rejection");
}

Deno.test("SPA start: one start.tls certificate serves HTTPS", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_start_tls_" });
  const client = join(dir, ".denext", "client");
  await Deno.mkdir(client, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default { mode: "spa", spa: { entry: "./main.tsx" }, start: { tls: { certificates: ` +
      `[{ hostnames: ["*"], certFileEnv: "DENEXT_TEST_TLS_CERT", keyFileEnv: "DENEXT_TEST_TLS_KEY" }] } } };\n`,
  );
  await Deno.writeTextFile(join(client, "index.html"), "<!doctype html><title>tls</title>");
  Deno.env.set("DENEXT_TEST_TLS_CERT", join(FIXTURES, "fallback.crt"));
  Deno.env.set("DENEXT_TEST_TLS_KEY", join(FIXTURES, "fallback.key"));
  const { startSpaProdServer } = await import("../src/build/spa.ts");
  const controller = new AbortController();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  let server: Deno.HttpServer;
  try {
    server = await startSpaProdServer({
      projectDir: dir,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
    });
  } finally {
    console.log = log;
  }
  const port = (server.addr as Deno.NetAddr).port;
  const http = Deno.createHttpClient({
    caCerts: [await Deno.readTextFile(join(FIXTURES, "fallback.crt"))],
  });
  try {
    const res = await fetch(`https://127.0.0.1:${port}/`, {
      client: http,
      headers: { accept: "text/html" },
    });
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "<title>tls</title>");
    // The HSTS default applies to a secure response.
    assert(res.headers.get("strict-transport-security"));
  } finally {
    http.close();
    controller.abort();
    await server.finished;
    Deno.env.delete("DENEXT_TEST_TLS_CERT");
    Deno.env.delete("DENEXT_TEST_TLS_KEY");
    await Deno.remove(dir, { recursive: true });
  }
  await new Promise((r) => setTimeout(r, 0));
  assert(lines.some((l) => l.startsWith("denext start ▸ https://")), lines.join("\n"));
});
