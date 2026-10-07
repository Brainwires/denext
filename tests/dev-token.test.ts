// The session token of a `denext dev` bound to a network address (src/build/dev-server/
// dev-token.ts): `Host`, `Origin` and `Sec-Fetch-Site` are only headers to a client that is not
// a browser, so on a LAN / wildcard bind every request from another machine must carry the token
// (cookie, header or the printed URL's query), the socket peer — never `Host` — decides who is
// local, and a loopback bind needs nothing. The gate is exercised against the real App Router
// dev handler (the endpoints a LAN peer must not reach), then end to end over real sockets.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  DEV_TOKEN_COOKIE,
  DEV_TOKEN_ENV,
  DEV_TOKEN_HEADER,
  DEV_TOKEN_PARAM,
  devProxyTokenHeaders,
  devSessionToken,
  devTokenGate,
  newDevToken,
  withDevTokenGate,
  withDevTokenParam,
} from "../src/build/dev-server/dev-token.ts";
import { createDevHandler } from "../src/build/dev-server/handler.ts";
import { createDevState } from "../src/build/dev-server/state.ts";
import { pickLanAddress } from "../src/build/dev-server/lan.ts";
import { resolveProject } from "../src/build/paths.ts";
import { startSpaDevServer } from "../src/build/spa.ts";
import { fsUrlPath } from "../src/build/dev-unbundled/state.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { startOrAttachDevServer } from "../src/cli/dev-attach.ts";
import { defaultLoader } from "../src/server/mod.ts";

const TOKEN = newDevToken();
const LAN_PEER: Deno.NetAddr = { transport: "tcp", hostname: "192.168.1.9", port: 50123 };
const LOOPBACK_PEER: Deno.NetAddr = { transport: "tcp", hostname: "127.0.0.1", port: 50124 };

/** A request as denext's server loop sees it: with its socket peer recorded. */
function from(peer: Deno.NetAddr, url: string, init?: RequestInit): Request {
  const request = new Request(url, init);
  setRemoteAddr(request, peer);
  return request;
}

Deno.test("devSessionToken: none on loopback; a fresh 256-bit token, or a well-formed env one, on a network bind", () => {
  const none = () => undefined;
  assertEquals(devSessionToken(undefined, none), undefined);
  assertEquals(devSessionToken("localhost", none), undefined);
  assertEquals(devSessionToken("127.0.0.1", none), undefined);
  assertMatch(devSessionToken("192.168.1.5", none)!, /^[0-9a-f]{64}$/);
  assertMatch(devSessionToken("0.0.0.0", none)!, /^[0-9a-f]{64}$/);
  assert(devSessionToken("0.0.0.0", none) !== devSessionToken("0.0.0.0", none));
  const env = (name: string) => name === DEV_TOKEN_ENV ? TOKEN : undefined;
  assertEquals(devSessionToken("192.168.1.5", env), TOKEN, "the parent CLI's token is used");
  const bad = () => "not-a-token; rm -rf ~";
  assertMatch(devSessionToken("192.168.1.5", bad)!, /^[0-9a-f]{64}$/, "a malformed one is not");
  assertEquals(
    withDevTokenParam("http://192.168.1.5:3000", TOKEN),
    `http://192.168.1.5:3000/?${DEV_TOKEN_PARAM}=${TOKEN}`,
  );
  assertEquals(withDevTokenParam("http://localhost:3000", undefined), "http://localhost:3000");
});

Deno.test("devTokenGate: the token URL trades the query for an HttpOnly SameSite=Strict cookie", () => {
  const url = `http://192.168.1.5:3000/about?x=1&${DEV_TOKEN_PARAM}=${TOKEN}`;
  const res = devTokenGate(from(LAN_PEER, url), TOKEN)!;
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/about?x=1", "the token leaves the address bar");
  const cookie = res.headers.get("set-cookie")!;
  assertStringIncludes(cookie, `${DEV_TOKEN_COOKIE}=${TOKEN}`);
  assertStringIncludes(cookie, "HttpOnly");
  assertStringIncludes(cookie, "SameSite=Strict");
  // With the cookie, the header or the query (non-navigation), a LAN request passes.
  const clean = "http://192.168.1.5:3000/_denext/dev-state";
  assertEquals(
    devTokenGate(
      from(LAN_PEER, clean, { headers: { cookie: `a=1; ${DEV_TOKEN_COOKIE}=${TOKEN}` } }),
      TOKEN,
    ),
    null,
  );
  assertEquals(
    devTokenGate(from(LAN_PEER, clean, { headers: { [DEV_TOKEN_HEADER]: TOKEN } }), TOKEN),
    null,
  );
  assertEquals(
    devTokenGate(from(LAN_PEER, `${clean}?${DEV_TOKEN_PARAM}=${TOKEN}`, { method: "POST" }), TOKEN),
    null,
  );
  // A wrong token anywhere is a 403.
  const wrong = newDevToken();
  for (
    const init of [
      { headers: { cookie: `${DEV_TOKEN_COOKIE}=${wrong}` } },
      { headers: { [DEV_TOKEN_HEADER]: wrong } },
    ] as RequestInit[]
  ) {
    assertEquals(devTokenGate(from(LAN_PEER, clean, init), TOKEN)?.status, 403);
  }
  assertEquals(
    devTokenGate(from(LAN_PEER, `${clean}?${DEV_TOKEN_PARAM}=${wrong}`), TOKEN)?.status,
    403,
  );
  // No token configured (a loopback bind): nothing is gated.
  assertEquals(devTokenGate(from(LAN_PEER, clean), undefined), null);
});

Deno.test("devTokenGate: the socket peer decides, not Host — a LAN peer claiming Host: localhost is refused", () => {
  const spoofed = from(LAN_PEER, "http://localhost:3000/_denext/dev-state", {
    headers: {
      host: "localhost:3000",
      "sec-fetch-site": "same-origin",
      origin: "http://localhost:3000",
    },
  });
  assertEquals(devTokenGate(spoofed, TOKEN)?.status, 403);
  // This machine's own loopback needs no token, whatever Host it names.
  assertEquals(
    devTokenGate(from(LOOPBACK_PEER, "http://192.168.1.5:3000/_denext/dev-state"), TOKEN),
    null,
  );
});

/** A throwaway App Router project for the real dev handler. */
async function tempApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_token_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: { "denext": abs("mod.ts"), "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts") },
    }),
  );
  await Deno.mkdir(join(dir, "app", "lib"), { recursive: true });
  await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => <p>hi</p>;\n");
  await Deno.writeTextFile(
    join(dir, "app", "lib", "db.ts"),
    'export const KEY = "server-secret";\n',
  );
  return dir;
}

Deno.test("dev handler behind the token: a bare LAN client gets 403 on @fs, dev-state, open-in-editor and the HMR upgrade", async () => {
  const dir = await Deno.realPath(await tempApp());
  try {
    // The LAN host is an allowed dev origin, as `--host` makes it: only the token stands between.
    const st = createDevState({
      paths: await resolveProject(dir),
      unbundled: true,
      allowedDevOrigins: ["192.168.1.5"],
    });
    st.load = defaultLoader;
    const handler = withDevTokenGate(
      createDevHandler(st, () => Promise.resolve(new Response("app"))),
      TOKEN,
    );
    const base = "http://192.168.1.5:3000";
    // Everything a browser would also send — none of it is proof from a non-browser.
    const browserish = { "sec-fetch-site": "same-origin", origin: base };
    const targets: Array<[string, RequestInit]> = [
      [base + fsUrlPath(join(dir, "app", "lib", "db.ts")), { headers: browserish }],
      [`${base}/_denext/dev-state`, { headers: browserish }],
      [`${base}/_denext/open-in-editor?file=app/page.tsx&line=1`, { headers: browserish }],
      [`${base}/_denext/reload`, { headers: browserish }],
      [`${base}/_denext/live`, {
        headers: { ...browserish, upgrade: "websocket", connection: "Upgrade" },
      }],
      [`${base}/`, {}],
    ];
    for (const [url, init] of targets) {
      const res = await handler(from(LAN_PEER, url, init));
      assertEquals(res.status, 403, url);
      const body = await res.text();
      assert(!body.includes("server-secret"), url);
      assertStringIncludes(body, DEV_TOKEN_PARAM);
    }
    // With the cookie the same LAN request reaches the dev endpoint.
    const withCookie = await handler(
      from(LAN_PEER, `${base}/_denext/dev-state`, {
        headers: { ...browserish, cookie: `${DEV_TOKEN_COOKIE}=${TOKEN}` },
      }),
    );
    assertEquals(withCookie.status, 200);
    await withCookie.body?.cancel();
    // From this machine's loopback no token is needed.
    const local = await handler(from(LOOPBACK_PEER, `http://localhost:3000/_denext/dev-state`));
    assertEquals(local.status, 200);
    await local.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev proxy: the token in the dev URL goes upstream as a header", () => {
  assertEquals(
    devProxyTokenHeaders(`http://192.168.1.5:3000/?${DEV_TOKEN_PARAM}=${TOKEN}`),
    { [DEV_TOKEN_HEADER]: TOKEN },
  );
  assertEquals(devProxyTokenHeaders("http://localhost:3000"), {});
});

const LAN = (() => {
  try {
    return pickLanAddress();
  } catch {
    return null;
  }
})();

Deno.test({
  name:
    "end to end: a wildcard-bound dev server refuses its LAN address without the token, accepts the printed URL, and needs nothing on loopback",
  ignore: LAN === null,
  async fn() {
    const project = fromFileUrl(new URL("../examples/spa", import.meta.url));
    const paths = await resolveProject(project);
    const controller = new AbortController();
    let port = 0;
    const listening = new Promise<void>((ready) => {
      startSpaDevServer({
        paths,
        hostname: "0.0.0.0",
        allowedDevOrigins: [LAN!],
        port: 0,
        devToken: TOKEN,
        signal: controller.signal,
        onListen: (info) => {
          port = info.port;
          ready();
        },
      });
    });
    await listening;
    try {
      const lan = `http://${LAN}:${port}`;
      // A bare client on the network: 403, pages and dev endpoints alike.
      for (const path of ["/", "/_denext/dev-state", "/_denext/reload"]) {
        const res = await fetch(lan + path, { headers: { "sec-fetch-site": "same-origin" } });
        assertEquals(res.status, 403, path);
        await res.body?.cancel();
      }
      // The printed URL: 303 + cookie, then the cookie carries every request.
      const first = await fetch(withDevTokenParam(lan, TOKEN), { redirect: "manual" });
      assertEquals(first.status, 303);
      const cookie = first.headers.get("set-cookie")!.split(";")[0];
      await first.body?.cancel();
      const page = await fetch(lan + first.headers.get("location"), { headers: { cookie } });
      assertEquals(page.status, 200);
      assertStringIncludes(await page.text(), 'id="root"');
      // (a browser also stamps Sec-Fetch-Site, which the origin gate still wants off loopback)
      const state = await fetch(lan + "/_denext/dev-state", {
        headers: { cookie, "sec-fetch-site": "same-origin" },
      });
      assertEquals(state.status, 200);
      await state.body?.cancel();
      // Loopback: no token.
      const local = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(local.status, 200);
      await local.body?.cancel();
    } finally {
      controller.abort();
      await new Promise((r) => setTimeout(r, 50));
    }
  },
});

Deno.test({
  name:
    "mobile / desktop dev attach: a network URL carries the running server's token; loopback carries none",
  ignore: LAN === null,
  async fn() {
    const project = await Deno.makeTempDir({ prefix: "denext_dev_attach_" });
    const server = Deno.serve(
      { hostname: "0.0.0.0", port: 0, onListen: () => {} },
      () => new Response("dev"),
    );
    try {
      const port = (server.addr as Deno.NetAddr).port;
      await Deno.mkdir(join(project, ".denext"));
      await Deno.writeTextFile(
        join(project, ".denext", "dev.json"),
        JSON.stringify({ origin: `http://127.0.0.1:${port}`, token: TOKEN }),
      );
      const lan = await startOrAttachDevServer(project, LAN!, `http://${LAN}:${port}`);
      assert(lan.attached);
      assertEquals(lan.url, withDevTokenParam(`http://${LAN}:${port}`, TOKEN));
      const local = await startOrAttachDevServer(project, "localhost", `http://127.0.0.1:${port}`);
      assertEquals(local.url, `http://127.0.0.1:${port}`);
    } finally {
      await server.shutdown();
      await Deno.remove(project, { recursive: true });
    }
  },
});
