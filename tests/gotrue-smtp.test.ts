// `/auth/v1`'s own SMTP delivery: Supabase Auth's `GOTRUE_SMTP_*` settings (read from the
// environment when the options carry none), GoTrue's default and configured subjects, its
// template URLs (placeholders HTML-escaped; an unsupported template falls back), and the
// precedence: `hooks.sendEmail`, then `sendVerificationRequest`, then SMTP.

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import type { GoTrueOptions } from "../packages/auth/src/gotrue/options.ts";
import {
  type GoTrueMailInput,
  goTrueSmtpFromEnv,
  goTrueSmtpSender,
  mailKindOf,
  processGoTrueSmtp,
  renderGoTrueTemplate,
} from "../packages/auth/src/gotrue/smtp-mail.ts";
import { type FakeSmtpServer, SMTP_TEST_CA, startFakeSmtp } from "./helpers/fake-smtp.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

async function signup(app: SupabaseAuthApp, email: string) {
  const res = await app.fetch(`${ORIGIN}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "a long password" }),
  });
  await res.body?.cancel();
  return res.status;
}

/** An app whose `/auth/v1` mails go to `server` (no `sendVerificationRequest`). */
async function withSmtpApp(
  auth: GoTrueOptions,
  fn: (app: SupabaseAuthApp) => Promise<void>,
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth,
    authConfig: { sendVerificationRequest: undefined },
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** SMTP options pointing at the fake server. */
function smtpTo(server: FakeSmtpServer, extra: Partial<NonNullable<GoTrueOptions["smtp"]>> = {}) {
  return {
    host: "localhost",
    port: server.port,
    user: "user",
    pass: "secret",
    from: "Example <admin@example.test>",
    caCerts: [SMTP_TEST_CA],
    ...extra,
  };
}

function subjectOf(data: string): string {
  return /^Subject: (.*)$/m.exec(data)?.[1] ?? "";
}

/** The decoded quoted-printable parts of a message, concatenated. */
function decoded(data: string): string {
  return data.replace(/=\r\n/g, "").replace(
    /=([0-9A-F]{2})/g,
    (_, hex) => String.fromCharCode(parseInt(hex, 16)),
  );
}

const INPUT: GoTrueMailInput = {
  action: "signup",
  to: "ada@example.test",
  confirmationUrl: "https://app.test/auth/v1/verify?token=t&type=signup",
  token: "123456",
  tokenHash: "hash",
  siteUrl: "https://app.test",
  redirectTo: "https://app.test/welcome",
  email: "ada@example.test",
};

Deno.test("gotrue smtp: GOTRUE_SMTP_* and the mailer subject / template settings", () => {
  const env = new Map(Object.entries({
    GOTRUE_SMTP_HOST: "smtp.example.test",
    GOTRUE_SMTP_PORT: "465",
    GOTRUE_SMTP_USER: "apikey",
    GOTRUE_SMTP_PASS: "pw",
    GOTRUE_SMTP_ADMIN_EMAIL: "admin@example.test",
    GOTRUE_SMTP_SENDER_NAME: "Example <App>",
    GOTRUE_MAILER_SUBJECTS_CONFIRMATION: "Welcome!",
    GOTRUE_MAILER_TEMPLATES_RECOVERY: "https://cdn.example.test/recovery.html",
  }));
  assertEquals(goTrueSmtpFromEnv((n) => env.get(n)), {
    host: "smtp.example.test",
    port: 465,
    from: "Example App <admin@example.test>",
    user: "apikey",
    pass: "pw",
    subjects: { confirmation: "Welcome!" },
    templates: { recovery: "https://cdn.example.test/recovery.html" },
  });
  assertEquals(goTrueSmtpFromEnv(() => undefined), undefined);
  assertEquals(goTrueSmtpFromEnv((n) => (n === "GOTRUE_SMTP_HOST" ? "h" : undefined)), undefined);
  assertThrows(
    () =>
      goTrueSmtpFromEnv((n) =>
        ({ GOTRUE_SMTP_HOST: "h", GOTRUE_SMTP_ADMIN_EMAIL: "a@b.test", GOTRUE_SMTP_PORT: "x" })[n]
      ),
    TypeError,
  );
});

Deno.test("gotrue smtp: templates substitute GoTrue's placeholders, HTML-escaped", () => {
  const html = renderGoTrueTemplate(
    '<a href="{{ .ConfirmationURL }}">go</a> {{ .Token }} {{.Email}} {{ .SiteURL }}',
    { ...INPUT, email: '<script>"x"@example.test' },
  );
  assertEquals(
    html,
    '<a href="https://app.test/auth/v1/verify?token=t&amp;type=signup">go</a> 123456 ' +
      "&lt;script&gt;&quot;x&quot;@example.test https://app.test",
  );
  assertEquals(renderGoTrueTemplate("{{ if .Token }}x{{ end }}", INPUT), "x");
  assertEquals(renderGoTrueTemplate("{{ .Data.name }}", INPUT), "");
  // A template Go can't parse falls back (null).
  assertEquals(renderGoTrueTemplate("{{ if .Token }}x", INPUT), null);
  assertEquals(
    ["signup", "invite", "magiclink", "email", "recovery", "email_change", "reauthentication"]
      .map(mailKindOf),
    [
      "confirmation",
      "invite",
      "magic_link",
      "magic_link",
      "recovery",
      "email_change",
      "reauthentication",
    ],
  );
});

Deno.test("gotrue smtp: templates run Go template actions over GoTrue's data", () => {
  const input: GoTrueMailInput = {
    ...INPUT,
    data: { name: "Ada <L>", plan: "pro", roles: ["admin", "dev"], prefs: { lang: "fr" } },
  };
  const r = (t: string, i: GoTrueMailInput = input) => renderGoTrueTemplate(t, i);
  // if / else if / else, comparisons over .Data, and the trim markers.
  const greet = '{{ if eq .Data.plan "free" }}Free{{ else if eq .Data.plan "pro" -}}  ' +
    "Pro {{- else }}Other{{ end }}";
  assertEquals(r(greet), "Pro");
  assertEquals(r("{{ if not .Data.missing }}none{{ end }}"), "none");
  assertEquals(r('{{ if and .Token (ne .Email "") }}both{{ end }}'), "both");
  assertEquals(r("{{ if or .Data.missing .Data.plan }}{{ .Data.plan }}{{ end }}"), "pro");
  assertEquals(r("{{ if lt (len .Data.roles) 3 }}few{{ end }}"), "few");
  // range (with variables and an else), with, index, printf, pipes, comments.
  assertEquals(r("{{ range $i, $r := .Data.roles }}{{ $i }}={{ $r }};{{ end }}"), "0=admin;1=dev;");
  assertEquals(r("{{ range .Data.none }}x{{ else }}empty{{ end }}"), "empty");
  assertEquals(r("{{ with .Data.prefs }}{{ .lang }}{{ end }}"), "fr");
  assertEquals(r("{{ with .Data.missing }}x{{ else }}no{{ end }}"), "no");
  assertEquals(r('{{ index .Data.roles 1 }}/{{ index .Data.prefs "lang" }}'), "dev/fr");
  assertEquals(
    r('{{ printf "%s has %d roles" .Data.name (len .Data.roles) }}'),
    "Ada &lt;L&gt; has 2 roles",
  );
  assertEquals(r('{{ .Data.plan | printf "[%s]" }}{{/* a comment */}}'), "[pro]");
  assertEquals(r("{{ $u := .SiteURL }}{{ $u }}/x"), "https://app.test/x");
  assertEquals(r("{{ .Data.name | urlquery }}"), "Ada+%3CL%3E");
  // Values stay HTML-escaped; `.` and `$` are the whole data.
  assertEquals(r("{{ .Data.name }}"), "Ada &lt;L&gt;");
  assertEquals(r("{{ with $.Data }}{{ $.Email }}{{ end }}"), "ada@example.test");
  // Each kind gets GoTrue's own data: reauthentication has no link, an email change the new address.
  const reauth = { ...input, action: "reauthentication" };
  assertEquals(r("[{{ .ConfirmationURL }}]{{ .Token }}", reauth), "[]123456");
  const change = { ...input, action: "email_change", newEmail: "new@example.test" };
  assertEquals(r("{{ .Email }} → {{ .NewEmail }}", change), "ada@example.test → new@example.test");
  assertEquals(r("{{ .NewEmail }}"), "");
  // A failing action (a call on an unknown function) falls back.
  assertEquals(r("{{ nosuch .Token }}"), null);
});

Deno.test("gotrue smtp: a sign-up confirmation goes out over SMTP with GoTrue's subject", async () => {
  const server = startFakeSmtp();
  try {
    await withSmtpApp({ smtp: smtpTo(server) }, async (app) => {
      assertEquals(await signup(app, "ada@example.test"), 200);
      assertEquals(server.mail.length, 1);
      const [mail] = server.mail;
      assertEquals(mail.to, ["ada@example.test"]);
      assertEquals(mail.authedAs, "user");
      assertEquals(subjectOf(mail.data), "Confirm Your Email");
      const body = decoded(mail.data);
      assertMatch(body, /https:\/\/app\.test\/auth\/v1\/verify\?token=[^&"]+&amp;type=signup/);
      assertMatch(body, /Alternatively, enter the code: \d{6}/);
      assert(mail.data.includes("multipart/alternative"));
    });
  } finally {
    await server.close();
  }
});

Deno.test("gotrue smtp: configured subjects and a fetched template", async () => {
  const server = startFakeSmtp();
  let fetches = 0;
  const templates = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, () => {
    fetches++;
    return new Response('<p>Hi {{ .Email }}: <a href="{{ .ConfirmationURL }}">confirm</a></p>');
  });
  try {
    const url = `http://127.0.0.1:${templates.addr.port}/confirm.html`;
    const smtp = smtpTo(server, {
      subjects: { confirmation: "Bienvenue — confirmez" },
      templates: { confirmation: url },
    });
    await withSmtpApp({ smtp }, async (app) => {
      assertEquals(await signup(app, "ada@example.test"), 200);
      assertEquals(await signup(app, "bob@example.test"), 200);
      assertEquals(server.mail.length, 2);
      const subject = subjectOf(server.mail[0].data);
      assertMatch(subject, /^=\?UTF-8\?B\?/);
      const body = decoded(server.mail[1].data);
      assert(body.includes('<p>Hi bob@example.test: <a href="https://app.test/auth/v1/verify?'));
      assertEquals(fetches, 1, "the template is fetched once and cached");
    });
  } finally {
    await templates.shutdown();
    await server.close();
  }
});

Deno.test("gotrue smtp: a fetched Go template sees the user's metadata as .Data", async () => {
  const server = startFakeSmtp();
  const templates = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () =>
      new Response(
        "{{ if .Data.name }}<p>Hi {{ .Data.name }}</p>{{ else }}<p>Hi there</p>{{ end }}" +
          '{{ with .RedirectTo }}<a href="{{ . }}">back</a>{{ end }}',
      ),
  );
  try {
    const url = `http://127.0.0.1:${templates.addr.port}/confirm.html`;
    await withSmtpApp(
      { smtp: smtpTo(server, { templates: { confirmation: url } }) },
      async (app) => {
        const res = await app.fetch(`${ORIGIN}/auth/v1/signup`, {
          method: "POST",
          headers: { apikey: app.publishableKey, "content-type": "application/json" },
          body: JSON.stringify({
            email: "ada@example.test",
            password: "a long password",
            data: { name: "Ada <L>" },
          }),
        });
        await res.body?.cancel();
        assertEquals(res.status, 200);
        assertEquals(await signup(app, "bob@example.test"), 200);
        assert(decoded(server.mail[0].data).includes("<p>Hi Ada &lt;L&gt;</p>"));
        assert(decoded(server.mail[1].data).includes("<p>Hi there</p>"));
        assert(decoded(server.mail[1].data).includes('<a href="'));
      },
    );
  } finally {
    await templates.shutdown();
    await server.close();
  }
});

Deno.test("gotrue smtp: an unchanged environment keeps its options object", () => {
  const vars = new Map(Object.entries({
    GOTRUE_SMTP_HOST: "smtp.example.test",
    GOTRUE_SMTP_PORT: "2525",
    GOTRUE_SMTP_ADMIN_EMAIL: "admin@example.test",
    GOTRUE_SMTP_SENDER_NAME: "Example",
  }));
  const env = (name: string) => vars.get(name);
  const fromEnv = processGoTrueSmtp(env)!;
  assertEquals(fromEnv, {
    host: "smtp.example.test",
    port: 2525,
    from: "Example <admin@example.test>",
  });
  assert(processGoTrueSmtp(env) === fromEnv, "the same object, so the sender is reused");
  vars.set("GOTRUE_SMTP_PORT", "587");
  assertEquals(processGoTrueSmtp(env)!.port, 587);
  assertEquals(processGoTrueSmtp(() => undefined), undefined);
});

Deno.test("gotrue smtp: hooks.sendEmail and sendVerificationRequest take precedence", async () => {
  const server = startFakeSmtp();
  try {
    const hooked: string[] = [];
    const app = await supabaseAuthApp({
      adapter: inMemoryAuthAdapter(),
      auth: {
        smtp: smtpTo(server),
        hooks: { sendEmail: (p) => void hooked.push(p.email_data.email_action_type) },
      },
      authConfig: { sendVerificationRequest: undefined },
      withClient: false,
    });
    try {
      assertEquals(await signup(app, "ada@example.test"), 200);
    } finally {
      await app.close();
    }
    const viaCallback = await supabaseAuthApp({
      adapter: inMemoryAuthAdapter(),
      auth: { smtp: smtpTo(server) },
      withClient: false,
    });
    try {
      assertEquals(await signup(viaCallback, "bob@example.test"), 200);
      assertEquals(viaCallback.emails.length, 1);
    } finally {
      await viaCallback.close();
    }
    assertEquals(hooked, ["signup"]);
    assertEquals(server.mail.length, 0);
  } finally {
    await server.close();
  }
});

Deno.test("gotrue smtp: a refused send is a 500 'Error sending email', with nothing leaked", async () => {
  const server = startFakeSmtp({ tls: "none" });
  try {
    await withSmtpApp({ smtp: smtpTo(server) }, async (app) => {
      const res = await app.fetch(`${ORIGIN}/auth/v1/signup`, {
        method: "POST",
        headers: { apikey: app.publishableKey, "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.test", password: "a long password" }),
      });
      assertEquals(res.status, 500);
      assertEquals((await res.json()).msg, "Error sending email");
      assertEquals(server.mail.length, 0);
    });
  } finally {
    await server.close();
  }
});

Deno.test("gotrue smtp: a template redirect is followed only to https on the same origin", async () => {
  const server = startFakeSmtp();
  const requested: string[] = [];
  const fakeFetch = ((input: URL | string) => {
    const url = String(input);
    requested.push(url);
    const redirect = (to: string) =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: to } }));
    switch (url) {
      case "https://cdn.test/same":
        return redirect("/real.html");
      case "https://cdn.test/offsite":
        return redirect("https://internal.test/secret");
      case "https://cdn.test/downgrade":
        return redirect("http://cdn.test/real.html");
      case "https://cdn.test/loop":
        return redirect("/loop");
      case "https://cdn.test/real.html":
        return Promise.resolve(new Response("<p>fetched {{ .Token }}</p>"));
      default:
        return Promise.resolve(new Response("<p>must not be fetched</p>"));
    }
  }) as typeof fetch;
  const warnings: string[] = [];
  const logger = { warn: (message: string) => void warnings.push(message) };
  try {
    for (
      const [path, fetched] of [
        ["same", true],
        ["offsite", false],
        ["downgrade", false],
        ["loop", false],
      ] as const
    ) {
      const sender = goTrueSmtpSender(
        { ...smtpTo(server), templates: { confirmation: `https://cdn.test/${path}` } },
        logger,
        fakeFetch,
      );
      await sender.send(INPUT);
      const body = decoded(server.mail.at(-1)!.data);
      assertEquals(body.includes("fetched 123456"), fetched, path);
      assertEquals(body.includes("must not be fetched"), false, path);
    }
    assert(!requested.some((u) => u.startsWith("https://internal.test") || u.startsWith("http:")));
    assertEquals(
      requested.filter((u) => u === "https://cdn.test/loop").length,
      4,
      "3 hops, then refused",
    );
    assertEquals(warnings.length, 3);
  } finally {
    await server.close();
  }
});
