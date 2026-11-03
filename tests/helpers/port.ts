// A loopback port for a server a test starts, without the free-port race.
//
// "Bind port 0, read the port, close, let the server bind it later" leaves a window in which
// another process (a parallel test file's server, the OS handing the port out again) takes the
// port: the server then fails to bind, or a test talks to the wrong server. `deno test --parallel`
// starts dozens of servers at once, so it happens, and a readiness poll on the picked port can then
// get its 200 from the other test's server. So a denext server a test starts binds `--port 0` and
// the test reads the port the server printed ({@linkcode boundPort}): nothing is picked, so
// nothing can be taken. {@linkcode onFreePort} is for an API that must be handed a port number (a
// fixed `loopbackPort`): when the start fails because the port was taken, it tries again on a
// fresh one.

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
function addrInUse(err: unknown): boolean {
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

/**
 * What a denext server prints once it listens, on one line: `denext listening on http://…:<port>`
 * (a server started through the API, a compiled binary's), `denext start ▸ http://…:<port>`,
 * `denext dev  ▸  http://…:<port>` or `denext dev (SPA)  ▸  http://…:<port>`. Only the `denext`
 * word and the URL are matched: a Windows console pipe mangles the `▸`.
 */
const LISTENING = /\bdenext\b[^\n]*?\bhttps?:\/\/(?:\[[^\]\s]+\]|[^\s:/]+):(\d+)/;

/**
 * The port a denext server says it bound, from its output so far.
 *
 * @param output What the server printed (stdout and stderr).
 * @returns The port, or `undefined` while the server has not said yet.
 */
export function listenedPort(output: string): number | undefined {
  const port = LISTENING.exec(output)?.[1];
  return port === undefined ? undefined : Number(port);
}

/**
 * Wait for the port a server started with `--port 0` bound ({@linkcode listenedPort}), so a test
 * never picks one for it (see the module comment).
 *
 * @param output What the server printed so far (or, from a reader that keeps only a tail, the
 *   port it already saw).
 * @param exited Whether the server has exited (then it never will say).
 * @param timeoutMs How long a loaded machine may take to bring the server up.
 * @returns The port, or `undefined` when the server exited or `timeoutMs` passed first.
 */
export async function boundPort(
  output: () => string | number | undefined,
  exited: () => boolean,
  timeoutMs = 300_000,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = output();
    const port = typeof seen === "string" ? listenedPort(seen) : seen;
    if (port !== undefined || exited() || Date.now() > deadline) return port;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Poll `url` until it answers 200 (a server coming up on a loaded machine), while the server runs.
 *
 * @param url What to fetch.
 * @param exited Whether the server has exited (then it never will answer).
 * @param attempts How many tries, 100 ms apart.
 * @returns The 200 response (its body unread), or `undefined` when none came.
 */
export async function untilServes(
  url: string,
  exited: () => boolean,
  attempts = 1200,
): Promise<Response | undefined> {
  for (let i = 0; i < attempts && !exited(); i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
      await res.body?.cancel();
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}
