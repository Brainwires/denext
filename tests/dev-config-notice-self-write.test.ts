// Regression: `denext dev` (App Router) printed "deno.json changed — restart the dev server" in an
// app with stylesheets whose `deno.json` carries the css→shim redirects (a converted app with npm
// dependencies, where the CLI mirrors them into the app's own config). Each CSS graph crawl
// strips those redirects from `deno.json` for its `deno info` run and puts the file back; the
// folder watcher, which watches `deno.json` itself, took both of denext's writes for an edit. A
// real edit to the file must still print the notice.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { createDevState } from "../src/build/dev-server/state.ts";
import { watch } from "../src/build/dev-server/watch.ts";
import { discoverCssFiles } from "../src/build/css.ts";
import { removeTempDir } from "./helpers/temp.ts";

const NOTICE = "restart the dev server";

/** The notices `watch` prints, and a wait for one naming a file. */
class Notices {
  readonly seen: string[] = [];
  #waiters: Array<{ name: string; resolve: () => void }> = [];

  push(line: string): void {
    if (!line.includes(NOTICE)) return;
    this.seen.push(line);
    const due = this.#waiters.filter((w) => line.includes(w.name));
    this.#waiters = this.#waiters.filter((w) => !due.includes(w));
    for (const w of due) w.resolve();
  }

  /** Resolves with whether a notice naming `name` arrived within `ms`. */
  async next(name: string, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Promise<true>((resolve) =>
      this.#waiters.push({ name, resolve: () => resolve(true) })
    );
    const result = await Promise.race([
      seen,
      new Promise<false>((r) => timer = setTimeout(() => r(false), ms)),
    ]);
    clearTimeout(timer);
    return result;
  }
}

/** An App Router app with a stylesheet whose deno.json carries an injected css→shim redirect. */
async function cssApp(): Promise<{ dir: string; config: string; original: string }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-dev-cfg-notice-" }));
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(join(dir, "app", "a.css"), "body { color: red; }\n");
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    'import "./a.css";\nexport default function Page() { return null; }\n',
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
  const original = JSON.stringify(
    {
      imports: {
        [toFileUrl(join(dir, "app", "a.css")).href]:
          toFileUrl(join(dir, ".denext", "css-shims", "css_0.js")).href,
      },
    },
    null,
    2,
  ) + "\n";
  const config = join(dir, "deno.json");
  await Deno.writeTextFile(config, original);
  return { dir, config, original };
}

Deno.test({
  name: "dev: the CSS crawl's own deno.json writes print no restart notice; an edit does",
  fn: async () => {
    const { dir, config, original } = await cssApp();
    const controller = new AbortController();
    const notices = new Notices();
    const log = console.log;
    console.log = (...args: unknown[]) => notices.push(args.map(String).join(" "));
    try {
      const st = createDevState({
        paths: await resolveProject(dir),
        unbundled: false,
        signal: controller.signal,
      });
      void watch(st);
      // Attach: rewrite denext.config.ts until the watcher reports it (a write made before a
      // macOS FSEvents stream starts is never reported).
      const denextConfig = join(dir, "denext.config.ts");
      for (let i = 0;; i++) {
        const seen = notices.next("denext.config.ts", 300);
        await Deno.writeTextFile(denextConfig, `export default {}; // ${i}\n`);
        if (await seen) break;
      }
      notices.seen.length = 0;

      // Two crawls, each stripping the redirect from deno.json and putting it back.
      const page = join(dir, "app", "page.tsx");
      assertEquals(await discoverCssFiles([page], config), [join(dir, "app", "a.css")]);
      assertEquals(await Deno.readTextFile(config), original, "deno.json is restored verbatim");
      await discoverCssFiles([page], config);
      // A marker edit after the crawls: once its notice is in, every event they caused is too.
      const marker = notices.next("denext.config.ts", 10_000);
      await Deno.writeTextFile(denextConfig, "export default {}; // marker\n");
      assert(await marker, "the marker edit was reported");
      assertEquals(
        notices.seen.filter((line) => line.includes("deno.json")),
        [],
        "denext's own deno.json writes were taken for an edit",
      );

      // The developer's edit to the same file still prints the notice.
      const edit = notices.next("deno.json", 10_000);
      await Deno.writeTextFile(config, original.replace("{", '{\n  "lock": false,'));
      assert(await edit, "a real deno.json edit must still print the notice");
    } finally {
      console.log = log;
      controller.abort();
      await removeTempDir(dir);
    }
  },
});
