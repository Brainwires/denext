// A stand-in download server for the download deadline and retry tests: a raw HTTP/1.1 server
// whose n-th connection goes silent, stalls mid-body, answers, or answers slowly.

/** What a stand-in server does with its n-th connection (from 0). */
export type Behaviour = "silent" | "stall-mid-body" | "answer" | { slow: number };

/**
 * A raw HTTP/1.1 server on 127.0.0.1 whose n-th TCP connection does `behaviour(n)`: reads the
 * request, then never answers (`silent`), sends the headers and part of the body and goes quiet
 * (`stall-mid-body`), answers with `body` at once (`answer`), or sends `body` one byte every
 * `slow` ms. Every connection it accepted is closed by `close()`.
 */
export function standIn(body: Uint8Array, behaviour: (n: number) => Behaviour) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const tasks: Promise<void>[] = [];
  const head = (len: number) =>
    new TextEncoder().encode(
      `HTTP/1.1 200 OK\r\nContent-Length: ${len}\r\nConnection: close\r\n\r\n`,
    );
  const serve = async (conn: Deno.Conn, b: Behaviour) => {
    const buf = new Uint8Array(4096);
    let req = "";
    while (!req.includes("\r\n\r\n")) {
      const n = await conn.read(buf);
      if (n === null) return;
      req += new TextDecoder().decode(buf.subarray(0, n));
    }
    if (b === "silent") return; // holds the connection open, answering nothing
    await conn.write(head(body.byteLength));
    if (b === "stall-mid-body") {
      await conn.write(body.subarray(0, 2));
      return;
    }
    if (b === "answer") {
      await conn.write(body);
    } else {
      for (const byte of body) {
        await conn.write(Uint8Array.of(byte));
        await new Promise((r) => setTimeout(r, b.slow));
      }
    }
    conn.close();
  };
  const accepting = (async () => {
    for await (const conn of listener) {
      conns.push(conn);
      tasks.push(serve(conn, behaviour(conns.length - 1)).catch(() => {}));
    }
  })();
  const { port } = listener.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}/deno.zip`,
    /** The server's origin (it answers any path the same way). */
    origin: `http://127.0.0.1:${port}`,
    /** Connections accepted so far. */
    connections: () => conns.length,
    close: async () => {
      listener.close();
      for (const c of conns) {
        try {
          c.close();
        } catch { /* closed already */ }
      }
      await accepting.catch(() => {});
      await Promise.all(tasks);
    },
  };
}
