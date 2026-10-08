// `denext/jsx-directives` for apps that type-check against @types/react (T3 Code's `tsc`):
// the documented two-line `client-directives.d.ts` merges `ClientDirectives` into React's
// `Attributes`, so `<Chart client:visible client:placeholder={<p />} />` type-checks on any
// component and intrinsic element. Without it the keys are unknown props; with it a misspelled
// directive or a wrong value type is still an error. Checked with `deno check` against
// npm:@types/react (the version T3 Code installs).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";

const at = (p: string) => new URL(`../${p}`, import.meta.url).href;

const TYPES_REACT = "npm:@types/react@19.3.0";

/** The app-side file the docs give (docs: /docs/spa → client:* directives → @types/react). */
const CLIENT_DIRECTIVES_DTS = `import type { ClientDirectives } from "denext/jsx-directives";
declare module "react" { interface Attributes extends ClientDirectives<import("react").ReactNode> {} }
`;

const APP = `import type { ReactNode } from "react";
function Chart(props: { points: number[] }): ReactNode {
  return props.points.length;
}
export const a = <Chart points={[1]} client:visible client:placeholder={<p>loading</p>} />;
export const b = <Chart points={[1]} client:media="(min-width: 800px)" />;
export const c = <Chart points={[1]} client:load client:idle client:interaction client:only />;
export const d = <section client:visible />;
`;

const MISUSE = `import type { ReactNode } from "react";
function Chart(props: { points: number[] }): ReactNode {
  return props.points.length;
}
export const typo = <Chart points={[1]} client:visble />;
export const wrongType = <Chart points={[1]} client:load="yes" />;
`;

async function check(withDirectives: boolean, app: string): Promise<{ code: number; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_jsx_directives_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "react",
          lib: ["deno.window", "dom"],
          strict: true,
          ...(withDirectives ? { types: ["./client-directives.d.ts"] } : {}),
        },
        imports: {
          "react": TYPES_REACT,
          "react/jsx-runtime": `${TYPES_REACT}/jsx-runtime`,
          "denext/jsx-directives": at("src/jsx-directives.ts"),
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "client-directives.d.ts"), CLIENT_DIRECTIVES_DTS);
    await Deno.writeTextFile(join(dir, "app.tsx"), app);
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", join(dir, "deno.json"), toFileUrl(join(dir, "app.tsx")).href],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    // deno colors the diagnostics; strip the escapes for matching.
    // deno-lint-ignore no-control-regex
    const out = (dec.decode(stdout) + dec.decode(stderr)).replace(/\x1b\[[0-9;]*m/g, "");
    return { code, out };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "jsx-directives: client:* type-checks on @types/react components only with the file",
  sanitizeResources: false,
  async fn() {
    const bare = await check(false, APP);
    assert(bare.code !== 0, "without the file the directives are unknown props");
    assertStringIncludes(bare.out, "client:visible");
    const typed = await check(true, APP);
    assertEquals(typed.code, 0, typed.out);
  },
});

Deno.test({
  name: "jsx-directives: a misspelled directive or a wrong value type is still an error",
  sanitizeResources: false,
  async fn() {
    const misuse = await check(true, MISUSE);
    assert(misuse.code !== 0, misuse.out);
    assertStringIncludes(misuse.out, "client:visble");
    assertStringIncludes(misuse.out, "client:load");
  },
});
