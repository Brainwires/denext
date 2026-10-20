// The documented live-view / MVU examples type-check as written (`.tsx`, denext's JSX types).
// Each snippet is read from its source (AGENTS.md, the live-views guide) and `deno check`ed in a
// scratch project whose import map points `denext*` at this checkout, with a small prelude that
// declares the names the snippet leaves to the app (`db`, `auth`).

import { assertEquals } from "@std/assert";
import { fileUrlCheckEnv } from "./helpers/file-url-check-env.ts";

const ROOT = new URL("../", import.meta.url);
const at = (p: string) => new URL(p, ROOT).href;

/** The first ```tsx block of `doc` that contains `marker`. */
async function tsxBlock(doc: string, marker: string): Promise<string> {
  const text = await Deno.readTextFile(new URL(doc, ROOT));
  for (const m of text.matchAll(/```tsx\n([\s\S]*?)```/g)) {
    if (m[1].includes(marker)) return m[1];
  }
  throw new Error(`no tsx block with ${marker} in ${doc}`);
}

/** `deno check` one `.tsx` file in a scratch project; the exit code and diagnostics. */
async function check(source: string): Promise<{ code: number; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext-mvu-snippet-" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "denext",
          lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
          strict: true,
        },
        imports: {
          "denext": at("mod.ts"),
          "denext/jsx-runtime": at("src/jsx/jsx-runtime.ts"),
          "denext/jsx-dev-runtime": at("src/jsx/jsx-runtime.ts"),
          "denext/live": at("src/live.ts"),
          "denext/mvu": at("src/mvu.ts"),
          "denext/server": at("src/server/mod.ts"),
          "@std/assert": "jsr:@std/assert@^1",
        },
      }),
    );
    await Deno.writeTextFile(`${dir}/snippet.tsx`, source);
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", `--config=${dir}/deno.json`, `${dir}/snippet.tsx`],
      cwd: dir,
      env: fileUrlCheckEnv(),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return { code, out: dec.decode(stdout) + dec.decode(stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** What the snippets assume the app provides. */
const PRELUDE = [
  "declare const db: {",
  "  save(n: number): Promise<void>;",
  "  todos: { add(text: string): Promise<{ id: string; text: string }[]> };",
  "};",
  "declare function auth(): Promise<{ user: { id: string } } | null>;",
  "",
].join("\n");

Deno.test({
  name: "the AGENTS.md defineLiveView Counter type-checks (send() binds onClick)",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const snippet = await tsxBlock("AGENTS.md", "export const Counter = defineLiveView(");
    const { code, out } = await check(PRELUDE + snippet);
    assertEquals(code, 0, out);
  },
});

Deno.test({
  name: "the live-views guide's TodoView type-checks (send() binds onSubmit and onInput)",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const snippet = (await tsxBlock("site/app/docs/live-views/content.md", "defineLiveView({"))
      // The guide imports the app's own modules; the prelude declares them instead.
      .replace(/^import \{ auth \} from "denext\/server";\n/m, "")
      .replace(/^import \{ db \} from .*\n/m, "");
    const { code, out } = await check(PRELUDE + snippet);
    assertEquals(code, 0, out);
  },
});
