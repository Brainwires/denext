// Server Action calls load on demand: a Flight-revived reference calls through the loader the
// generated Flight entry registers (`denext/action-call`), and the generic stub through its own
// dispatch chunk. Neither path puts the dispatch in a page's startup chunks
// (tests/integration/build-smoke.test.ts guards that); these tests guard that the calls still work.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { parseFlight, setActionCallLoader } from "../src/client/flight-client.ts";
import { callAction } from "../src/client/action-call.ts";
import { dispatchAction, encodeActionArgs } from "../src/client/action-dispatch.ts";
import { setActionRefreshHandler } from "../src/runtime/server-action.ts";
import { decodeWire } from "../src/runtime/wire-codec.ts";
import { prepareWire } from "../src/runtime/wire-encode.ts";

/** Run `body` with `fetch` answering `reply` (and recording each request). */
async function withFetch(
  reply: Record<string, unknown>,
  body: (requests: Request[]) => Promise<void>,
  status = 200,
): Promise<void> {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(new URL(String(input), "http://localhost"), init));
    return Promise.resolve(
      new Response(JSON.stringify(reply), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await body(requests);
  } finally {
    globalThis.fetch = original;
  }
}

/** A Flight host node whose `action` prop is the reference `id`, revived. */
function revivedAction(id: string): (...args: unknown[]) => Promise<unknown> {
  const tree = parseFlight(
    { $: "h", t: "form", p: { action: { $: "a", i: id } }, c: [] },
    new Map(),
  );
  return (tree as unknown as { props: { action: (...args: unknown[]) => Promise<unknown> } }).props
    .action;
}

// First in the file: the loader is module state, unset until a Flight entry registers it.
Deno.test("a Flight-revived action with no loader registered rejects with a clear error", async () => {
  const save = revivedAction("mod#none");
  await assertRejects(() => save(), Error, "no Server Action loader is installed");
});

Deno.test("a Flight-revived action calls through the registered loader", async () => {
  let loads = 0;
  setActionCallLoader(() => {
    loads++;
    return Promise.resolve({ callAction });
  });
  let refreshed = 0;
  setActionRefreshHandler(() => refreshed++);
  try {
    const save = revivedAction("mod#save");
    assertEquals((save as unknown as { denextActionId: string }).denextActionId, "mod#save");
    assert(loads >= 1, "reviving a reference starts loading the call chunk");
    await withFetch(
      { result: { $: "D", v: "2026-10-21T00:00:00.000Z" }, enc: 1, refresh: true },
      async (requests) => {
        const result = await save({ at: new Date(0) });
        assert(result instanceof Date, "a codec-flagged result is decoded");
        assertEquals(refreshed, 1, "a refreshing action re-renders the route");
        assertEquals(requests.length, 1);
        assertEquals(new URL(requests[0].url).pathname, "/_denext/action/mod%23save");
        assertEquals(requests[0].headers.get("x-denext-action"), "1");
        const sent = await requests[0].json();
        assertEquals(sent.enc, 1, "Date args ride the wire codec");
      },
    );
  } finally {
    setActionRefreshHandler(() => {});
  }
});

Deno.test("the dispatch surfaces errors and follows redirects", async () => {
  await withFetch({ error: "nope" }, async () => {
    await assertRejects(
      () => dispatchAction("a#b", [], null, decodeWire, prepareWire),
      Error,
      "nope",
    );
  });
  await withFetch({}, async () => {
    await assertRejects(
      () => dispatchAction("a#b", [], null, decodeWire, prepareWire),
      Error,
      "server action failed (500)",
    );
  }, 500);
  // No `location` under Deno: a redirect resolves to undefined without navigating.
  await withFetch({ redirect: "/next" }, async () => {
    assertEquals(await dispatchAction("a#b", [], null, decodeWire, prepareWire), undefined);
  });
});

Deno.test("a FormData argument rides as multipart with the others in the meta field", () => {
  const fd = new FormData();
  fd.set("q", "x");
  const { body, headers } = encodeActionArgs([1, fd], prepareWire);
  assert(body instanceof FormData);
  assertEquals(headers, {});
  assertEquals(JSON.parse(String(body.get("__denext_meta"))), { fdIndex: 1, others: [1, null] });
});
