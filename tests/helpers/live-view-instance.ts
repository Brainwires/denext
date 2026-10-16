// One Live replica for tests/live-views-instances.test.ts: a Live hub on a free port whose parked
// live views go to a Redis `LiveViewStore`, with a counter view (`it-counter`) and
// `GET /props?start=N` answering the signed props a page would carry. Prints `{"port": N}` once
// it is serving. The parent sets one `DENEXT_LIVE_VIEW_SECRET` for every replica.
//
//   deno run -A tests/helpers/live-view-instance.ts <redis-url> <key-prefix>

import { h } from "../../src/jsx/jsx-runtime.ts";
import { installLiveHub } from "../../src/server/live.ts";
import { serveLiveReplica } from "./live-replica-server.ts";
import { setLiveViewStore } from "../../src/server/live-view-store.ts";
import { redisLiveViewStore } from "../../src/server/live-view-stores.ts";
import { defineLiveView, signLiveViewToken } from "../../src/runtime/live-view.ts";

const [url, prefix] = Deno.args;
setLiveViewStore(redisLiveViewStore({ url, prefix }));
defineLiveView<{ n: number; at: Date }, { type: "inc" }, { start: number }>({
  id: "it-counter",
  init: (props) => [{ n: props.start, at: new Date(0) }],
  update: (_msg, m) => [{ n: m.n + 1, at: new Date(m.at.getTime() + 1000) }],
  view: (m, send) =>
    h("button", { type: "button", onClick: send({ type: "inc" }) }, `n=${m.n} t=${m.at.getTime()}`),
});
installLiveHub({
  appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
  originAllowed: () => true,
  config: {},
});
serveLiveReplica(async (u) => {
  if (u.pathname !== "/props") return null;
  const props = JSON.stringify({ start: Number(u.searchParams.get("start")) });
  return Response.json({ props, token: await signLiveViewToken("it-counter", props) });
});
