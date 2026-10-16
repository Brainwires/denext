// One Live "replica" for tests/redis-pubsub-integration.test.ts: a Live hub on a free port whose
// channel transport is Redis pub/sub, a public channel `it:chat`, and `GET /publish?key=&text=`
// to publish on it from this instance. Prints `{"port": N}` once it is serving.
//
//   deno run -A tests/helpers/live-redis-instance.ts <redis-url> <pubsub-channel>

import { installLiveHub } from "../../src/server/live.ts";
import { serveLiveReplica } from "./live-replica-server.ts";
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
serveLiveReplica(async (u) => {
  if (u.pathname !== "/publish") return null;
  await chat.publish(u.searchParams.get("key")!, { text: u.searchParams.get("text")! });
  return new Response("ok");
});
