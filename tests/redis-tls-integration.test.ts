// denext's Redis client over TLS (`rediss://`) against a REAL Redis with TLS on, whose server
// certificate is signed by a throwaway CA the test passes through `tls: { caCerts }`: commands and
// the pub/sub Live transport work, and the same server without the CA is refused (the system
// store does not trust it).
//
// Opt-in (not part of CI's backend-integration services: it needs a CA and a server certificate):
//
//   openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=dnx-ca -keyout ca.key -out ca.pem
//   openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout server.key -out server.csr
//   printf "subjectAltName=DNS:localhost,IP:127.0.0.1" > san.ext
//   openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 \
//     -extfile san.ext -out server.pem
//   docker run --rm -d --name dnx-redis-tls -v "$PWD:/tls:ro" -p 127.0.0.1:56392:6380 \
//     redis:7-alpine redis-server --port 0 --tls-port 6380 --tls-cert-file /tls/server.pem \
//     --tls-key-file /tls/server.key --tls-ca-cert-file /tls/ca.pem --tls-auth-clients no
//   DENEXT_TEST_REDIS_TLS_URL=rediss://localhost:56392 DENEXT_TEST_REDIS_TLS_CA=$PWD/ca.pem \
//     deno test -A tests/redis-tls-integration.test.ts

import { assertEquals, assertRejects } from "@std/assert";
import { redisClient, RedisConnectionError } from "../src/server/redis.ts";
import { redisChannelTransport } from "../src/server/redis-pubsub.ts";
import type { ChannelEvent } from "../src/runtime/channel.ts";

const URL_ = Deno.env.get("DENEXT_TEST_REDIS_TLS_URL") || undefined;
const CA = Deno.env.get("DENEXT_TEST_REDIS_TLS_CA") || undefined;
const ignore = !URL_ || !CA;

Deno.test({
  name: "rediss:// with the CA passed as tls.caCerts: commands and pub/sub over TLS",
  ignore,
  async fn() {
    const caCerts = [await Deno.readTextFile(CA!)];
    const client = redisClient({ url: URL_!, tls: { caCerts } });
    const key = `dnx-tls:${crypto.randomUUID().slice(0, 8)}`;
    try {
      assertEquals(await client.command("SET", key, "secure"), "OK");
      assertEquals(await client.command("GET", key), "secure");
      assertEquals(await client.transaction([["INCR", `${key}:n`], ["INCR", `${key}:n`]]), [1, 2]);
    } finally {
      await client.command("DEL", key, `${key}:n`);
      await client.close();
    }
    const channel = `dnx-tls:${crypto.randomUUID().slice(0, 8)}`;
    const a = redisChannelTransport({ url: { url: URL_!, tls: { caCerts } }, channel });
    const b = redisChannelTransport({ url: { url: URL_!, tls: { caCerts } }, channel });
    try {
      await Promise.all([a.ready(), b.ready()]);
      const got = new Promise<ChannelEvent>((resolve) => b.subscribe(resolve));
      await a.publish({ kind: "publish", channelId: "c", key: "k", seq: 1, instance: "x" });
      assertEquals((await got).key, "k");
    } finally {
      await a.close();
      await b.close();
    }
  },
});

Deno.test({
  name: "rediss:// without the CA is refused (the server's certificate is not trusted)",
  ignore,
  async fn() {
    const client = redisClient({ url: URL_!, connectTimeoutMs: 5000 });
    try {
      await assertRejects(() => client.command("PING"), RedisConnectionError);
    } finally {
      await client.close();
    }
  },
});
