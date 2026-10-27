// A loopback port for a server a test starts, without the free-port race.
//
// "Bind port 0, read the port, close, let the server bind it later" leaves a window in which
// another process (a parallel test file's server, the OS handing the port out again) takes the
// port: the server then fails to bind, or a test talks to the wrong server. `deno test --parallel`
// starts dozens of servers at once, so it happens. {@linkcode onFreePort} closes the gap for a
// child that binds the port itself: when the start fails because the port was taken, it tries
// again on a fresh one.

/** A loopback port nothing listened on a moment ago (bound, read, released). */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/**
 * Whether `err` (or its message, which callers fill with the server's output) says the port was
 * already in use: Deno's `AddrInUse`, or an OS message (`EADDRINUSE`, os error 48 on macOS, 98 on
 * Linux, 10048 on Windows).
 *
 * @param err What the start threw.
 */
export function addrInUse(err: unknown): boolean {
  if (err instanceof Deno.errors.AddrInUse) return true;
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /AddrInUse|EADDRINUSE|address already in use|os error (?:48|98|10048)\b|only one usage of each socket address/i
    .test(text);
}

/**
 * `start(port)` on a free loopback port; when it fails because the port was taken meanwhile
 * ({@linkcode addrInUse}, or `retryIf`), again on a fresh port, up to `attempts` times. Any other
 * failure is thrown at once.
 *
 * @param start Starts the server on `port` and resolves once it serves (or throws, with the
 *   server's output in the message, when it does not).
 * @param options `attempts` (default 5) and `retryIf` (default {@linkcode addrInUse}).
 * @returns What `start` returned.
 */
export async function onFreePort<T>(
  start: (port: number) => Promise<T>,
  options: { attempts?: number; retryIf?: (err: unknown) => boolean } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const retryIf = options.retryIf ?? addrInUse;
  for (let attempt = 1;; attempt++) {
    try {
      return await start(freePort());
    } catch (err) {
      if (attempt >= attempts || !retryIf(err)) throw err;
    }
  }
}
