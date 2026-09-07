// @denext/graphql: the Yoga mount through the plugin request-handler seam, channel-backed
// subscriptions (`fromChannel` over `tapChannel`), the build step, and the CLI verb.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import type { CommandContext } from "../src/cli/command.ts";
import {
  applyPlugins,
  getPluginCommands,
  getPluginRequestHandler,
  resetPlugins,
  runPluginBuildSteps,
} from "../src/plugin/mod.ts";
import {
  createChannel,
  inMemoryChannelTransport,
  setChannelTransport,
} from "../src/runtime/channel.ts";
import {
  createGraphqlCommand,
  createSchema,
  diffSdl,
  fromChannel,
  graphql,
  schemaSdl,
} from "../packages/graphql/mod.ts";

const noopLoad = (() => Promise.resolve({})) as unknown as ModuleLoader;

const events = createChannel<{ text: string }>({ id: "gql:messages", authorize: () => true });

/** Resolved when a subscription resolver has attached its channel tap. */
let attached = Promise.withResolvers<void>();

const schema = createSchema<{ viewer?: string }>({
  typeDefs: `
    type Query { hello: String!, viewer: String }
    type Mutation { post(room: String!, text: String!): Boolean! }
    type Message { text: String! }
    type Subscription { messages(room: String!): Message! }
  `,
  resolvers: {
    Query: { hello: () => "world", viewer: (_r, _a, ctx) => ctx.viewer ?? null },
    Mutation: {
      post: async (_r, { room, text }: { room: string; text: string }) => {
        await events.publish(room, { text });
        return true;
      },
    },
    Subscription: {
      messages: {
        subscribe: (_r, { room }: { room: string }) => {
          const it = fromChannel(events, room);
          attached.resolve();
          return it;
        },
        resolve: (payload: { text: string }) => payload,
      },
    },
  },
});

async function setup(
  options: Partial<Parameters<typeof graphql>[0]> = {},
  config: Partial<DenextConfig> = {},
  mode: "dev" | "prod" = "prod",
) {
  resetPlugins();
  setChannelTransport(inMemoryChannelTransport());
  await applyPlugins({
    projectRoot: "/tmp/proj",
    appDir: "/tmp/proj/app",
    config: { plugins: [graphql({ schema, ...options })], ...config } as DenextConfig,
    mode,
    load: noopLoad,
  });
  return getPluginRequestHandler()!;
}

const post = (
  url: string,
  query: string,
  variables?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });

Deno.test("graphql plugin: mounts Yoga at /graphql, passes unrelated paths, honors basePath + path", async () => {
  try {
    const handle = await setup();
    const res = await handle(post("https://x/graphql", "{ hello }"));
    assert(res, "the endpoint is claimed");
    assertEquals(res!.status, 200);
    assertEquals(await res!.json(), { data: { hello: "world" } });
    assertEquals(await handle(new Request("https://x/graphql/other")), null);
    assertEquals(await handle(new Request("https://x/api/x")), null);
  } finally {
    resetPlugins();
  }
  try {
    const handle = await setup({ path: "/gql" }, { basePath: "/app" });
    assertEquals(await handle(post("https://x/gql", "{ hello }")), null);
    const res = await handle(post("https://x/app/gql", "{ hello }"));
    assertEquals(await res!.json(), { data: { hello: "world" } });
  } finally {
    resetPlugins();
  }
});

Deno.test("graphql plugin: GraphiQL only in dev by default; the context factory sees the request", async () => {
  try {
    const dev = await setup({}, {}, "dev");
    const ui = await dev(new Request("https://x/graphql", { headers: { accept: "text/html" } }));
    assertEquals(ui!.status, 200);
    assertStringIncludes(await ui!.text(), "GraphiQL");
  } finally {
    resetPlugins();
  }
  try {
    const prod = await setup({
      context: ({ request }) => ({ viewer: request.headers.get("x-viewer") }),
    });
    const ui = await prod(new Request("https://x/graphql", { headers: { accept: "text/html" } }));
    assert(ui!.status !== 200 || !(await ui!.text()).includes("GraphiQL"), "no GraphiQL in prod");
    const res = await prod(
      post("https://x/graphql", "{ viewer }", undefined, { "x-viewer": "ada" }),
    );
    assertEquals(await res!.json(), { data: { viewer: "ada" } });
    // A mutation over GET is refused by Yoga (CSRF posture), a query over GET is fine.
    const getMutation = await prod(
      new Request(
        "https://x/graphql?query=" + encodeURIComponent('mutation { post(room:"r", text:"t") }'),
      ),
    );
    assertEquals(getMutation!.status, 405);
  } finally {
    resetPlugins();
  }
});

/** Read a Yoga SSE body until `count` `next` events arrived (frames may arrive line by line). */
async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  seed = "",
): Promise<unknown[]> {
  const decoder = new TextDecoder();
  let buf = seed;
  const out: unknown[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.match(/^data: (.*)$/m);
      if (frame.includes("event: next") && data) out.push(JSON.parse(data[1]));
    }
  }
  return out;
}

Deno.test("graphql plugin: a subscription rides a denext channel (publish → SSE next events)", async () => {
  try {
    const handle = await setup();
    attached = Promise.withResolvers<void>();
    const res = await handle(
      post("https://x/graphql", 'subscription { messages(room: "lobby") { text } }', undefined, {
        accept: "text/event-stream",
      }),
    );
    assertEquals(res!.status, 200);
    assertStringIncludes(res!.headers.get("content-type") ?? "", "text/event-stream");
    // Yoga starts executing when the body is pulled: read the keep-alive ping, wait for the
    // resolver to attach, then publish through the channel (as a mutation would).
    const reader = res!.body!.getReader();
    const first = await reader.read();
    await attached.promise;
    await events.publish("lobby", { text: "hi" });
    await events.publish("other", { text: "not for lobby" });
    await events.publish("lobby", { text: "there" });
    const got = await readEvents(reader, 2, new TextDecoder().decode(first.value));
    assertEquals(got, [
      { data: { messages: { text: "hi" } } },
      { data: { messages: { text: "there" } } },
    ]);
    await reader.cancel();
  } finally {
    resetPlugins();
  }
});

Deno.test("fromChannel: buffers while the consumer is slow (oldest dropped past the cap), ends on revoke, abort and return", async () => {
  setChannelTransport(inMemoryChannelTransport());
  const ch = createChannel<number>({ id: "gql:nums", authorize: () => true });
  const it = fromChannel(ch, "k", { buffer: 2 });
  for (const n of [1, 2, 3]) await ch.publish("k", n);
  assertEquals(await it.next(), { value: 2, done: false }, "1 was dropped (cap 2)");
  assertEquals(await it.next(), { value: 3, done: false });
  const pending = it.next();
  ch.revoke("k");
  assertEquals(await pending, { value: undefined, done: true });

  const ac = new AbortController();
  const aborted = fromChannel(ch, "k", { signal: ac.signal });
  const waiting = aborted.next();
  ac.abort();
  assertEquals(await waiting, { value: undefined, done: true });

  const returned = fromChannel(ch, "k");
  assertEquals(await returned.return!(), { value: undefined, done: true });
  await ch.publish("k", 9);
  assertEquals(await returned.next(), { value: undefined, done: true }, "nothing after return()");
});

Deno.test("graphql plugin: build step writes schema.graphql; the verb is contributed", async () => {
  const outDir = await Deno.makeTempDir({ prefix: "denext_graphql_" });
  try {
    await setup();
    assertEquals(getPluginCommands().map((c) => c.name), ["graphql"]);
    await runPluginBuildSteps({
      projectRoot: "/tmp/proj",
      appDir: "/tmp/proj/app",
      outDir,
      config: {} as DenextConfig,
    });
    const sdl = await Deno.readTextFile(join(outDir, "schema.graphql"));
    assertStringIncludes(sdl, "type Subscription {");
    assertEquals(sdl, schemaSdl(schema));
  } finally {
    resetPlugins();
    await Deno.remove(outDir, { recursive: true });
  }
});

function fakeIo(files: Record<string, string> = {}) {
  const out: string[] = [];
  let exitCode: number | null = null;
  const io = {
    log: (l: string) => out.push(l),
    error: (l: string) => out.push("! " + l),
    readFile: (p: string) =>
      p in files ? Promise.resolve(files[p]) : Promise.reject(new Error("ENOENT")),
    writeFile: (p: string, t: string) => {
      files[p] = t;
      return Promise.resolve();
    },
    exit: (c: number) => {
      exitCode = c;
    },
  };
  return { io, out, files, exit: () => exitCode };
}

const ctx = (positionals: string[], flags: Record<string, string | boolean> = {}): CommandContext =>
  ({ positionals, flags, global: {}, rest: [] }) as unknown as CommandContext;

Deno.test("denext graphql: sdl (stdout / --out) and diff", async () => {
  const getSchema = () => Promise.resolve(schema);
  const printed = fakeIo();
  await createGraphqlCommand(getSchema, printed.io).run(ctx([]));
  assertStringIncludes(printed.out[0], "type Mutation {");
  assert(
    printed.out[0].indexOf("type Message") < printed.out[0].indexOf("type Mutation"),
    "sorted SDL",
  );

  const written = fakeIo();
  await createGraphqlCommand(getSchema, written.io).run(ctx(["sdl"], { out: "schema.graphql" }));
  assertStringIncludes(written.out[0], "Wrote schema.graphql");
  assertEquals(written.files["schema.graphql"], schemaSdl(schema));

  const same = fakeIo({ "schema.graphql": schemaSdl(schema) });
  await createGraphqlCommand(getSchema, same.io).run(ctx(["diff", "schema.graphql"]));
  assertEquals([same.out[0], same.exit()], ["graphql: schema.graphql is up to date", null]);

  const stale = fakeIo({
    "schema.graphql": schemaSdl(schema).replace("hello: String!", "hi: String!"),
  });
  await createGraphqlCommand(getSchema, stale.io).run(ctx(["diff", "schema.graphql"]));
  assertEquals(stale.out.slice(0, 2), ["-   hi: String!", "+   hello: String!"]);
  assertEquals(stale.exit(), 1);
  assertEquals(diffSdl("a\nb\n", "a\nb\n"), []);

  let threw = "";
  try {
    await createGraphqlCommand(getSchema, fakeIo().io).run(ctx(["nope"]));
  } catch (e) {
    threw = (e as Error).message;
  }
  assertEquals(threw, "unknown graphql action: nope");
});
