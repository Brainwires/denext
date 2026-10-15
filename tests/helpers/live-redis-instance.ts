// One Live "replica" for tests/redis-pubsub-integration.test.ts: a Live hub on a free port whose
// channel transport is Redis pub/sub, a public channel `it:chat`, and `GET /publish?key=&text=`
// to publish on it from this instance. Prints `{"port": N}` once it is serving.
//
//   deno run -A tests/helpers/live-redis-instance.ts <redis-url> <pubsub-channel>

import { handleLiveUpgrade, installLiveHub } from "../../src/server/live.ts";
import { createChannel, setChannelTransport } from "../../src/runtime/channel.ts";
import { redisChannelTransport } from "../../src/server/redis-pubsub.ts";

const [url, channel] = Deno.args;
const transport = redisChannelTransport({ url, channel });
setChannelTransport(transport);
await transport.ready();
const chat = createChannel<{ text: string }>({ id: "it:chat", authorize: () => true });
installLiveHub({
  appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
  originAllowed: () => true,
  config: { allowAnonymous: true },
});
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/_denext/live") return handleLiveUpgrade(req);
  if (u.pathname === "/publish") {
    await chat.publish(u.searchParams.get("key")!, { text: u.searchParams.get("text")! });
    return new Response("ok");
  }
  return new Response("not found", { status: 404 });
});
console.log(JSON.stringify({ port: (server.addr as Deno.NetAddr).port }));
