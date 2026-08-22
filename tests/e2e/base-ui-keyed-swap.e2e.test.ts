// Real-browser E2E mirroring T3's CommandPalette keyed-content swap. The dialog's inner
// content is KEYED and the key changes when `browsing` flips; denext must remount it and
// leave NO stale pre-flip nodes. Guards the "two buttons stacked on top of each other,
// both clickable" bug (a keyed remount that failed to delete the old subtree).
//
// Opt-in (needs network for npm deps): run with `deno task test:e2e`.
import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("./fixtures/base-ui-keyed-swap", import.meta.url));

async function setup(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_keyed_swap_" });
  await copy(join(FIXTURE, "src"), join(dir, "src"));
  await copy(join(FIXTURE, "denext.config.ts"), join(dir, "denext.config.ts"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        nodeModulesDir: "auto",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "react",
          lib: ["deno.window", "dom", "dom.iterable"],
        },
        imports: {
          "react": `${FW}src/compat/react.ts`,
          "react-dom": `${FW}src/compat/react-dom.ts`,
          "react-dom/client": `${FW}src/compat/react-dom-client.ts`,
          "react/jsx-runtime": `${FW}src/jsx/jsx-runtime.ts`,
          "react-is": `${FW}src/compat/react-is.ts`,
          "denext": `${FW}mod.ts`,
          "denext/": `${FW}src/`,
          "denext/server": `${FW}src/server/mod.ts`,
          "denext/client": `${FW}src/client/mod.ts`,
          "@base-ui/react/": "npm:/@base-ui/react@1.5.0/",
        },
      },
      null,
      2,
    ),
  );
  const cache = await new Deno.Command(Deno.execPath(), {
    args: ["cache", join(dir, "src", "main.tsx")],
    cwd: dir,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (cache.code !== 0) {
    throw new Error(`deno cache failed: ${new TextDecoder().decode(cache.stderr)}`);
  }
  return dir;
}

const COUNT = (sel: string) => `document.querySelectorAll('${sel}').length`;

Deno.test({
  name: "e2e: keyed dialog content swap leaves no stale buttons",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  const server = await buildAndServe(dir);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(server.origin + "/");
    const errs: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      if (d?.type === "error") errs.push(String(d.text ?? ""));
    });

    await t.step("initial: Back present, Add absent", async () => {
      await page.waitForFunction(`!!document.querySelector('[data-testid="popup"]')`);
      assertEquals(await page.evaluate(COUNT('[data-testid="back"]')), 1, "one Back initially");
      assertEquals(await page.evaluate(COUNT('[data-testid="add"]')), 0, "no Add initially");
    });

    await t.step("flip browsing -> exactly one Add, zero stale Back", async () => {
      await page.evaluate(`document.querySelector('[data-testid="localfolder"]').click()`);
      // let the remount settle across a few frames
      for (let i = 0; i < 8; i++) await page.evaluate("new Promise(r=>setTimeout(r,25))");
      const back = await page.evaluate(COUNT('[data-testid="back"]'));
      const add = await page.evaluate(COUNT('[data-testid="add"]'));
      const rows = await page.evaluate(COUNT('[data-testid="row"]'));
      const folder = await page.evaluate(COUNT('[data-testid="folder"]'));
      console.log("AFTER FLIP:", JSON.stringify({ back, add, rows, folder }));
      assertEquals(back, 0, `stale Back button left in DOM: ${back}`);
      assertEquals(add, 1, `expected exactly one Add: ${add}`);
      assertEquals(rows, 1, `expected exactly one content row (no stale remount): ${rows}`);
      assertEquals(folder, 1, `expected one folder icon: ${folder}`);
    });

    assert(errs.length === 0, "console errors: " + errs.join(" | "));
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
