// Real-browser E2E: a REAL @base-ui/react Dialog on denext's OWN React (next-compat
// path), structured like a command palette (Portal > Backdrop + Viewport > Popup with
// an inline Autocomplete, under StrictMode). Base UI removes `data-starting-style` one
// rAF after open (a setState scheduled inside requestAnimationFrame), which must
// re-render the portalled popup + backdrop so their opacity transitions 0 -> 1 — the
// store-subscription + rAF + transition path across a portal. The popup must end up
// visible (opacity 1, no `data-starting-style`).
//
// Opt-in (needs network for the npm deps): run with `deno task test:e2e`.

import { assert } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/base-ui-dialog", import.meta.url));

async function setup(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_base_ui_dialog_" });
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

// Read an element's computed opacity + whether it still carries data-starting-style.
const PROBE = (sel: string) =>
  `(() => { const el = document.querySelector('${sel}');
     if (!el) return { present: false };
     const cs = getComputedStyle(el);
     return { present: true, opacity: cs.opacity,
       starting: el.hasAttribute('data-starting-style'),
       hidden: el.hasAttribute('hidden') }; })()`;

Deno.test({
  name: "e2e: Base UI dialog enter transition advances (popup becomes visible)",
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
      await page.waitForFunction(
        "!!document.querySelector('[data-testid=\"trigger\"]')",
      );
    });

    await t.step("open the dialog and observe the transition", async () => {
      await page.evaluate("document.querySelector('[data-testid=\"trigger\"]').click()");
      // Give the enter transition several animation frames to advance.
      await page.waitForFunction(
        "!!document.querySelector('[data-testid=\"popup\"]')",
      );
      // Poll for up to ~1s for the popup to reach opacity 1.
      let popup: Record<string, unknown> = {};
      let backdrop: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) {
        popup = await page.evaluate(PROBE('[data-testid="popup"]')) as Record<string, unknown>;
        backdrop = await page.evaluate(PROBE('[data-testid="backdrop"]')) as Record<
          string,
          unknown
        >;
        if (popup.opacity === "1" && popup.starting === false) break;
        await page.evaluate("new Promise(r => setTimeout(r, 50))");
      }
      console.log("POPUP:", JSON.stringify(popup));
      console.log("BACKDROP:", JSON.stringify(backdrop));
      assert(
        popup.starting === false && popup.opacity === "1",
        `popup stuck at enter start-frame: ${JSON.stringify(popup)}`,
      );
    });

    await t.step("no console errors", () => {
      assert(errs.length === 0, `console errors:\n${errs.join("\n")}`);
    });
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
