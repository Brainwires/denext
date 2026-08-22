// Real-browser E2E: a REAL @base-ui/react Menu on denext's OWN React. Clicking the
// trigger must open the menu and it must STAY open. The failure this guards against:
// the dismissable-layer outside-press handler catching the same click that opened the
// menu (an event/effect-timing divergence from React), so the popup opens then closes
// on the same tick.
//
// Opt-in (needs network for npm deps): run with `deno task test:e2e`.
import { assert } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("./fixtures/base-ui-menu", import.meta.url));

async function setup(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_base_ui_menu_" });
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

const POPUP_PRESENT = `!!document.querySelector('[data-testid="popup"]')`;

Deno.test({
  name: "e2e: Base UI menu opens on click and stays open",
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

    await t.step("trigger renders", async () => {
      await page.waitForFunction(`!!document.querySelector('[data-testid="trigger"]')`);
    });

    await t.step("click trigger -> menu opens and stays open", async () => {
      await page.evaluate(`document.querySelector('[data-testid="trigger"]').click()`);
      // Wait for it to appear at all.
      let appeared = false;
      for (let i = 0; i < 20; i++) {
        if (await page.evaluate(POPUP_PRESENT)) {
          appeared = true;
          break;
        }
        await page.evaluate("new Promise(r=>setTimeout(r,25))");
      }
      assert(appeared, "menu popup never appeared after clicking the trigger");
      // Now assert it STAYS open across several frames (the immediate-close bug).
      for (let i = 0; i < 12; i++) {
        await page.evaluate("new Promise(r=>setTimeout(r,25))");
        const present = await page.evaluate(POPUP_PRESENT);
        assert(present, `menu closed immediately after opening (frame ${i})`);
      }
    });

    assert(errs.length === 0, "console errors: " + errs.join(" | "));
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
