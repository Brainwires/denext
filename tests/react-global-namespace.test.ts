// The documented recipe for npm libraries whose `.d.ts` reads @types/react's GLOBAL `React`
// namespace (virtua: `Pick<React.HTMLAttributes<HTMLElement>, "style" | …>`). denext's types
// cannot declare that global (JSR refuses a package that changes global types), so an app
// declares it with a two-line `react-global.d.ts` listed in `compilerOptions.types`
// (docs: /docs/npm-react-libraries → Troubleshooting). This proves the recipe type-checks
// such a library, and that without it the props are missing.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";

const ROOT = new URL("../", import.meta.url);
const at = (p: string) => new URL(p, ROOT).href;

/** A library typed the way virtua 0.52 is: through the global `React` namespace. */
const LIB_DTS = `import type { ReactNode } from "react";
export type ViewportAttributes = Pick<
  React.HTMLAttributes<HTMLElement>,
  "className" | "style" | "id" | "onWheel"
> & React.AriaAttributes;
export interface ListProps extends ViewportAttributes {
  children: ReactNode;
}
export declare function List(props: ListProps): ReactNode;
`;

const CONSUMER = `// @ts-types="./lib.d.ts"
import { List } from "./lib.js";
export const el = <List style={{ height: "100%" }} className="x" aria-label="rows">{"row"}</List>;
`;

async function check(dir: string, withGlobal: boolean): Promise<{ code: number; out: string }> {
  const config = {
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "denext",
      lib: ["deno.window", "dom"],
      ...(withGlobal ? { types: ["./react-global.d.ts"] } : {}),
    },
    imports: {
      "denext": at("mod.ts"),
      "denext/jsx-runtime": at("src/jsx/jsx-runtime.ts"),
      "react": at("src/compat/react.ts"),
      "react/jsx-runtime": at("src/jsx/jsx-runtime.ts"),
    },
  };
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(config));
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--config", join(dir, "deno.json"), toFileUrl(join(dir, "app.tsx")).href],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

/** A fresh project dir (one per check: deno's check cache can keep a failed result across
 * a `compilerOptions.types` change in the same dir). */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_react_global_" });
  await Deno.writeTextFile(join(dir, "lib.js"), "export const List = () => null;\n");
  await Deno.writeTextFile(join(dir, "lib.d.ts"), LIB_DTS);
  await Deno.writeTextFile(join(dir, "app.tsx"), CONSUMER);
  await Deno.writeTextFile(
    join(dir, "react-global.d.ts"),
    'export type * from "react";\nexport as namespace React;\n',
  );
  return dir;
}

Deno.test({
  name: "react-global.d.ts gives libraries typed through the global React namespace their props",
  sanitizeResources: false,
  async fn() {
    const without = await project();
    const withGlobal = await project();
    try {
      const bare = await check(without, false);
      assert(bare.code !== 0, "without the global the props should be missing");
      assert(/Cannot find namespace 'React'/.test(bare.out), bare.out);
      const fixed = await check(withGlobal, true);
      assertEquals(fixed.code, 0, fixed.out);
    } finally {
      await Deno.remove(without, { recursive: true });
      await Deno.remove(withGlobal, { recursive: true });
    }
  },
});
