// Registries a compat build splits: its prebuilt runtime graph (`denext`, `denext/live`, the React
// compat modules, …) loads its own copy of denext's runtime modules beside the server's, so the
// app registers into one copy while the server reads the other. Each registry below is shared by
// every copy in the process (src/runtime/process-shared.ts). Every test loads a second copy of
// the module (the same file under another URL, as the compat graph does), writes through one and
// reads through the other.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { processShared } from "../src/runtime/process-shared.ts";
import * as liveView from "../src/runtime/live-view.ts";
import * as actions from "../src/runtime/server-action.ts";
import * as channels from "../src/runtime/channel.ts";
import * as taint from "../src/runtime/taint.ts";
import * as clientRefs from "../src/runtime/client-reference.ts";

/** A second copy of a runtime module: the same file under another URL. */
async function secondCopy<T>(path: string): Promise<T> {
  return await import(new URL(`${path}?copy=${crypto.randomUUID()}`, import.meta.url).href);
}

const unique = (name: string) => `${name}-${crypto.randomUUID()}`;

Deno.test("processShared: one value per name for the whole process", () => {
  const name = unique("probe");
  const first = processShared(name, () => ({ n: 1 }));
  assertEquals(processShared(name, () => ({ n: 2 })), first, "created once");
  assert(processShared(unique("probe"), () => ({ n: 3 })) !== first, "per name");
});

Deno.test("defineLiveView: a view defined in one copy mounts through another", async () => {
  const copy = await secondCopy<typeof liveView>("../src/runtime/live-view.ts");
  const id = unique("counter");
  liveView.defineLiveView({
    id,
    init: () => [0],
    update: (_msg: { type: "inc" }, n: number) => [n + 1],
    view: (n: number) => h("p", null, String(n)),
  });
  assert(copy.getLiveView(id), "the other copy finds the view");
  const token = await liveView.signLiveViewToken(id, "{}");
  assert(await copy.verifyLiveViewToken(id, "{}", token), "and verifies its token");
});

Deno.test("server actions: registered in one copy, dispatched from another", async () => {
  const copy = await secondCopy<typeof actions>("../src/runtime/server-action.ts");
  const id = unique("save");
  actions.serverAction(id, (n: number) => n * 2);
  assertEquals(await copy.getServerAction(id)?.(21), 42, "the handler");
  actions.liveReadable({ denextActionId: id });
  assert(copy.isLiveReadable(id), "liveReadable");
  const sub = unique("sub");
  actions.registerSubscription(sub, {} as never);
  assert(copy.getSubscriptionDef(sub), "a subscription definition");
  // The bind decorator the server installs reaches references made in either copy.
  const seen: string[] = [];
  copy.setServerReferenceDecorator((_fn, refId) => seen.push(refId));
  const bound = unique("bound");
  actions.registerServerReference(bound, () => 1);
  actions.setServerReferenceDecorator(null as never);
  assertEquals(seen, [bound]);
});

Deno.test("channels: created in one copy, found through another; one transport and settings", async () => {
  const copy = await secondCopy<typeof channels>("../src/runtime/channel.ts");
  const id = unique("orders");
  channels.createChannel<{ status: string }>({ id, authorize: () => true });
  assert(copy.getChannel(id), "the registry");
  assertEquals(copy.channelInstanceId(), channels.channelInstanceId(), "one instance id");
  const transport = channels.inMemoryChannelTransport();
  try {
    // The server installs a transport through one copy; the other publishes through it.
    copy.setChannelTransport(transport);
    assertEquals(channels.watchChannelTransport(() => {}).current, transport);
    assertEquals(channels.channelAuthTtlMs(unique("none")), 300_000);
    copy.setChannelAuthTtl(60);
    assertEquals(channels.channelAuthTtlMs(unique("none")), 60_000);
  } finally {
    channels.resetChannels();
  }
  assertEquals(copy.channelAuthTtlMs(unique("none")), 300_000, "reset reaches both");
  assert(copy.watchChannelTransport(() => {}).current !== transport, "and the transport");
});

Deno.test("taint: a value tainted in one copy is refused by another's serializer check", async () => {
  const copy = await secondCopy<typeof taint>("../src/runtime/taint.ts");
  const secret = unique("sk_live");
  taint.experimental_taintUniqueValue("do not send", {}, secret);
  assertEquals(copy.taintMessageFor(secret), "do not send");
  const user = { password: "x" };
  taint.experimental_taintObjectReference("not the user", user);
  assertEquals(copy.taintMessageFor(user), "not the user");
});

Deno.test("client references: a module tagged in one copy is not imported again by another", async () => {
  const copy = await secondCopy<typeof clientRefs>("../src/runtime/client-reference.ts");
  const id = unique("client");
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve({ Button: () => null });
  };
  await clientRefs.tagClientModules([[id, { url: "file:///x.tsx" }]], load);
  await copy.tagClientModules([[id, { url: "file:///x.tsx" }]], load);
  assertEquals(loads, 1);
  copy.forgetTaggedClients();
  await clientRefs.tagClientModules([[id, { url: "file:///x.tsx" }]], load);
  assertEquals(loads, 2, "forgetting in one copy forgets in both");
});
