import { assertEquals } from "@std/assert";
import { defineConfig } from "../src/server/define-config.ts";

Deno.test("defineConfig returns the config unchanged (identity)", () => {
  const cfg = { basePath: "/app", trailingSlash: true };
  assertEquals(defineConfig(cfg), cfg);
});

Deno.test("defineConfig type-checks the config (accepts valid, rejects unknown fields)", async () => {
  const mod = new URL("../src/server/define-config.ts", import.meta.url).pathname;
  const dir = await Deno.makeTempDir({ prefix: "denext-defineconfig-" });
  const check = async (body: string): Promise<number> => {
    await Deno.writeTextFile(`${dir}/t.ts`, body);
    const { code } = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/t.ts`],
      stderr: "null",
      stdout: "null",
    }).output();
    return code;
  };
  try {
    assertEquals(
      await check(`import { defineConfig } from "${mod}";\nexport default defineConfig({ basePath: "/x", cache: { store: "sqlite" } });`),
      0,
    );
    assertEquals(
      (await check(`import { defineConfig } from "${mod}";\nexport default defineConfig({ notAField: 1 });`)) === 0,
      false,
      "an unknown config field must not typecheck",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
