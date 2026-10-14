// An in-process SMTP server for smtpMailer's tests: plain SMTP with STARTTLS (the upgrade is a
// byte pipe from the accepted socket into a local `Deno.listenTls` listener, which then carries
// the secured session), implicit TLS, or plaintext only; AUTH PLAIN / LOGIN; and the
// misbehaviours a client must survive — a server that never answers, one that offers no
// STARTTLS, and one that injects a reply into the plaintext phase right after `220` to
// STARTTLS. Every received message is recorded with its envelope, its un-stuffed DATA, and the
// transcript of the session it came from (which commands arrived, and whether over TLS).

const DIR = new URL("../fixtures/smtp/", import.meta.url);

/** The test CA (PEM) the fake server's `localhost` certificate chains to. */
export const SMTP_TEST_CA = Deno.readTextFileSync(new URL("ca.crt", DIR));
const CERT = Deno.readTextFileSync(new URL("localhost.crt", DIR));
const KEY = Deno.readTextFileSync(new URL("localhost.key", DIR));

/** How the fake behaves. */
export interface FakeSmtpOptions {
  /** `starttls` (default), `implicit` (SMTPS) or `none` (plaintext, no STARTTLS offered). */
  tls?: "starttls" | "implicit" | "none";
  /** The AUTH mechanisms advertised once secured. Default `["PLAIN", "LOGIN"]`. */
  auth?: string[];
  /** The account AUTH accepts. Default `user` / `secret`. */
  user?: string;
  /** Its password. */
  pass?: string;
  /** Never send the greeting (a server that hangs). */
  silent?: boolean;
  /** Never answer the end of DATA (a server that hangs mid-transaction). */
  stallData?: boolean;
  /** Extra bytes sent right after the `220` to STARTTLS, in plaintext (an injection). */
  injectAfterStartTls?: string;
}

/** One received message. */
export interface ReceivedMail {
  /** `MAIL FROM` address. */
  from: string;
  /** `RCPT TO` addresses. */
  to: string[];
  /** The DATA, dot-stuffing removed, CRLF line endings. */
  data: string;
  /** The session's commands, each prefixed `tls:` or `plain:`. */
  transcript: string[];
  /** The user AUTH accepted, if any. */
  authedAs?: string;
}

/** A running fake. */
export interface FakeSmtpServer {
  /** The port clients connect to. */
  port: number;
  /** Messages accepted so far. */
  mail: ReceivedMail[];
  /** Every session's transcript, accepted or not. */
  sessions: string[][];
  /** Stop listening and close every connection. */
  close(): Promise<void>;
}

/** Line reader over a connection that can be abandoned (handed to a pipe). */
class Lines {
  #buffer = "";
  constructor(private conn: Deno.Conn) {}

  async next(): Promise<string | null> {
    for (;;) {
      const end = this.#buffer.indexOf("\r\n");
      if (end >= 0) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        return line;
      }
      const chunk = new Uint8Array(8192);
      const n = await this.conn.read(chunk).catch(() => null);
      if (n === null) return null;
      this.#buffer += new TextDecoder().decode(chunk.subarray(0, n));
    }
  }
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // already closed
  }
}

function decode64(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
}

/** What a session shares with its server. */
interface Server {
  options: FakeSmtpOptions;
  mode: "starttls" | "implicit" | "none";
  mail: ReceivedMail[];
  conns: Set<Deno.Conn>;
  track(p: Promise<unknown>): void;
  /** STARTTLS hand-overs: the next accepted TLS connection continues this transcript. */
  pendingUpgrades: string[][];
  tlsPort(): number;
}

/** Whether the session goes on after a command. */
type Next = "more" | "end";

/** One SMTP session on one connection; each verb is a method. */
class Session {
  private lines: Lines;
  private from = "";
  private to: string[] = [];
  private authedAs: string | undefined;

  constructor(
    private server: Server,
    private conn: Deno.Conn,
    private secured: boolean,
    private transcript: string[],
  ) {
    server.conns.add(conn);
    this.lines = new Lines(conn);
  }

  private write(text: string): Promise<number> {
    return this.conn.write(new TextEncoder().encode(text)).catch(() => 0);
  }

  private log(line: string): void {
    this.transcript.push((this.secured ? "tls:" : "plain:") + line);
  }

  async run(greet: boolean): Promise<void> {
    if (greet && this.server.options.silent) {
      await this.lines.next(); // hold the socket open, say nothing
      return;
    }
    if (greet) await this.write("220 fake.test ESMTP ready\r\n");
    for (;;) {
      const line = await this.lines.next();
      if (line === null) return;
      this.log(line.replace(/^(AUTH PLAIN) .*/i, "$1 <redacted>"));
      if ((await this.dispatch(line)) === "end") return;
    }
  }

  private dispatch(line: string): Promise<Next> {
    const verb = line.split(" ")[0].toUpperCase();
    const handlers: Record<string, (line: string) => Promise<Next>> = {
      EHLO: () => this.ehlo(),
      STARTTLS: () => this.startTls(),
      AUTH: (l) => this.auth(l),
      MAIL: (l) => this.envelope(l, true),
      RCPT: (l) => this.envelope(l, false),
      DATA: () => this.data(),
      QUIT: async () => (await this.write("221 bye\r\n"), "end"),
    };
    const handler = handlers[verb];
    return handler ? handler(line) : this.reply("502 unknown");
  }

  private async reply(text: string): Promise<Next> {
    await this.write(`${text}\r\n`);
    return "more";
  }

  private ehlo(): Promise<Next> {
    const { mode, options } = this.server;
    const ext = ["250-fake.test"];
    if (!this.secured && mode === "starttls") ext.push("250-STARTTLS");
    if (this.secured || mode === "none") {
      ext.push(`250-AUTH ${(options.auth ?? ["PLAIN", "LOGIN"]).join(" ")}`);
    }
    ext.push("250 8BITMIME");
    return this.reply(ext.join("\r\n"));
  }

  /** Answer `220`, then pipe the raw socket into the TLS listener, which carries the session. */
  private async startTls(): Promise<Next> {
    if (this.secured || this.server.mode !== "starttls") return this.reply("502 unknown");
    this.server.pendingUpgrades.push(this.transcript);
    await this.write("220 go ahead\r\n" + (this.server.options.injectAfterStartTls ?? ""));
    const inner = await Deno.connect({ hostname: "127.0.0.1", port: this.server.tlsPort() });
    this.server.conns.add(inner);
    this.server.track(this.conn.readable.pipeTo(inner.writable).catch(() => {}));
    this.server.track(inner.readable.pipeTo(this.conn.writable).catch(() => {}));
    return "end";
  }

  private async auth(line: string): Promise<Next> {
    const [, mech, initial] = line.split(" ");
    const kind = mech?.toUpperCase();
    if (kind === "PLAIN") {
      const [, u, p] = decode64(initial ?? "").split("\0");
      return this.authResult(u, p);
    }
    if (kind !== "LOGIN") return this.reply("504 unsupported");
    await this.write("334 VXNlcm5hbWU6\r\n");
    const u = decode64((await this.lines.next()) ?? "");
    this.log("<login user>");
    await this.write("334 UGFzc3dvcmQ6\r\n");
    const p = decode64((await this.lines.next()) ?? "");
    this.log("<login pass>");
    return this.authResult(u, p);
  }

  private authResult(user: string, pass: string): Promise<Next> {
    const { options } = this.server;
    if (user !== (options.user ?? "user") || pass !== (options.pass ?? "secret")) {
      return this.reply("535 bad credentials");
    }
    this.authedAs = user;
    return this.reply("235 ok");
  }

  private envelope(line: string, mailFrom: boolean): Promise<Next> {
    const address = /<(.*)>/.exec(line)?.[1] ?? "";
    if (mailFrom) [this.from, this.to] = [address, []];
    else this.to.push(address);
    return this.reply("250 ok");
  }

  private async data(): Promise<Next> {
    await this.write("354 go\r\n");
    const body: string[] = [];
    for (let line = await this.lines.next(); line !== "."; line = await this.lines.next()) {
      if (line === null) return "end";
      body.push(line.startsWith(".") ? line.slice(1) : line);
    }
    if (this.server.options.stallData) {
      await this.lines.next();
      return "end";
    }
    const { from, to, transcript, authedAs } = this;
    this.server.mail.push({ from, to, data: body.join("\r\n"), transcript, authedAs });
    return this.reply("250 queued");
  }
}

/**
 * Start a fake SMTP server on 127.0.0.1.
 *
 * @param options How it behaves.
 * @returns The running server.
 */
export function startFakeSmtp(options: FakeSmtpOptions = {}): FakeSmtpServer {
  const mode = options.tls ?? "starttls";
  const mail: ReceivedMail[] = [];
  const sessions: string[][] = [];
  const tasks = new Set<Promise<unknown>>();
  const tlsListener = mode === "none"
    ? null
    : Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert: CERT, key: KEY });
  const plainListener = mode === "implicit"
    ? null
    : Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const server: Server = {
    options,
    mode,
    mail,
    conns: new Set(),
    pendingUpgrades: [],
    track(p) {
      tasks.add(p);
      p.finally(() => tasks.delete(p));
    },
    tlsPort: () => tlsListener!.addr.port,
  };

  async function acceptTls(conn: Deno.TlsConn): Promise<void> {
    const upgraded = mode === "starttls" ? server.pendingUpgrades.shift() : undefined;
    const transcript = upgraded ?? [];
    if (!upgraded) sessions.push(transcript);
    await conn.handshake().catch(() => {});
    await new Session(server, conn, true, transcript).run(!upgraded);
  }

  if (tlsListener) {
    server.track(
      (async () => {
        for await (const conn of tlsListener) {
          server.track(acceptTls(conn).catch(() => {}).finally(() => closeQuietly(conn)));
        }
      })().catch(() => {}),
    );
  }
  if (plainListener) {
    server.track(
      (async () => {
        for await (const conn of plainListener) {
          const transcript: string[] = [];
          sessions.push(transcript);
          server.track(new Session(server, conn, false, transcript).run(true).catch(() => {}));
        }
      })().catch(() => {}),
    );
  }

  const listener = (plainListener ?? tlsListener)!;
  return {
    port: (listener.addr as Deno.NetAddr).port,
    mail,
    sessions,
    async close() {
      plainListener?.close();
      tlsListener?.close();
      for (const conn of server.conns) closeQuietly(conn);
      await Promise.allSettled([...tasks]);
    },
  };
}
