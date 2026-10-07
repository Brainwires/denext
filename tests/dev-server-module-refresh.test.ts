// `denext dev` (App Router): an edit reaches the server render through every importer, not only
// the route entry the loader cache-busts — a Server Component in `app/ui/` or in `components/`
// (outside `app/`), an edited `"use server"` module's new implementation, and each platform
// target's own action variant.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startDevServer } from "../src/build/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";
import { resetModuleGraphCache } from "../src/build/module-graph.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_dev_refresh_" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

async function devServer(dir: string) {
  // The crawls cache one graph per name for the process: start from this project's alone.
  resetModuleGraphCache();
  const controller = new AbortController();
  const paths = await resolveProject(dir);
  const port = await new Promise<number>((resolve) => {
    startDevServer({
      paths,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: ({ port }) => resolve(port),
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    html: async (headers: Record<string, string> = {}) =>
      await (await fetch(`${origin}/`, { headers })).text(),
    /** Call the action `id` as the client stub does; resolves its JSON result. */
    call: async (id: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`${origin}/_denext/action/${id}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-denext-action": "1",
          ...headers,
        },
        body: JSON.stringify({ args: [] }),
      });
      return (await res.json()) as { result?: unknown; error?: string };
    },
    stop: async () => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

/** Poll until `check` holds (the watcher's debounce, then the next request). */
async function eventually(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

const label = (text: string) => `export function Label(){ return <b>${text}</b>; }\n`;
const extra = (text: string) => `export function Extra(){ return <i>${text}</i>; }\n`;

Deno.test("denext dev: an edit to a nested Server Component reaches the server render", async () => {
  const dir = await project({
    "app/page.tsx": `import { Label } from "./ui/Label.tsx";\n` +
      `import { Extra } from "../components/Extra.tsx";\n` +
      `export default function Page(){ return <main><Label/><Extra/></main>; }\n`,
    "app/ui/Label.tsx": label("LABEL_ONE"),
    "components/Extra.tsx": extra("EXTRA_ONE"),
  });
  const dev = await devServer(dir);
  try {
    const first = await dev.html();
    assertStringIncludes(first, "LABEL_ONE");
    assertStringIncludes(first, "EXTRA_ONE");

    // Inside app/: the page itself is unchanged.
    await Deno.writeTextFile(join(dir, "app/ui/Label.tsx"), label("LABEL_TWO"));
    await eventually("app/ui/Label.tsx re-rendered", async () => {
      const html = await dev.html();
      return html.includes("LABEL_TWO") && !html.includes("LABEL_ONE");
    });

    // Outside app/.
    await Deno.writeTextFile(join(dir, "components/Extra.tsx"), extra("EXTRA_TWO"));
    await eventually("components/Extra.tsx re-rendered", async () => {
      const html = await dev.html();
      return html.includes("EXTRA_TWO") && !html.includes("EXTRA_ONE");
    });
    assertStringIncludes(await dev.html(), "LABEL_TWO", "the earlier edit stays applied");
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext dev: many edits keep the server copies bounded", async () => {
  const dir = await project({
    "app/page.tsx": `import { Label } from "./ui/Label.tsx";\n` +
      `import { Extra } from "../components/Extra.tsx";\n` +
      `export default function Page(){ return <main><Label/><Extra/></main>; }\n`,
    "app/ui/Label.tsx": label("LABEL_0"),
    "components/Extra.tsx": extra("EXTRA"),
  });
  const dev = await devServer(dir);
  /** Every file the dev server wrote under `.denext/server-cache`. */
  const copies = async () => {
    let n = 0;
    const walk = async (d: string) => {
      for await (const e of Deno.readDir(d)) {
        if (e.isDirectory) await walk(join(d, e.name));
        else n++;
      }
    };
    await walk(join(dir, ".denext", "server-cache")).catch(() => {});
    return n;
  };
  try {
    assertStringIncludes(await dev.html(), "LABEL_0");
    const EDITS = 12;
    for (let i = 1; i <= EDITS; i++) {
      await Deno.writeTextFile(join(dir, "app/ui/Label.tsx"), label(`LABEL_${i}`));
      await eventually(
        `edit ${i} rendered`,
        async () => (await dev.html()).includes(`LABEL_${i}<`),
      );
    }
    // The edited module and its importer (the page) keep at most their current and previous
    // copies; the untouched component is never copied.
    const n = await copies();
    assert(n <= 4, `${n} server copies after ${EDITS} edits`);
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

/** The action id a `<form action={fn}>` rendered with. */
function actionId(html: string): string {
  const m = html.match(/\/_denext\/action\/([^"&]+)/);
  assert(m, `no action URL in ${html}`);
  return decodeURIComponent(m[1]);
}

const greet = (text: string) =>
  `"use server"\nexport async function greet(){ return "${text}"; }\n`;

Deno.test("denext dev: an edited action runs its new implementation", async () => {
  const dir = await project({
    "app/page.tsx": `import { greet } from "./actions.ts";\n` +
      `export default function Page(){ return <form action={greet}><button>go</button></form>; }\n`,
    "app/actions.ts": greet("GREET_ONE"),
  });
  const dev = await devServer(dir);
  try {
    const id = actionId(await dev.html());
    assertEquals((await dev.call(id)).result, "GREET_ONE");
    await Deno.writeTextFile(join(dir, "app/actions.ts"), greet("GREET_TWO"));
    // Called straight away, with no render in between (a client-side stub posting after HMR).
    await eventually(
      "the edited action ran",
      async () => (await dev.call(id)).result === "GREET_TWO",
    );
    assertEquals(actionId(await dev.html()), id, "the action keeps its id");
    assertEquals((await dev.call(id)).result, "GREET_TWO");
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext dev: each target's session runs its own action variant", async () => {
  const dir = await project({
    "app/page.tsx": `import { greet } from "./actions.ts";\n` +
      `export default function Page(){ return <form action={greet}><button>go</button></form>; }\n`,
    "app/actions.ts": `"use server"\nimport { who } from "./who.ts";\n` +
      `export async function greet(){ return who; }\n`,
    "app/who.ts": `export const who = "WEB_WHO";\n`,
    "app/who.ios.ts": `export const who = "IOS_WHO";\n`,
  });
  const dev = await devServer(dir);
  const IOS = { cookie: "__denext_platform=ios" };
  try {
    // The iOS session tags first, then web: neither registration may take the other's place.
    const iosId = actionId(await dev.html(IOS));
    const webId = actionId(await dev.html());
    assertEquals(iosId, webId, "one action id across targets");
    assertEquals((await dev.call(webId)).result, "WEB_WHO");
    assertEquals((await dev.call(iosId, IOS)).result, "IOS_WHO");
    assertEquals((await dev.call(webId)).result, "WEB_WHO", "web still runs its own");
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
