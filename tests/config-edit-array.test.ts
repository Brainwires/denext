import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { applyArrayOps, setConfigValue } from "../src/build/config-edit.ts";

const RULE = { source: "/x", destination: "/y", permanent: false };

/** Format `source` the way `deno task check` would, so a test can assert fmt-stability. */
async function denoFmt(source: string): Promise<string> {
  const config = new URL("../deno.json", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--config", config, "--ext", "ts", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout);
}

// --- comment and code preservation ------------------------------------------

Deno.test("applyArrayOps: trailing comments ride with their element through a move", async () => {
  const src = `export default {
  redirects: () => [
    // every redirect below is permanent
    { source: "/home", destination: "/", permanent: true }, // the legacy home
    { source: "/a", destination: "/b", permanent: true }, // the short link
  ],
};
`;
  const r = await applyArrayOps(src, ["redirects"], [{ op: "move", from: 1, to: 0 }]);
  assert(r.ok);
  assertEquals(
    r.source,
    `export default {
  redirects: () => [
    // every redirect below is permanent
    { source: "/a", destination: "/b", permanent: true }, // the short link
    { source: "/home", destination: "/", permanent: true }, // the legacy home
  ],
};
`,
  );
});

Deno.test("applyArrayOps: code elements come through byte-identical", async () => {
  const src = `export default {
  redirects: () => [
    redirect("/old", "/new"),
    { source: "/a", destination: "/b", permanent: true },
    ...extraRedirects,
  ],
};
`;
  const r = await applyArrayOps(src, ["redirects"], [
    { op: "insert", at: 0, value: RULE },
    { op: "move", from: 3, to: 1 },
  ]);
  assert(r.ok);
  assertStringIncludes(r.source, `    redirect("/old", "/new"),\n`);
  assertStringIncludes(r.source, `    ...extraRedirects,\n`);
  // insert at 0, then move the spread (now last) to index 1.
  assertStringIncludes(
    r.source,
    `  redirects: () => [
    { source: "/x", destination: "/y", permanent: false },
    ...extraRedirects,
    redirect("/old", "/new"),
    { source: "/a", destination: "/b", permanent: true },
  ],
`,
  );
});

Deno.test("applyArrayOps: removing and updating keeps the untouched elements verbatim", async () => {
  const src = `export default {
  redirects: () => [
    redirect("/old"),
    { source: "/a", destination: "/b", permanent: true },
  ],
};
`;
  const removed = await applyArrayOps(src, ["redirects"], [{ op: "remove", at: 1 }]);
  assert(removed.ok);
  assertEquals(
    removed.source,
    `export default {\n  redirects: () => [\n    redirect("/old"),\n  ],\n};\n`,
  );

  const updated = await applyArrayOps(src, ["redirects"], [{ op: "update", at: 1, value: RULE }]);
  assert(updated.ok);
  assertStringIncludes(updated.source, `    redirect("/old"),\n`);
  assertStringIncludes(
    updated.source,
    `    { source: "/x", destination: "/y", permanent: false },\n`,
  );
});

// --- where the array literal may live ---------------------------------------

Deno.test("applyArrayOps: arrow-body and method-body arrays are both edited in place", async () => {
  const arrow = `export default {
  redirects: () => [
    { source: "/a", destination: "/b", permanent: true },
  ],
};
`;
  const method = `export default {
  redirects() {
    return [
      { source: "/a", destination: "/b", permanent: true },
    ];
  },
};
`;
  const fromArrow = await applyArrayOps(arrow, ["redirects"], [{
    op: "insert",
    at: 1,
    value: RULE,
  }]);
  assert(fromArrow.ok);
  assertEquals(
    fromArrow.source,
    `export default {
  redirects: () => [
    { source: "/a", destination: "/b", permanent: true },
    { source: "/x", destination: "/y", permanent: false },
  ],
};
`,
  );

  const fromMethod = await applyArrayOps(method, ["redirects"], [
    { op: "insert", at: 1, value: RULE },
  ]);
  assert(fromMethod.ok);
  assertEquals(
    fromMethod.source,
    `export default {
  redirects() {
    return [
      { source: "/a", destination: "/b", permanent: true },
      { source: "/x", destination: "/y", permanent: false },
    ];
  },
};
`,
  );
});

Deno.test("applyArrayOps: a direct array and a nested one are edited too", async () => {
  const src = `export default {
  i18n: { locales: ["en"] },
  images: {
    domains: [],
  },
};
`;
  const locales = await applyArrayOps(src, ["i18n", "locales"], [
    { op: "insert", at: 1, value: "fr" },
  ]);
  assert(locales.ok);
  assertStringIncludes(locales.source, `  i18n: { locales: ["en", "fr"] },\n`);

  const domains = await applyArrayOps(src, ["images", "domains"], [
    { op: "insert", at: 0, value: "cdn.example.com" },
  ]);
  assert(domains.ok);
  assertStringIncludes(domains.source, `    domains: ["cdn.example.com"],\n`);
});

Deno.test("applyArrayOps: a missing key is created, wrapped in a function on request", async () => {
  const src = `export default {\n  basePath: "/app",\n};\n`;
  const wrapped = await applyArrayOps(src, ["redirects"], [{ op: "insert", at: 0, value: RULE }], {
    wrapper: "function",
  });
  assert(wrapped.ok);
  assertEquals(
    wrapped.source,
    `export default {
  basePath: "/app",
  redirects: () => [{ source: "/x", destination: "/y", permanent: false }],
};
`,
  );

  const plain = await applyArrayOps(src, ["i18n", "locales"], [
    { op: "insert", at: 0, value: "en" },
    { op: "insert", at: 1, value: "fr" },
  ]);
  assert(plain.ok);
  assertStringIncludes(plain.source, `  i18n: { locales: ["en", "fr"] },\n`);
});

// --- byte safety and refusals -----------------------------------------------

Deno.test("applyArrayOps: byte offsets survive multi-byte characters", async () => {
  const src = `// ☕ café — the naïve list
export default {
  i18n: { locales: ["en"], messages: { fr: "Bonjour, ça va ?" } },
};
`;
  const r = await applyArrayOps(src, ["i18n", "locales"], [{ op: "insert", at: 0, value: "fr" }]);
  assert(r.ok);
  assertEquals(r.source, src.replace(`["en"]`, `["fr", "en"]`));
});

Deno.test("applyArrayOps: out-of-range ops and non-array values bail honestly", async () => {
  const src = `export default {\n  basePath: "/app",\n  i18n: { locales: ["en"] },\n};\n`;
  const range = await applyArrayOps(src, ["i18n", "locales"], [{ op: "remove", at: 4 }]);
  assert(!range.ok);
  assertStringIncludes(range.reason, "out of range");

  const notArray = await applyArrayOps(src, ["basePath"], [{ op: "remove", at: 0 }]);
  assert(!notArray.ok);
  assertStringIncludes(notArray.reason, "is not an array literal");

  const unsupported = await applyArrayOps(`export default makeConfig();\n`, ["redirects"], []);
  assert(!unsupported.ok);
  assertStringIncludes(unsupported.reason, "no editable config object");
});

// --- formatting -------------------------------------------------------------

Deno.test("config-edit: every written source is deno fmt stable", async () => {
  const base = `import { htmx } from "@denext/htmx";

export default {
  basePath: "/app",
  images: { domains: ["a.com"] },
  redirects: () => [
    redirect("/old"), // a helper
    { source: "/a", destination: "/b", permanent: true },
  ],
  plugins: [htmx()],
};
`;
  const results = [
    await setConfigValue(base, ["basePath"], "/docs"),
    await setConfigValue(base, ["i18n"], { locales: ["en", "fr"], defaultLocale: "en" }),
    await setConfigValue(`export default {};\n`, ["basePath"], "/app"),
    await applyArrayOps(base, ["redirects"], [{ op: "move", from: 1, to: 0 }]),
    await applyArrayOps(base, ["redirects"], [{ op: "insert", at: 0, value: RULE }]),
    await applyArrayOps(base, ["images", "domains"], [{ op: "insert", at: 1, value: "b.com" }]),
    await applyArrayOps(base, ["headers"], [{
      op: "insert",
      at: 0,
      value: { source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
    }], { wrapper: "function" }),
  ];
  for (const r of results) {
    assert(r.ok);
    assertEquals(await denoFmt(r.source), r.source, r.diff);
  }
});
