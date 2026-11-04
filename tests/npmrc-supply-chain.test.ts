// A build child runs with a config denext generates under `.denext/`, where Deno finds no project
// `.npmrc`: the supply-chain keys set there (`paranoid`, `advisory-check`, …) must reach the
// generated config's `supplyChain`, and nothing else from the file (it may hold credentials).

import { assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { npmrcValue, withNpmrcSupplyChain } from "../src/build/npmrc-supply-chain.ts";
import { supplyChainConfig } from "../src/build/workspace-imports.ts";

Deno.test("npmrcValue: the last value wins; comments and other keys are skipped", () => {
  assertEquals(npmrcValue("a=1\n# a=3\n; a=4\na = 2\r\n", "a"), "2");
  assertEquals(npmrcValue("b=1", "a"), undefined);
});

Deno.test("withNpmrcSupplyChain: each key in deno.json's spelling; the stricter source wins", () => {
  assertEquals(withNpmrcSupplyChain(undefined, null), undefined);
  assertEquals(withNpmrcSupplyChain(undefined, "registry=https://r.example\n"), undefined);
  const base = { advisoryCheck: "on" };
  assertEquals(withNpmrcSupplyChain(base, "paranoid=false\n"), base, "nothing asked: unchanged");
  assertEquals(
    withNpmrcSupplyChain(
      undefined,
      [
        "paranoid=true",
        "jail-scripts=true",
        "advisory-check=required",
        "low-download-check=on",
        "low-download-threshold=5000",
        "allowed-unpopular-packages=@acme/*, left-pad",
      ].join("\n"),
    ),
    {
      paranoid: true,
      jailScripts: true,
      advisoryCheck: "required",
      lowDownloadCheck: "prompt",
      lowDownloadThreshold: 5000,
      allowLowDownloads: ["@acme/*", "left-pad"],
    },
  );
  // deno.json's stricter values stay; a looser .npmrc can't undo them.
  assertEquals(
    withNpmrcSupplyChain(
      {
        advisoryCheck: "required",
        lowDownloadCheck: "required",
        jailScripts: true,
        lowDownloadThreshold: 3000,
        allowLowDownloads: ["a"],
      },
      "advisory-check=off\nlow-download-check=warn\njail-scripts=false\n" +
        "low-download-threshold=0\nallowed-unpopular-packages=a,b\n",
    ),
    {
      advisoryCheck: "required",
      lowDownloadCheck: "required",
      jailScripts: true,
      lowDownloadThreshold: 3000,
      allowLowDownloads: ["a", "b"],
    },
  );
  // A threshold of 0 (off) yields to any other; an opt-out alone is carried as written.
  assertEquals(
    withNpmrcSupplyChain({ lowDownloadThreshold: 0 }, "low-download-threshold=200"),
    { lowDownloadThreshold: 200 },
  );
  assertEquals(withNpmrcSupplyChain(undefined, "jail-scripts=false"), { jailScripts: false });
  // An exceptions object is deno.json's own: kept as it is.
  const object = { jailScripts: { packages: { sharp: { net: true } } } };
  assertEquals(withNpmrcSupplyChain(object, "jail-scripts=false"), object);
  // Unknown values are not carried.
  assertEquals(withNpmrcSupplyChain(undefined, "advisory-check=maybe\nparanoid=yes"), undefined);
});

Deno.test("supplyChainConfig: the project .npmrc's gates reach the generated config, never its credentials", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext_npmrc_chain_" });
  try {
    await Deno.writeTextFile(join(root, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(root, ".npmrc"),
      "//registry.npmjs.org/:_authToken=npm_SECRET\nparanoid=true\nadvisory-check=required\n",
    );
    const config = await supplyChainConfig(join(root, "deno.json"));
    assertEquals(config, { supplyChain: { paranoid: true, advisoryCheck: "required" } });
    assertFalse(JSON.stringify(config).includes("SECRET"));
    // A workspace member takes the root's .npmrc, as Deno does.
    await Deno.writeTextFile(join(root, "deno.json"), JSON.stringify({ workspace: ["./app"] }));
    await Deno.mkdir(join(root, "app"));
    await Deno.writeTextFile(join(root, "app", "deno.json"), "{}");
    await Deno.writeTextFile(join(root, "app", ".npmrc"), "advisory-check=off\n");
    assertEquals(await supplyChainConfig(join(root, "app", "deno.json")), {
      supplyChain: { paranoid: true, advisoryCheck: "required" },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
