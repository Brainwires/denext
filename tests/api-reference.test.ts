// The generated API reference (apps/web/app/docs/api/reference.json, also the basis of
// llms-full.txt) must render every signature faithfully: no phantom `_: unknown` parameters
// (defaulted / destructured params) and no generic references stripped to a bare name.

import { assert } from "@std/assert";

Deno.test("API reference: signatures carry real parameter names and generic type arguments", async () => {
  const ref = JSON.parse(
    await Deno.readTextFile(new URL("../apps/web/app/docs/api/reference.json", import.meta.url)),
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
