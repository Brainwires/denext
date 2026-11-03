// `finalizeNew` builds a routed response with the injected (header rules + middleware) headers
// merged into its own before it is constructed: the same response `finalize` makes from a built
// one, without the second `Headers` and `Response` the copy cost on every page.

import { assertEquals } from "@std/assert";
import {
  finalize,
  finalizeLacking,
  finalizeNew,
  type RequestState,
} from "../src/server/pipeline-state.ts";
import { htmlResponse } from "../src/server/page-document.ts";

function stateWith(injected?: Headers, outgoing = new Headers(), status?: number): RequestState {
  return {
    injectedHeaders: injected,
    ctx: { outgoingHeaders: outgoing, responseStatus: status },
  } as unknown as RequestState;
}

async function shape(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers],
    cookies: res.headers.getSetCookie(),
    body: await res.text(),
  };
}

Deno.test("finalizeNew makes the response finalize makes, with every header source merged", async () => {
  const own = {
    "content-type": "text/html; charset=utf-8",
    "x-frame-options": "DENY",
    "set-cookie": "own=1",
  };
  const cases: Array<() => RequestState> = [
    () => stateWith(),
    () => {
      const injected = new Headers({ "x-frame-options": "SAMEORIGIN", "x-rule": "a" });
      injected.append("set-cookie", "rule=1");
      injected.append("set-cookie", "mw=2");
      return stateWith(injected);
    },
    () => stateWith(new Headers({ "content-type": "text/plain" }), new Headers({ "x-out": "1" })),
    () => stateWith(new Headers({ "x-rule": "b" }), new Headers(), 404),
  ];
  for (const make of cases) {
    const expected = await shape(
      finalize(make(), new Response("<p>hi</p>", { status: 200, headers: own })),
    );
    assertEquals(await shape(finalizeNew(make(), "<p>hi</p>", 200, own)), expected);
  }
});

Deno.test("an HTML page response with injected headers is constructed once", () => {
  const Real = globalThis.Response;
  let made = 0;
  globalThis.Response = class extends Real {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      made++;
    }
  } as typeof Response;
  let res: Response;
  try {
    res = htmlResponse(stateWith(new Headers({ "x-rule": "a" })), "doc", 200, undefined);
  } finally {
    globalThis.Response = Real;
  }
  assertEquals(made, 1);
  assertEquals(res.headers.get("x-rule"), "a");
});

Deno.test("finalizeLacking adds only the headers a response lacks, keeping its status", async () => {
  const plain = new Response("x", { status: 302, headers: { location: "/a" } });
  // Nothing to add: the response itself.
  assertEquals(finalizeLacking(stateWith(), plain), plain);
  const injected = new Headers({ "x-rule": "a", "x-own": "rule" });
  injected.append("set-cookie", "rule=1");
  const outgoing = new Headers({ "x-out": "1" });
  outgoing.append("set-cookie", "sid=2");
  const own = new Headers({ location: "/a", "x-own": "mine" });
  own.append("set-cookie", "sid=2");
  const res = finalizeLacking(
    stateWith(injected, outgoing, 404),
    new Response("x", { status: 302, headers: own }),
  );
  const got = await shape(res);
  assertEquals(got.status, 302, "a loader's status override is the rendered response's");
  assertEquals(res.headers.get("x-own"), "mine");
  assertEquals(res.headers.get("x-rule"), "a");
  assertEquals(res.headers.get("x-out"), "1");
  assertEquals(got.cookies.sort(), ["rule=1", "sid=2"]);
});
