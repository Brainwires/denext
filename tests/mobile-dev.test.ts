// `denext mobile dev`: the temporary `server.url` edit of a Capacitor config and its restore.
// Every edge is injected: no dev server starts and no real `cap` runs.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { PlannedCommand } from "../src/build/mobile-capabilities.ts";
import {
  capacitorConfigFile,
  LOCAL_NETWORK_USAGE,
  type MobileDevDeps,
  type MobileDevServer,
  restoreCapacitorConfig,
  runMobileDev,
  withDevServerUrl,
  withLocalNetworkAccess,
} from "../src/build/mobile-dev.ts";

const URL_ = "http://192.168.1.5:3000";

/** Capacitor's own `npx cap init` TypeScript template, plus a comment to keep. */
const TS_TEMPLATE = `import type { CapacitorConfig } from "@capacitor/cli";

// the app id is registered with Apple — do not change
const config: CapacitorConfig = {
  appId: "com.example.app",
  appName: "Example",
  webDir: "dist",
};

export default config;
`;

Deno.test("withDevServerUrl edits the stock TS template in place, keeping every other byte", async () => {
  const out = await withDevServerUrl("capacitor.config.ts", TS_TEMPLATE, URL_);
  assertStringIncludes(out, "// the app id is registered with Apple — do not change");
  assertStringIncludes(out, `url: "${URL_}"`);
  assertStringIncludes(out, "cleartext: true");
  assert(out.startsWith('import type { CapacitorConfig } from "@capacitor/cli";'));
  assert(out.trimEnd().endsWith("export default config;"));
});

Deno.test("withDevServerUrl merges into an existing server block", async () => {
  const source = `export default {
  appId: "a.b",
  server: { androidScheme: "https", url: "http://old:1" },
};
`;
  const out = await withDevServerUrl("capacitor.config.ts", source, URL_);
  assertStringIncludes(out, 'androidScheme: "https"');
  assertStringIncludes(out, `url: "${URL_}"`);
  assert(!out.includes("http://old:1"));
  assertStringIncludes(out, "cleartext: true");
});

Deno.test("withDevServerUrl handles JSON, defineConfig-style calls and CommonJS", async () => {
  const json = await withDevServerUrl(
    "capacitor.config.json",
    '{ "appId": "a.b", "server": { "hostname": "app" } }',
    URL_,
  );
  assertEquals(JSON.parse(json).server, { hostname: "app", url: URL_, cleartext: true });
  const call = await withDevServerUrl(
    "capacitor.config.ts",
    'export default define({ appId: "a.b" });\n',
    URL_,
  );
  assertStringIncludes(call, `url: "${URL_}"`);
  const cjs = await withDevServerUrl(
    "capacitor.config.js",
    'module.exports = { appId: "a.b" };\n',
    URL_,
  );
  assertStringIncludes(cjs, `url: "${URL_}"`);
});

Deno.test("withDevServerUrl refuses a config it cannot find an object in", async () => {
  await assertRejects(
    () => withDevServerUrl("capacitor.config.ts", "export default makeConfig();\n", URL_),
    Error,
    "could not find the exported config object",
  );
});

/** A Capacitor project in a temp dir, with the stock TS config. */
async function project(): Promise<{ root: string; file: string }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-mobile-dev-" }));
  const file = join(root, "capacitor.config.ts");
  await Deno.writeTextFile(file, TS_TEMPLATE);
  return { root, file };
}

/** Recording fakes; `copyCode` is what each `cap copy` returns, in order. */
function fakes(root: string, file: string, copyCode: number[] = [0, 0]) {
  const calls: PlannedCommand[] = [];
  const seen: string[] = [];
  let stopped = 0;
  const server: MobileDevServer = {
    url: URL_,
    attached: false,
    finished: new Promise(() => {}),
    stop: () => {
      stopped++;
      return Promise.resolve();
    },
  };
  const deps: MobileDevDeps = {
    run: async (command) => {
      calls.push(command);
      seen.push(await Deno.readTextFile(file)); // what `cap copy` would have pushed
      return { code: copyCode.shift() ?? 0 };
    },
    startServer: () => Promise.resolve(server),
    waitForStop: () => Promise.resolve(),
    log: () => {},
  };
  return { deps, calls, seen, stopped: () => stopped, root };
}

Deno.test("mobile dev writes server.url for the session, then restores it and re-copies", async () => {
  const { root, file } = await project();
  try {
    const f = fakes(root, file);
    await runMobileDev({ cwd: root }, f.deps);
    assertEquals(f.calls.map((c) => [c.cmd, ...c.args, c.cwd]), [
      ["npx", "cap", "copy", root],
      ["npx", "cap", "copy", root],
    ]);
    assertStringIncludes(f.seen[0], `url: "${URL_}"`, "the session copy points at the server");
    assertEquals(f.seen[1], TS_TEMPLATE, "the closing copy pushes the original config");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE, "byte-identical afterwards");
    assertEquals(await restoreCapacitorConfig(root), null, "no backup left behind");
    assertEquals(f.stopped(), 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev restores the config when cap copy fails, and still stops the server", async () => {
  const { root, file } = await project();
  try {
    const f = fakes(root, file, [1, 0]);
    await assertRejects(() => runMobileDev({ cwd: root }, f.deps), Error, "exited with 1");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
    assertEquals(f.stopped(), 1);
    assertEquals(f.calls.length, 2, "the restore re-copies");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev leaves the config alone when the dev server fails to start", async () => {
  const { root, file } = await project();
  try {
    const f = fakes(root, file);
    const deps = { ...f.deps, startServer: () => Promise.reject(new Error("no server")) };
    await assertRejects(() => runMobileDev({ cwd: root }, deps), Error, "no server");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
    assertEquals(f.calls.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a killed session's edit is restored by the next run (and by --restore)", async () => {
  const { root, file } = await project();
  try {
    // Simulate a run killed mid-session: the edit and its backup are both on disk.
    const edited = await withDevServerUrl(file, TS_TEMPLATE, "http://10.0.0.9:3000");
    await Deno.mkdir(join(root, ".denext"));
    const backup = join(root, ".denext", "mobile-dev-backup.json");
    await Deno.writeTextFile(
      backup,
      JSON.stringify({ file: "capacitor.config.ts", original: TS_TEMPLATE }),
    );
    await Deno.writeTextFile(file, edited);
    assertEquals(await restoreCapacitorConfig(root), file);
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);

    // Through a full run, the heal is logged and the session still restores at the end.
    await Deno.writeTextFile(
      backup,
      JSON.stringify({ file: "capacitor.config.ts", original: TS_TEMPLATE }),
    );
    await Deno.writeTextFile(file, edited);
    const lines: string[] = [];
    const f = fakes(root, file);
    await runMobileDev({ cwd: root }, { ...f.deps, log: (l) => lines.push(l) });
    assert(lines.some((l) => l.includes("did not exit cleanly")));
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a planted backup cannot redirect the restore outside the config file", async () => {
  const { root } = await project();
  try {
    await Deno.mkdir(join(root, ".denext"));
    await Deno.writeTextFile(
      join(root, ".denext", "mobile-dev-backup.json"),
      JSON.stringify({ file: "../elsewhere.txt", original: "pwned" }),
    );
    await assertRejects(() => restoreCapacitorConfig(root), Error, "not a mobile dev backup");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capacitorConfigFile follows Capacitor's lookup order; none is an error", async () => {
  const { root, file } = await project();
  try {
    await Deno.writeTextFile(join(root, "capacitor.config.json"), "{}");
    assertEquals(await capacitorConfigFile(root), file, ".ts wins over .json");
    await Deno.remove(file);
    await Deno.remove(join(root, "capacitor.config.json"));
    assertEquals(await capacitorConfigFile(root), null);
    await assertRejects(
      () => runMobileDev({ cwd: root }, fakes(root, file).deps),
      Error,
      "no Capacitor project",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- iOS: the Info.plist keys a WebView needs to reach a LAN dev server ----------------------

/** Capacitor's stock Info.plist, trimmed (no ATS, no local-network usage description). */
const STOCK_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Example</string>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
	</dict>
</dict>
</plist>
`;

/** The plist with both keys, as `mobile dev` needs them. */
const READY_PLIST = STOCK_PLIST.replace(
  "</dict>\n</plist>",
  "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n" +
    "\t\t<true/>\n\t</dict>\n\t<key>NSLocalNetworkUsageDescription</key>\n" +
    "\t<string>Talks to the dev box.</string>\n</dict>\n</plist>",
);

/** The top-level `NSAppTransportSecurity` dict's text. */
function atsDict(plist: string): string {
  const m = /<key>NSAppTransportSecurity<\/key>\s*(<dict>[\s\S]*?<\/dict>)/.exec(plist);
  assert(m, "an NSAppTransportSecurity dict");
  return m[1];
}

Deno.test("withLocalNetworkAccess adds ATS local networking and a usage description to a stock plist", () => {
  const out = withLocalNetworkAccess(STOCK_PLIST);
  assert(out);
  assertStringIncludes(atsDict(out), "<key>NSAllowsLocalNetworking</key>\n\t\t<true/>");
  assertStringIncludes(
    out,
    `<key>NSLocalNetworkUsageDescription</key>\n\t<string>${LOCAL_NETWORK_USAGE}</string>`,
  );
  assertStringIncludes(out, "<key>UIApplicationSupportsMultipleScenes</key>\n\t\t<false/>");
  assert(out.endsWith("</dict>\n</plist>\n"));
  assertEquals(withLocalNetworkAccess(out), out, "idempotent");
});

Deno.test("withLocalNetworkAccess merges into an existing ATS dict without losing its keys", () => {
  const plist = STOCK_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoads</key>\n" +
      "\t\t<true/>\n\t\t<key>NSExceptionDomains</key>\n\t\t<dict>\n" +
      "\t\t\t<key>example.com</key>\n\t\t\t<dict>\n" +
      "\t\t\t\t<key>NSAllowsLocalNetworking</key>\n\t\t\t\t<false/>\n" +
      "\t\t\t</dict>\n\t\t</dict>\n\t</dict>\n</dict>\n</plist>",
  );
  const out = withLocalNetworkAccess(plist);
  assert(out);
  const ats = /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*)<\/dict>\s*<key>NSLocal/
    .exec(out)?.[1] ?? "";
  assertStringIncludes(ats, "<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>");
  assertStringIncludes(ats, "<key>example.com</key>");
  assertStringIncludes(ats, "\t\t\t\t<key>NSAllowsLocalNetworking</key>\n\t\t\t\t<false/>");
  assertStringIncludes(ats, "\t\t</dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t");
  assertEquals(out.match(/<key>NSAppTransportSecurity<\/key>/g)?.length, 1);

  // A direct `false` is flipped in place, and an empty `<dict/>` filled.
  const off = READY_PLIST.replace("<true/>\n\t</dict>", "<false/>\n\t</dict>");
  assertEquals(withLocalNetworkAccess(off), READY_PLIST);
  const empty = withLocalNetworkAccess(
    STOCK_PLIST.replace(
      "</dict>\n</plist>",
      "\t<key>NSAppTransportSecurity</key>\n\t<dict/>\n</dict>\n</plist>",
    ),
  );
  assert(empty);
  assertStringIncludes(atsDict(empty), "<key>NSAllowsLocalNetworking</key>");

  // An ATS value that is not a dict is left for the developer.
  assertEquals(
    withLocalNetworkAccess(
      STOCK_PLIST.replace(
        "</dict>\n</plist>",
        "\t<key>NSAppTransportSecurity</key>\n\t<string/>\n</dict>\n</plist>",
      ),
    ),
    null,
  );
});

Deno.test("withLocalNetworkAccess keeps an app's own usage description", () => {
  const plist = STOCK_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>NSLocalNetworkUsageDescription</key>\n\t<string>Finds printers.</string>\n</dict>\n</plist>",
  );
  const out = withLocalNetworkAccess(plist);
  assert(out);
  assertStringIncludes(out, "<string>Finds printers.</string>");
  assert(!out.includes(LOCAL_NETWORK_USAGE));
  assertEquals(withLocalNetworkAccess(READY_PLIST), READY_PLIST, "both present: unchanged");
});

/** A project with an iOS app: its Info.plist (and, optionally, a CocoaPods workspace). */
async function iosProject(
  plist: string,
  workspace = false,
): Promise<{ root: string; file: string; plistFile: string }> {
  const { root, file } = await project();
  const plistFile = join(root, "ios", "App", "App", "Info.plist");
  await Deno.mkdir(join(root, "ios", "App", "App"), { recursive: true });
  await Deno.mkdir(join(root, "ios", "App", "App.xcodeproj"));
  if (workspace) await Deno.mkdir(join(root, "ios", "App", "App.xcworkspace"));
  await Deno.writeTextFile(plistFile, plist);
  return { root, file, plistFile };
}

/** One session through the fakes: the log, and the Info.plist `cap copy` saw mid-session. */
async function session(root: string, file: string, plistFile: string) {
  const lines: string[] = [];
  const f = fakes(root, file);
  const during: string[] = [];
  const deps: MobileDevDeps = {
    ...f.deps,
    run: async (command) => {
      during.push(await Deno.readTextFile(plistFile));
      return await f.deps.run(command);
    },
    log: (l) => lines.push(l),
  };
  await runMobileDev({ cwd: root }, deps);
  return { log: lines.join("\n"), during };
}

Deno.test("mobile dev adds the Info.plist keys for the session and restores the plist byte-for-byte", async () => {
  // A BOM and CRLFs, so a text round trip that normalised either would show.
  const original = "\uFEFF" + STOCK_PLIST.replaceAll("\n", "\r\n");
  const { root, file, plistFile } = await iosProject(original);
  try {
    const before = await Deno.readFile(plistFile);
    const { log, during } = await session(root, file, plistFile);
    assertStringIncludes(during[0], "<key>NSAllowsLocalNetworking</key>");
    assertStringIncludes(during[0], "<key>NSLocalNetworkUsageDescription</key>");
    assertEquals(await Deno.readFile(plistFile), before, "byte-identical afterwards");
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
    assertStringIncludes(log, "Info.plist changed: rebuild and run the app from Xcode");
    assertStringIncludes(log, "restores capacitor.config and Info.plist,");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev --restore puts a killed session's Info.plist back byte-for-byte", async () => {
  const { root, file, plistFile } = await iosProject(STOCK_PLIST);
  try {
    await Deno.mkdir(join(root, ".denext"));
    await Deno.writeTextFile(
      join(root, ".denext", "mobile-dev-backup.json"),
      JSON.stringify({
        file: "capacitor.config.ts",
        original: TS_TEMPLATE,
        plist: { file: "ios/App/App/Info.plist", original: STOCK_PLIST },
      }),
    );
    await Deno.writeTextFile(file, await withDevServerUrl(file, TS_TEMPLATE, URL_));
    await Deno.writeTextFile(plistFile, withLocalNetworkAccess(STOCK_PLIST)!);
    assertEquals(await restoreCapacitorConfig(root), file);
    assertEquals(await Deno.readTextFile(plistFile), STOCK_PLIST);
    assertEquals(await Deno.readTextFile(file), TS_TEMPLATE);
    assertEquals(await restoreCapacitorConfig(root), null, "the backup is gone");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev leaves a ready Info.plist unwritten and prints no rebuild note", async () => {
  const { root, file, plistFile } = await iosProject(READY_PLIST);
  try {
    const mtime = (await Deno.stat(plistFile)).mtime;
    await new Promise((done) => setTimeout(done, 20));
    const { log, during } = await session(root, file, plistFile);
    assertEquals(during[0], READY_PLIST);
    assertEquals(await Deno.readTextFile(plistFile), READY_PLIST);
    assertEquals((await Deno.stat(plistFile)).mtime, mtime, "never rewritten");
    assert(!log.includes("Info.plist changed"));
    assertStringIncludes(log, "restores capacitor.config and runs `cap copy` again");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mobile dev names the .xcworkspace when there is one, else the .xcodeproj", async () => {
  for (const workspace of [false, true]) {
    const { root, file, plistFile } = await iosProject(READY_PLIST, workspace);
    try {
      const { log } = await session(root, file, plistFile);
      const expected = workspace ? "ios/App/App.xcworkspace" : "ios/App/App.xcodeproj";
      assertStringIncludes(log, `open ${expected} in Xcode`);
      assert(!log.includes(workspace ? "App.xcodeproj" : "App.xcworkspace"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("a planted backup cannot redirect the Info.plist restore outside the project", async () => {
  for (const plistPath of ["../Info.plist", "ios/App/Other/Info.plist", "capacitor.config.ts"]) {
    const { root, file } = await iosProject(STOCK_PLIST);
    try {
      await Deno.mkdir(join(root, ".denext"));
      await Deno.writeTextFile(
        join(root, ".denext", "mobile-dev-backup.json"),
        JSON.stringify({
          file: "capacitor.config.ts",
          original: "config-bytes",
          plist: { file: plistPath, original: "pwned" },
        }),
      );
      await assertRejects(() => restoreCapacitorConfig(root), Error, "not a mobile dev backup");
      assertEquals(await Deno.readTextFile(file), TS_TEMPLATE, "nothing written before the check");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("mobile dev warns when the Android app declares its own network security config", async () => {
  const manifest = (attrs: string) =>
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Example"${attrs}>
    </application>
</manifest>
`;
  for (const declared of [false, true]) {
    const { root, file, plistFile } = await iosProject(READY_PLIST);
    try {
      const path = join(root, "android", "app", "src", "main", "AndroidManifest.xml");
      await Deno.mkdir(join(root, "android", "app", "src", "main"), { recursive: true });
      const text = manifest(
        declared ? '\n        android:networkSecurityConfig="@xml/network_security_config"' : "",
      );
      await Deno.writeTextFile(path, text);
      const { log } = await session(root, file, plistFile);
      if (declared) {
        assertStringIncludes(log, "declares android:networkSecurityConfig");
        assertStringIncludes(log, "overrides usesCleartextTraffic");
        assertStringIncludes(log, `refuse ${URL_}`);
        assertStringIncludes(log, "Allow cleartext for 192.168.1.5");
        assertStringIncludes(log, "https");
      } else {
        assert(!log.includes("networkSecurityConfig"));
      }
      assertEquals(await Deno.readTextFile(path), text, "their manifest is never edited");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
