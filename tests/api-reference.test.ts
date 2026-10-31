// The generated API reference (site/app/docs/api/reference.json, also the basis of
// llms-full.txt) must render every signature faithfully: no phantom `_: unknown` parameters
// (defaulted / destructured params) and no generic references stripped to a bare name.

import { assert } from "@std/assert";

Deno.test("API reference: signatures carry real parameter names and generic type arguments", async () => {
  const ref = JSON.parse(
    await Deno.readTextFile(new URL("../site/app/docs/api/reference.json", import.meta.url)),
  ) as
    & { groups?: Array<{ symbols: Array<{ signature: string; name: string }> }> }
    & Record<string, unknown>;
  const groups = ref.groups ?? (Array.isArray(ref) ? ref as never : []);
  const sigs = (groups as Array<{ symbols: Array<{ signature: string }> }>).flatMap((g) =>
    g.symbols.map((s) => s.signature)
  );
  assert(sigs.length > 300, `reference looks empty (${sigs.length} signatures)`);
  const phantom = sigs.filter((s) => /\b_: unknown\b/.test(s));
  const barePromise = sigs.filter((s) => /\): Promise$/.test(s) || /: Promise[,)]/.test(s));
  assert(phantom.length === 0, `phantom params:\n${phantom.slice(0, 5).join("\n")}`);
  assert(barePromise.length === 0, `bare Promise:\n${barePromise.slice(0, 5).join("\n")}`);
});

Deno.test("API reference and llms-full.txt carry no terminal escape codes", async () => {
  // `deno doc --json` once wrote colour codes into template-literal types' `repr`
  // (`${\u001b[0m\u001b[38;5;12mContactTypes…`), and they were committed into both files.
  for (const path of ["../site/app/docs/api/reference.json", "../site/public/llms-full.txt"]) {
    const text = await Deno.readTextFile(new URL(path, import.meta.url));
    const raw = text.indexOf("\x1b");
    const escaped = text.indexOf("\\u001b");
    assert(raw < 0, `${path}: an ESC byte at ${raw}: ${JSON.stringify(text.slice(raw, raw + 40))}`);
    assert(
      escaped < 0,
      `${path}: an escaped ESC at ${escaped}: ${text.slice(escaped, escaped + 40)}`,
    );
  }
});
