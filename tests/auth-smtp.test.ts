// `smtpMailer()` against an in-process SMTP server (tests/helpers/fake-smtp.ts): STARTTLS is
// required and must succeed (AUTH and the envelope only ever travel over TLS), implicit TLS on
// `secure`, plaintext only with `insecure: true` to loopback, AUTH PLAIN and LOGIN, a reply
// injected before the TLS handshake, an untrusted certificate, header injection through every
// header value, address validation, RFC 2047 subjects, dot-stuffing, one connection per
// message, and the step timeouts.

import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import {
  type MailMessage,
  SmtpError,
  smtpMailer,
  type SmtpMailerOptions,
  SmtpMessageError,
} from "../src/server/auth/smtp.ts";
import { dotStuff, encodeHeaderText, quotedPrintable } from "../src/server/auth/smtp-message.ts";
import { type FakeSmtpServer, SMTP_TEST_CA, startFakeSmtp } from "./helpers/fake-smtp.ts";

/** A mailer for `server`, trusting the test CA. */
function mailerFor(server: FakeSmtpServer, options: Partial<SmtpMailerOptions> = {}) {
  return smtpMailer({
    host: "localhost",
    port: server.port,
    user: "user",
    pass: "secret",
    from: "Example App <noreply@example.test>",
    caCerts: [SMTP_TEST_CA],
    timeoutMs: 5_000,
    ...options,
  });
}

/** Run `fn` against a fresh fake server, always closing it. */
async function withServer(
  options: Parameters<typeof startFakeSmtp>[0],
  fn: (server: FakeSmtpServer) => Promise<void>,
): Promise<void> {
  const server = startFakeSmtp(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

const MESSAGE: MailMessage = {
  to: "ada@example.test",
  subject: "Hello",
  text: "Hi Ada",
};

/** The header block of a received message, unfolded. */
function headers(data: string): Map<string, string> {
  const block = data.slice(0, data.indexOf("\r\n\r\n")).replace(/\r\n[ \t]/g, " ");
  return new Map(
    block.split("\r\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
}

/** Decode a quoted-printable body. */
function qpDecode(body: string): string {
  const joined = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=") {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The decoded text body of a single-part message. */
function bodyOf(data: string): string {
  return qpDecode(data.slice(data.indexOf("\r\n\r\n") + 4));
}

/** Decode RFC 2047 `B` words. */
function decodeWords(value: string): string {
  return value.replace(
    /\s*=\?UTF-8\?B\?([^?]*)\?=/g,
    (_, b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
  );
}

// ---- TLS policy ------------------------------------------------------------------------------

Deno.test("smtp: STARTTLS, then AUTH PLAIN and the envelope over TLS only", async () => {
  await withServer({}, async (server) => {
    await mailerFor(server).send(MESSAGE);
    assertEquals(server.mail.length, 1);
    const [mail] = server.mail;
    assertEquals([mail.from, mail.to, mail.authedAs], ["noreply@example.test", [
      "ada@example.test",
    ], "user"]);
    const plain = mail.transcript.filter((line) => line.startsWith("plain:"));
    assertEquals(plain, ["plain:EHLO localhost", "plain:STARTTLS"], "nothing else before TLS");
    assert(mail.transcript.includes("tls:AUTH PLAIN <redacted>"));
    assert(mail.transcript.includes("tls:QUIT"));
    const h = headers(mail.data);
    assertEquals(h.get("from"), '"Example App" <noreply@example.test>');
    assertEquals(h.get("to"), "ada@example.test");
    assertEquals(h.get("mime-version"), "1.0");
    assertMatch(h.get("message-id") ?? "", /^<[0-9a-f]{32}@example\.test>$/);
    assertEquals(bodyOf(mail.data), "Hi Ada");
  });
});

Deno.test("smtp: AUTH LOGIN when the server offers only LOGIN", async () => {
  await withServer({ auth: ["LOGIN"] }, async (server) => {
    await mailerFor(server).send(MESSAGE);
    assertEquals(server.mail[0].authedAs, "user");
    assert(server.mail[0].transcript.includes("tls:AUTH LOGIN"));
  });
});

Deno.test("smtp: wrong credentials are refused with the server's code, and nothing is sent", async () => {
  await withServer({}, async (server) => {
    const error = await assertRejects(
      () => mailerFor(server, { pass: "wrong" }).send(MESSAGE),
      SmtpError,
      "AUTH PLAIN was refused (535)",
    );
    assertEquals(error.code, 535);
    assertEquals(server.mail.length, 0);
  });
});

Deno.test("smtp: no AUTH mechanism the client speaks is refused before the envelope", async () => {
  await withServer({ auth: ["CRAM-MD5"] }, async (server) => {
    await assertRejects(() => mailerFor(server).send(MESSAGE), SmtpError, "neither AUTH");
    assert(!server.sessions[0].some((line) => line.includes("MAIL FROM")));
  });
});

Deno.test("smtp: implicit TLS with `secure: true`", async () => {
  await withServer({ tls: "implicit" }, async (server) => {
    await mailerFor(server, { secure: true }).send(MESSAGE);
    assertEquals(server.mail.length, 1);
    assert(server.mail[0].transcript.every((line) => line.startsWith("tls:")));
  });
});

Deno.test("smtp: a server without STARTTLS gets no credentials and no mail", async () => {
  await withServer({ tls: "none" }, async (server) => {
    await assertRejects(
      () => mailerFor(server).send(MESSAGE),
      SmtpError,
      "does not offer STARTTLS",
    );
    assertEquals(server.mail.length, 0);
    assertEquals(server.sessions[0], ["plain:EHLO localhost"], "no AUTH, no envelope");
  });
});

Deno.test("smtp: a reply injected before the TLS handshake aborts the send", async () => {
  await withServer(
    { injectAfterStartTls: "250-injected\r\n250 AUTH PLAIN\r\n" },
    async (server) => {
      await assertRejects(() => mailerFor(server).send(MESSAGE), SmtpError);
      assertEquals(server.mail.length, 0);
      assert(!server.sessions.flat().some((line) => line.includes("AUTH")));
    },
  );
});

Deno.test("smtp: a certificate that doesn't chain to a trusted CA is refused", async () => {
  await withServer({}, async (server) => {
    await assertRejects(() => mailerFor(server, { caCerts: undefined }).send(MESSAGE));
    assertEquals(server.mail.length, 0);
    assert(!server.sessions.flat().some((line) => line.includes("AUTH")));
  });
});

Deno.test("smtp: plaintext only with `insecure: true`, and only to loopback", async () => {
  await withServer({ tls: "none" }, async (server) => {
    await mailerFor(server, { insecure: true, host: "127.0.0.1" }).send(MESSAGE);
    assertEquals(server.mail.length, 1);
  });
  for (const host of ["smtp.example.test", "10.0.0.1", "localhost.example.test"]) {
    assertThrows(
      () => smtpMailer({ host, insecure: true, from: "a@example.test" }),
      TypeError,
      "loopback",
    );
  }
  assertThrows(
    () => smtpMailer({ host: "localhost", insecure: true, secure: true, from: "a@example.test" }),
    TypeError,
  );
});

// ---- the message -------------------------------------------------------------------------------

Deno.test("smtp: CR/LF in any header value is refused before connecting", async () => {
  await withServer({}, async (server) => {
    const mailer = mailerFor(server);
    const injected: MailMessage[] = [
      { ...MESSAGE, subject: "Hi\r\nBcc: victim@example.test" },
      { ...MESSAGE, subject: "Hi\nBcc: victim@example.test" },
      { ...MESSAGE, to: "ada@example.test\r\nBcc: victim@example.test" },
      { ...MESSAGE, replyTo: "ada@example.test\rX-Evil: 1" },
    ];
    for (const message of injected) {
      await assertRejects(() => mailer.send(message), SmtpMessageError);
    }
    assertEquals(server.sessions.length, 0, "nothing reached the server");
  });
  assertThrows(
    () => smtpMailer({ host: "localhost", from: "App\r\nBcc: x@example.test <a@example.test>" }),
    SmtpMessageError,
  );
  assertThrows(
    () => smtpMailer({ host: "localhost", from: "a@example.test", clientName: "x\r\nRSET" }),
    SmtpMessageError,
  );
});

Deno.test("smtp: addresses are validated — lists, smuggled SMTP arguments, junk", async () => {
  await withServer({}, async (server) => {
    const mailer = mailerFor(server);
    for (
      const to of [
        "ada@example.test, eve@example.test",
        "ada@example.test> NOTIFY=SUCCESS",
        "<ada@example.test>",
        "ada example@example.test",
        "ada@localhost",
        "ada@",
        "@example.test",
        "ädä@example.test",
        `${"a".repeat(65)}@example.test`,
      ]
    ) {
      await assertRejects(() => mailer.send({ ...MESSAGE, to }), SmtpMessageError, undefined, to);
    }
    assertEquals(server.sessions.length, 0);
  });
});

Deno.test("smtp: a non-ASCII subject and sender name are RFC 2047-encoded", async () => {
  await withServer({}, async (server) => {
    const subject = "Grüße — 你好, " + "ü".repeat(40);
    await mailerFor(server, { from: "Bücher Café <noreply@example.test>" })
      .send({ ...MESSAGE, subject });
    const h = headers(server.mail[0].data);
    assertMatch(h.get("subject")!, /^=\?UTF-8\?B\?/);
    assertEquals(decodeWords(h.get("subject")!), subject);
    assertEquals(decodeWords(h.get("from")!), "Bücher Café <noreply@example.test>");
    // Every raw header line stays short enough for any server.
    for (const line of server.mail[0].data.split("\r\n")) assert(line.length <= 998);
  });
});

Deno.test("smtp: dot-stuffing keeps lines that start with a dot inside the message", async () => {
  await withServer({}, async (server) => {
    const text = "first\n.\n.hidden line\n..double\nlast";
    await mailerFor(server).send({ ...MESSAGE, text });
    assertEquals(bodyOf(server.mail[0].data), text.replace(/\n/g, "\r\n"));
  });
  assertEquals(dotStuff(".a\r\nb\r\n.\r\n..c"), "..a\r\nb\r\n..\r\n...c");
});

Deno.test("smtp: an HTML alternative is sent as multipart/alternative", async () => {
  await withServer({}, async (server) => {
    await mailerFor(server).send({ ...MESSAGE, html: "<p>Hi <b>Ada</b></p>" });
    const data = server.mail[0].data;
    assertMatch(headers(data).get("content-type")!, /^multipart\/alternative; boundary="/);
    assert(data.includes("Content-Type: text/plain; charset=utf-8"));
    assert(data.includes("Content-Type: text/html; charset=utf-8"));
  });
});

Deno.test("smtp: quoted-printable lines stay within 76 characters and escape what they must", () => {
  const encoded = quotedPrintable("x".repeat(200) + " \n= tail\t");
  for (const line of encoded.split("\r\n")) assert(line.length <= 76, line);
  assertMatch(encoded, /=3D tail=09$/);
  assertEquals(qpDecode(encoded), "x".repeat(200) + " \r\n= tail\t");
  assertEquals(encodeHeaderText("plain"), "plain");
});

// ---- connections and timeouts --------------------------------------------------------------------

Deno.test("smtp: every message gets its own connection", async () => {
  await withServer({}, async (server) => {
    const mailer = mailerFor(server);
    await mailer.send(MESSAGE);
    await mailer.send({ ...MESSAGE, to: "bob@example.test" });
    assertEquals(server.sessions.length, 2);
    assertEquals(server.mail.map((m) => m.to[0]), ["ada@example.test", "bob@example.test"]);
    assert(server.mail[0].transcript !== server.mail[1].transcript);
  });
});

Deno.test("smtp: a server that never greets times out", async () => {
  await withServer({ silent: true }, async (server) => {
    const started = Date.now();
    await assertRejects(
      () => mailerFor(server, { timeoutMs: 200 }).send(MESSAGE),
      SmtpError,
      "the greeting timed out",
    );
    assert(Date.now() - started < 3_000);
  });
});

Deno.test("smtp: a server that never answers the end of DATA times out", async () => {
  await withServer({ stallData: true }, async (server) => {
    await assertRejects(
      () => mailerFor(server, { timeoutMs: 300 }).send(MESSAGE),
      SmtpError,
      "the message timed out",
    );
    assertEquals(server.mail.length, 0);
  });
});

Deno.test("smtp: an endless multi-line reply is cut off, not buffered", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const served = (async () => {
    const conn = await listener.accept();
    const line = new TextEncoder().encode("220-" + "x".repeat(1000) + "\r\n");
    try {
      for (let i = 0; i < 1000; i++) await conn.write(line);
    } catch {
      // the client hung up
    } finally {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  })();
  try {
    await assertRejects(
      () =>
        smtpMailer({
          host: "127.0.0.1",
          port: (listener.addr as Deno.NetAddr).port,
          from: "a@example.test",
          insecure: true,
        }).send(MESSAGE),
      SmtpError,
      "reply too long",
    );
  } finally {
    listener.close();
    await served;
  }
});

Deno.test("smtp: connecting to a closed port fails without leaking the error text", async () => {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  await assertRejects(
    () =>
      smtpMailer({ host: "127.0.0.1", port, from: "a@example.test", timeoutMs: 2_000 }).send(
        MESSAGE,
      ),
    SmtpError,
    "connecting to the server failed",
  );
});

// ---- as sendVerificationRequest --------------------------------------------------------------------

Deno.test("smtp: as sendVerificationRequest, each purpose gets its subject and the link or code", async () => {
  await withServer({}, async (server) => {
    const mailer = mailerFor(server);
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const url = "https://app.test/auth/callback/email?token=abc&email=ada%40example.test";
    await mailer({
      identifier: "ada@example.test",
      url,
      token: "abc",
      purpose: "magic",
      expiresAt,
    });
    await mailer({
      identifier: "ada@example.test",
      url,
      token: "123456",
      purpose: "otp",
      expiresAt,
    });
    await mailer({ identifier: "ada@example.test", url, token: "t", purpose: "reset", expiresAt });
    await mailer({ identifier: "ada@example.test", url, token: "t", purpose: "email", expiresAt });
    const subjects = server.mail.map((m) => headers(m.data).get("subject"));
    assertEquals(subjects, [
      "Your sign-in link",
      "Your sign-in code",
      "Reset your password",
      "Confirm your email address",
    ]);
    assert(bodyOf(server.mail[0].data).includes(url));
    assert(bodyOf(server.mail[0].data).includes("10 minutes"));
    assert(bodyOf(server.mail[1].data).includes("123456"));
    assert(!bodyOf(server.mail[1].data).includes(url), "a code mail carries no link");
  });
});

Deno.test("smtp: `render` shapes the verification mail", async () => {
  await withServer({}, async (server) => {
    const mailer = mailerFor(server, {
      render: (p) => ({
        subject: `[App] ${p.purpose}`,
        text: p.url,
        html: `<a href="${p.url}">go</a>`,
      }),
    });
    await mailer({
      identifier: "ada@example.test",
      url: "https://app.test/x",
      token: "t",
      purpose: "magic",
      expiresAt: 0,
    });
    assertEquals(headers(server.mail[0].data).get("subject"), "[App] magic");
  });
});

Deno.test("smtp: settings are checked at construction", () => {
  assertThrows(() => smtpMailer({ host: "", from: "a@example.test" }), TypeError);
  assertThrows(() => smtpMailer({ host: "h", port: 0, from: "a@example.test" }), TypeError);
  assertThrows(() => smtpMailer({ host: "h", user: "u", from: "a@example.test" }), TypeError);
  assertThrows(() => smtpMailer({ host: "h", from: "not an address" }), SmtpMessageError);
  assertThrows(() => smtpMailer({ host: "h", from: "a@example.test", timeoutMs: 0 }), TypeError);
});
