// The GraphQL connection a resolver runs for — internal (not an export of the package). The
// WebSocket transport runs each operation inside `withPeer(id, …)`, so every `fromChannel` of one
// socket subscribes as the same peer: `authorize` sees one `ctx.peerId` per connection and a
// `channel.revoke(key, { peerId })` ends that connection's subscriptions, as on the Live socket.
// Over SSE each request is its own peer.

import { AsyncLocalStorage } from "node:async_hooks";

const peers = new AsyncLocalStorage<string>();

/** Run `fn` as the connection `peerId`. */
export function withPeer<T>(peerId: string, fn: () => T): T {
  return peers.run(peerId, fn);
}

/** The current connection's peer id, if a transport set one. */
export function currentPeer(): string | undefined {
  return peers.getStore();
}
