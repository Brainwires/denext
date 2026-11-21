// `desktop.app.browser` and the `defaultBrowser` capability: the Info.plist URL and document types,
// the Linux `.desktop` MimeType merge, the config rules, the launch router's http(s) delivery, the
// backend API's per-OS branches (LaunchServices over a fake `Deno.dlopen`, xdg-settings / xdg-mime
// over a fake runner) and the page calls in `denext/desktop/app`.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { withBrowserHandlers } from "../src/build/desktop-browser.ts";
import { parsePlist, type PlistNode } from "../src/build/plist-value.ts";
import { linuxDesktopEntry, packageMetaFrom } from "../src/build/desktop-installers.ts";
import { finishLinuxBundleEntry, linuxEntryKeys } from "../src/build/desktop-linux-entry.ts";
import { desktopPermissionFlags } from "../src/build/desktop-capabilities.ts";
import {
  BROWSER_MIME_TYPES,
  CORE_FOUNDATION_PATH,
  CORE_SERVICES_PATH,
  desktopBrowserEnabled,
} from "../src/desktop/browser-config.ts";
import {
  browserSchemeArg,
  createDefaultBrowser,
  type DlopenFn,
  type RunCommandFn,
} from "../src/desktop/default-browser.ts";
import {
  defaultBrowserCapability,
  defaultBrowserPermissions,
} from "../src/desktop/caps/default-browser.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import { createLaunchRouter, type DesktopAppApi } from "../src/desktop/launch-events.ts";
import { createAppController } from "../src/desktop/caps/app.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import {
  appCapabilities,
  getSchemeOwner,
  isDefaultBrowser,
  setDefaultBrowser,
} from "../src/desktop/app.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, type FakeMethod } from "./helpers/desktop-fake-runtime.ts";

// ---------------------------------------------------------------------------------------------
// macOS Info.plist
// ---------------------------------------------------------------------------------------------

/** An Info.plist as `deno desktop` writes it for an app with one deep link and one document type. */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.example.browser</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.example.browser</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>exbrowser</string>
			</array>
		</dict>
	</array>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Notes</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>public.plain-text</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;

/** The value of `key` in a dict node. */
function get(node: PlistNode | undefined, key: string): PlistNode | undefined {
  return node?.kind === "dict" ? node.entries.find(([k]) => k === key)?.[1] : undefined;
}

/** The string items of an array node. */
function strs(node: PlistNode | undefined): string[] {
  return node?.kind === "array" ? node.items.map((i) => (i.kind === "string" ? i.text : "?")) : [];
}

/** The items of an array node. */
function arr(node: PlistNode | undefined): PlistNode[] {
  return node?.kind === "array" ? node.items : [];
}

Deno.test("Info.plist: http / https URL type and the HTML document types (Alternate), deep links kept", () => {
  const root = parsePlist(withBrowserHandlers(INFO_PLIST));
  const urlTypes = arr(get(root, "CFBundleURLTypes"));
  assertEquals(urlTypes.map((t) => strs(get(t, "CFBundleURLSchemes"))), [
    ["exbrowser"],
    ["http", "https"],
  ]);
  const web = urlTypes[1];
  assertEquals((get(web, "CFBundleURLName") as { text: string }).text, "Web site URL");
  assertEquals((get(web, "CFBundleTypeRole") as { text: string }).text, "Viewer");
  const docs = arr(get(root, "CFBundleDocumentTypes"));
  assertEquals(docs.map((d) => strs(get(d, "LSItemContentTypes"))), [
    ["public.plain-text"],
    ["public.html"],
    ["public.xhtml"],
    ["public.url"],
  ]);
  for (const d of docs.slice(1)) {
    assertEquals((get(d, "LSHandlerRank") as { text: string }).text, "Alternate");
    assertEquals((get(d, "CFBundleTypeRole") as { text: string }).text, "Viewer");
  }
  assertEquals((get(root, "CFBundleIdentifier") as { text: string }).text, "com.example.browser");
});

Deno.test("Info.plist: running twice gives the same file; a plist without the keys gains them", () => {
  const once = withBrowserHandlers(INFO_PLIST);
  assertEquals(withBrowserHandlers(once), once);
  const bare = withBrowserHandlers(
    '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>A</key><string>b</string></dict></plist>',
  );
  const root = parsePlist(bare);
  assertEquals(arr(get(root, "CFBundleURLTypes")).length, 1);
  assertEquals(arr(get(root, "CFBundleDocumentTypes")).length, 3);
  assertThrows(() => withBrowserHandlers("<plist><array/></plist>"), Error, "not a dict");
});

// ---------------------------------------------------------------------------------------------
// Linux .desktop entries
// ---------------------------------------------------------------------------------------------

const DENO_JSON = { version: "1.0.0", desktop: { app: { name: "Ex Browser" } } };
const BROWSER_CONFIG = {
  desktop: {
    app: { identifier: "com.example.browser", browser: true },
    linux: { desktopEntry: { mimeTypes: ["text/html", "image/svg+xml"] } },
  },
};

Deno.test("linux: a browser's .deb / .rpm entry claims http / https and the HTML types, merged once", () => {
  const meta = packageMetaFrom(DENO_JSON, BROWSER_CONFIG, "x", undefined, "linux");
  assertEquals(meta.browser, true);
  assertEquals(linuxEntryKeys(meta).mimeTypes, [...BROWSER_MIME_TYPES, "image/svg+xml"]);
  const entry = linuxDesktopEntry(meta);
  assertStringIncludes(
    entry,
    "MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;" +
      "image/svg+xml;\n",
  );
  // A URL, not a file list: the launcher passes the link (or the opened file) as one argument.
  assert(/^Exec=.* %u$/m.test(entry), entry);
});

Deno.test("linux: without browser nothing changes (no http claim, files as %F)", () => {
  const plain = packageMetaFrom(
    DENO_JSON,
    {
      desktop: { linux: { desktopEntry: { mimeTypes: ["text/html"] } } },
    },
    "x",
    undefined,
    "linux",
  );
  assertEquals(plain.browser, undefined);
  const entry = linuxDesktopEntry(plain);
  assertStringIncludes(entry, "MimeType=text/html;\n");
  assert(!entry.includes("x-scheme-handler/http"));
  assert(/^Exec=.* %F$/m.test(entry), entry);
});

Deno.test("linux: the bundle's own entry (tarball / AppImage) gains the browser types and %u", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-browser-entry-" });
  try {
    await Deno.writeTextFile(
      join(dir, "com.example.browser.desktop"),
      "[Desktop Entry]\nType=Application\nName=ex-browser-x64\n" +
        'Exec=env LAUFEY_APP_ID=com.example.browser "ex-browser-x64"\nCategories=Utility;\n',
    );
    const meta = packageMetaFrom(DENO_JSON, BROWSER_CONFIG, "x", undefined, "linux");
    const path = await finishLinuxBundleEntry(dir, meta);
    const text = await Deno.readTextFile(path!);
    assertStringIncludes(
      text,
      "MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;" +
        "image/svg+xml;\n",
    );
    assertStringIncludes(text, 'Exec=env LAUFEY_APP_ID=com.example.browser "ex-browser-x64" %u\n');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

/** Validate a config with just a `desktop` block. */
function validateDesktop(desktop: unknown): void {
  validateDenextConfig({ desktop } as DenextConfig);
}

Deno.test("config: desktop.app.browser is a boolean that needs an identifier; deepLinks still refuse http(s)", () => {
  validateDesktop({ app: { browser: true, identifier: "com.example.browser" } });
  validateDesktop({ app: { browser: false } });
  assertThrows(() => validateDesktop({ app: { browser: "yes" } }), Error, "desktop.app.browser");
  assertThrows(
    () => validateDesktop({ app: { browser: true } }),
    Error,
    "requires desktop.app.identifier",
  );
  assertThrows(
    () => validateDesktop({ app: { deepLinks: ["https"], identifier: "com.example.browser" } }),
    Error,
    "reserved",
  );
  assertEquals(desktopBrowserEnabled({ desktop: { app: { browser: true } } }), true);
  assertEquals(desktopBrowserEnabled({ desktop: { app: { browser: "true" } } }), false);
  assertEquals(desktopBrowserEnabled(undefined), false);
});

Deno.test("config: desktop.capabilities.defaultBrowser needs desktop.app.identifier at launch", async () => {
  await assertRejects(
    () => resolveDesktopCapabilities({ desktop: { capabilities: { defaultBrowser: true } } }),
    Error,
    "defaultBrowser needs `desktop.app.identifier`",
  );
  const r = await resolveDesktopCapabilities({
    desktop: {
      app: { identifier: "com.example.browser", browser: true },
      capabilities: { defaultBrowser: true },
    },
  } as never);
  assert(r.capabilities.some((c) => c.name === "defaultBrowser"));
  assertEquals(r.browserLinks, true);
  assertEquals((await resolveDesktopCapabilities({ desktop: {} } as never)).browserLinks, false);
});

Deno.test("packaging: default-browser bakes scoped FFI on macOS, two programs on Linux, nothing on Windows", () => {
  assertEquals(desktopPermissionFlags(["default-browser"], "darwin"), [
    `--allow-ffi=${CORE_FOUNDATION_PATH},${CORE_SERVICES_PATH}`,
  ]);
  assertEquals(desktopPermissionFlags(["default-browser"], "linux"), [
    "--allow-run=xdg-mime,xdg-settings",
  ]);
  assertEquals(desktopPermissionFlags(["default-browser"], "windows"), []);
  assertEquals(defaultBrowserPermissions("windows"), {});
});

// ---------------------------------------------------------------------------------------------
// Launch router: http(s) links
// ---------------------------------------------------------------------------------------------

/** A fake `Deno.desktop` with launch URLs and an `openurl` event. */
function fakeApi(launchUrls: string[]): DesktopAppApi & { fire(url: string): void } {
  const target = new EventTarget();
  return {
    launchUrls,
    addEventListener: (t, l) => target.addEventListener(t, l),
    fire: (url) => target.dispatchEvent(new CustomEvent("openurl", { detail: { url } })),
  };
}

Deno.test("launch router: http(s) links reach the page only for a browser app; owner / claim stay deep links", async () => {
  for (const browserLinks of [true, false]) {
    const api = fakeApi(["https://example.com/a", "myapp://x", "ftp://example.com/"]);
    const router = createLaunchRouter({
      schemes: ["myapp"],
      browserLinks,
      api,
      emit: () => {},
    });
    router.install();
    api.fire("http://example.com/b");
    const deepLinks = router.capabilities.find((c) => c.name === "deepLinks")!;
    const taken = await deepLinks.methods.take.handler({}, {} as DesktopCapCtx) as Array<
      { url: string; launch: boolean }
    >;
    assertEquals(
      taken.map((l) => l.url),
      browserLinks ? ["https://example.com/a", "myapp://x", "http://example.com/b"] : ["myapp://x"],
    );
    const err = await assertRejects(
      async () => await deepLinks.methods.owner.handler({ scheme: "https" }, {} as DesktopCapCtx),
      DesktopCapError,
    );
    assertEquals(err.code, "scheme_not_declared");
  }
});

Deno.test("appCapabilities: browserLinks follows the runtime's Deno.desktop.browserLinks", async () => {
  for (const browserLinks of [true, undefined]) {
    const cap = createAppController({
      window: undefined,
      emit: () => {},
      os: "darwin",
      api: { browserLinks } as DesktopAppApi,
    }).capability;
    const out = await cap.methods.capabilities.handler({}, {} as DesktopCapCtx) as {
      browserLinks: boolean;
    };
    assertEquals(out.browserLinks, browserLinks === true);
  }
});

// ---------------------------------------------------------------------------------------------
// macOS: LaunchServices over a fake dlopen
// ---------------------------------------------------------------------------------------------

interface FakeLs {
  dlopen: DlopenFn;
  handlers: Map<string, string>;
  sets: Array<[string, string]>;
  opened: string[];
  closed: number;
  live: Set<object>;
}

/**
 * A fake `Deno.dlopen` of CoreFoundation and CoreServices: CFStrings are objects, the handler
 * table a map. `onSet` decides what LSSetDefaultHandlerForURLScheme does (its status, and whether
 * the change applies at once).
 */
function fakeLaunchServices(
  handlers: Record<string, string>,
  onSet: (scheme: string, id: string, table: Map<string, string>) => number = () => 0,
): FakeLs {
  const state: FakeLs = {
    handlers: new Map(Object.entries(handlers)),
    sets: [],
    opened: [],
    closed: 0,
    live: new Set(),
    dlopen: () => ({ symbols: {}, close: () => {} }),
  };
  const mk = (s: string) => {
    const ref = { s };
    state.live.add(ref);
    return ref;
  };
  const decode = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, b.indexOf(0)));
  state.dlopen = (path) => {
    state.opened.push(path);
    const symbols: Record<string, (...a: unknown[]) => unknown> = path === CORE_FOUNDATION_PATH
      ? {
        CFStringCreateWithCString: (_alloc, buf) => mk(decode(buf as Uint8Array)),
        CFStringGetCString: (ref, buf, size) => {
          const bytes = new TextEncoder().encode((ref as { s: string }).s);
          if (bytes.length + 1 > (size as number)) return 0;
          (buf as Uint8Array).set(bytes);
          return 1;
        },
        CFRelease: (ref) => {
          assert(state.live.delete(ref as object), "released twice or never created");
        },
      }
      : {
        LSCopyDefaultHandlerForURLScheme: (ref) => {
          const id = state.handlers.get((ref as { s: string }).s);
          return id === undefined ? null : mk(id);
        },
        LSSetDefaultHandlerForURLScheme: (scheme, id) => {
          const pair: [string, string] = [(scheme as { s: string }).s, (id as { s: string }).s];
          state.sets.push(pair);
          return onSet(pair[0], pair[1], state.handlers);
        },
      };
    return { symbols, close: () => void state.closed++ };
  };
  return state;
}

Deno.test("macOS: getSchemeOwner reads LaunchServices; every CFString is released, libraries closed", async () => {
  const ls = fakeLaunchServices({ http: "com.apple.safari", mailto: "com.apple.mail" });
  const api = createDefaultBrowser({
    identifier: "com.example.browser",
    os: "darwin",
    dlopen: ls.dlopen,
  });
  assertEquals(await api.getSchemeOwner("HTTP:"), "com.apple.safari");
  assertEquals(await api.getSchemeOwner("mailto"), "com.apple.mail");
  assertEquals(await api.getSchemeOwner("gopher"), null);
  assertEquals(ls.opened.slice(0, 2), [CORE_FOUNDATION_PATH, CORE_SERVICES_PATH]);
  assertEquals(ls.closed, ls.opened.length);
  assertEquals(ls.live.size, 0);
  const bad = await assertRejects(() => api.getSchemeOwner("no spaces"), DesktopCapError);
  assertEquals(bad.code, "validation");
});

Deno.test("macOS: setDefaultBrowser asks for http and https; prompted until the user confirms", async () => {
  const ls = fakeLaunchServices({ http: "com.apple.safari", https: "com.apple.safari" });
  const api = createDefaultBrowser({
    identifier: "com.example.Browser",
    os: "darwin",
    dlopen: ls.dlopen,
  });
  assertEquals(await api.isDefaultBrowser(), false);
  assertEquals(await api.setDefaultBrowser(), "prompted");
  assertEquals(ls.sets, [["http", "com.example.Browser"], ["https", "com.example.Browser"]]);
  // The user confirmed: LaunchServices reports the id in lower case, which still matches.
  ls.handlers.set("http", "com.example.browser");
  ls.handlers.set("https", "com.example.browser");
  assertEquals(await api.isDefaultBrowser(), true);
  // Already the default: no second request (no second dialog).
  assertEquals(await api.setDefaultBrowser(), "set");
  assertEquals(ls.sets.length, 2);
  assertEquals(ls.live.size, 0);
});

Deno.test("macOS: an immediate change is set; a refused one (undeclared scheme) is failed", async () => {
  const applied = fakeLaunchServices({}, (scheme, id, table) => {
    table.set(scheme, id);
    return 0;
  });
  assertEquals(
    await createDefaultBrowser({
      identifier: "com.example.browser",
      os: "darwin",
      dlopen: applied.dlopen,
    })
      .setDefaultBrowser(),
    "set",
  );
  const refused = fakeLaunchServices({}, () => -10814);
  assertEquals(
    await createDefaultBrowser({
      identifier: "com.example.browser",
      os: "darwin",
      dlopen: refused.dlopen,
    })
      .setDefaultBrowser(),
    "failed",
  );
  assertEquals(refused.sets.length, 1, "stops at the first refusal");
});

Deno.test("macOS: an FFI grant the app lacks is forbidden; a library that will not load is failed", async () => {
  const denied: DlopenFn = () => {
    throw new Deno.errors.NotCapable('Requires ffi access to "CoreFoundation"');
  };
  const forbidden = await assertRejects(
    () =>
      createDefaultBrowser({ identifier: "a.b", os: "darwin", dlopen: denied }).isDefaultBrowser(),
    DesktopCapError,
  );
  assertEquals(forbidden.code, "forbidden");
  assertStringIncludes(forbidden.message, "denext desktop add default-browser");
  let cfClosed = false;
  const half: DlopenFn = (path) => {
    if (path === CORE_SERVICES_PATH) throw new Error("image not found");
    return { symbols: {}, close: () => void (cfClosed = true) };
  };
  const failed = await assertRejects(
    () =>
      createDefaultBrowser({ identifier: "a.b", os: "darwin", dlopen: half }).getSchemeOwner(
        "http",
      ),
    DesktopCapError,
  );
  assertEquals(failed.code, "failed");
  assert(cfClosed, "CoreFoundation is closed when CoreServices fails to open");
});

// ---------------------------------------------------------------------------------------------
// Linux: xdg-settings / xdg-mime over a fake runner
// ---------------------------------------------------------------------------------------------

/** A fake runner: answers by `program args…`, records every call. */
function fakeRun(
  answers: Record<string, { code: number; stdout: string } | Error>,
): { run: RunCommandFn; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (program, args) => {
      const key = [program, ...args].join(" ");
      calls.push(key);
      const a = answers[key] ?? answers[program];
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a ?? { code: 1, stdout: "" });
    },
  };
}

Deno.test("linux: setDefaultBrowser runs xdg-settings with the .desktop id and checks it took", async () => {
  let current = "firefox.desktop\n";
  const calls: string[] = [];
  const run: RunCommandFn = (program, args) => {
    calls.push([program, ...args].join(" "));
    if (args[0] === "set") current = `${args[2]}\n`;
    return Promise.resolve({ code: 0, stdout: args[0] === "get" ? current : "" });
  };
  const api = createDefaultBrowser({ identifier: "com.example.browser", os: "linux", run });
  assertEquals(await api.isDefaultBrowser(), false);
  assertEquals(await api.setDefaultBrowser(), "set");
  assertEquals(await api.isDefaultBrowser(), true);
  assertEquals(calls, [
    "xdg-settings get default-web-browser",
    "xdg-settings set default-web-browser com.example.browser.desktop",
    "xdg-settings get default-web-browser",
    "xdg-settings get default-web-browser",
  ]);
});

Deno.test("linux: a failed or ignored set is failed; no xdg-settings is unsupported", async () => {
  const id = "com.example.browser";
  const failing = fakeRun({
    "xdg-settings set default-web-browser com.example.browser.desktop": { code: 2, stdout: "" },
  });
  assertEquals(
    await createDefaultBrowser({ identifier: id, os: "linux", run: failing.run })
      .setDefaultBrowser(),
    "failed",
  );
  const ignored = fakeRun({
    "xdg-settings set default-web-browser com.example.browser.desktop": { code: 0, stdout: "" },
    "xdg-settings get default-web-browser": { code: 0, stdout: "firefox.desktop\n" },
  });
  assertEquals(
    await createDefaultBrowser({ identifier: id, os: "linux", run: ignored.run })
      .setDefaultBrowser(),
    "failed",
  );
  const missing = fakeRun({ "xdg-settings": new Deno.errors.NotFound("xdg-settings") });
  const api = createDefaultBrowser({ identifier: id, os: "linux", run: missing.run });
  assertEquals(await api.setDefaultBrowser(), "unsupported");
  assertEquals(await api.isDefaultBrowser(), false);
});

Deno.test("linux: getSchemeOwner asks xdg-mime for the scheme handler; errors keep their code", async () => {
  const { run, calls } = fakeRun({
    "xdg-mime query default x-scheme-handler/https": { code: 0, stdout: "firefox.desktop\n" },
    "xdg-mime query default x-scheme-handler/gopher": { code: 0, stdout: "\n" },
  });
  const api = createDefaultBrowser({ identifier: "com.example.browser", os: "linux", run });
  assertEquals(await api.getSchemeOwner("https"), "firefox.desktop");
  assertEquals(await api.getSchemeOwner("gopher"), null);
  assertEquals(await api.getSchemeOwner("mailto"), null, "a failing query reads no handler");
  assertEquals(calls[0], "xdg-mime query default x-scheme-handler/https");
  const missing = fakeRun({ "xdg-mime": new Deno.errors.NotFound("xdg-mime") });
  const unsupported = await assertRejects(
    () =>
      createDefaultBrowser({ identifier: "a.b", os: "linux", run: missing.run }).getSchemeOwner(
        "http",
      ),
    DesktopCapError,
  );
  assertEquals(unsupported.code, "unsupported");
  const denied = fakeRun({ "xdg-mime": new Deno.errors.NotCapable("Requires run access") });
  const forbidden = await assertRejects(
    () =>
      createDefaultBrowser({ identifier: "a.b", os: "linux", run: denied.run }).getSchemeOwner(
        "http",
      ),
    DesktopCapError,
  );
  assertEquals(forbidden.code, "forbidden");
  const broken = fakeRun({ "xdg-mime": new Error("spawn failed") });
  const failed = await assertRejects(
    () =>
      createDefaultBrowser({ identifier: "a.b", os: "linux", run: broken.run }).getSchemeOwner(
        "http",
      ),
    DesktopCapError,
  );
  assertEquals(failed.code, "failed");
});

Deno.test("windows: unsupported, never a call to the OS", async () => {
  const api = createDefaultBrowser({
    identifier: "com.example.browser",
    os: "windows",
    dlopen: () => {
      throw new Error("no FFI on Windows");
    },
    run: () => Promise.reject(new Error("no programs on Windows")),
  });
  assertEquals(await api.setDefaultBrowser(), "unsupported");
  assertEquals(await api.isDefaultBrowser(), false);
  assertEquals(
    (await assertRejects(() => api.getSchemeOwner("http"), DesktopCapError)).code,
    "unsupported",
  );
  assertEquals(
    (await assertRejects(() => api.getSchemeOwner(""), DesktopCapError)).code,
    "validation",
  );
});

Deno.test("browserSchemeArg: trims, drops one trailing colon, lower-cases; refuses anything else", () => {
  assertEquals(browserSchemeArg(" HTTPS: "), "https");
  assertEquals(browserSchemeArg("web+app"), "web+app");
  for (const bad of [undefined, 1, "", "1http", "a b", "http//", "x".repeat(65)]) {
    assertThrows(() => browserSchemeArg(bad), DesktopCapError);
  }
});

// ---------------------------------------------------------------------------------------------
// The capability and the page calls
// ---------------------------------------------------------------------------------------------

Deno.test("capability: set / owner / isDefault, each declaring the OS's permissions", async () => {
  const ls = fakeLaunchServices({ http: "com.apple.safari", https: "com.apple.safari" });
  const cap = defaultBrowserCapability({
    identifier: "com.example.browser",
    os: "darwin",
    dlopen: ls.dlopen,
  });
  assertEquals(cap.name, "defaultBrowser");
  const c = {} as DesktopCapCtx;
  assertEquals(await cap.methods.set.handler({}, c), { result: "prompted" });
  assertEquals(await cap.methods.owner.handler({ scheme: "https" }, c), {
    owner: "com.apple.safari",
  });
  assertEquals(await cap.methods.isDefault.handler({}, c), { isDefault: false });
  for (const m of Object.values(cap.methods)) {
    assertEquals(m.permissions, { ffi: [CORE_SERVICES_PATH, CORE_FOUNDATION_PATH] });
  }
  const linux = defaultBrowserCapability({ identifier: "a.b", os: "linux", run: fakeRun({}).run });
  assertEquals(linux.methods.set.permissions, { run: ["xdg-settings", "xdg-mime"] });
});

/** Run `fn` with a fake desktop runtime serving `caps`. */
async function inDesktop(
  caps: Record<string, Record<string, FakeMethod>>,
  fn: (rt: ReturnType<typeof createFakeDesktopRuntime>) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

Deno.test("page: setDefaultBrowser / getSchemeOwner / isDefaultBrowser go to the defaultBrowser capability", async () => {
  let result: unknown = "prompted";
  await inDesktop({
    defaultBrowser: {
      set: () => ({ result }),
      owner: (a) => ({
        owner: (a as { scheme: string }).scheme === "http" ? "com.apple.safari" : null,
      }),
      isDefault: () => ({ isDefault: true }),
    },
    app: { capabilities: () => ({ browserLinks: true }) },
  }, async (rt) => {
    assertEquals(await setDefaultBrowser(), "prompted");
    result = "something new";
    assertEquals(await setDefaultBrowser(), "failed", "an unknown answer reads failed");
    assertEquals(await getSchemeOwner("http"), "com.apple.safari");
    assertEquals(await getSchemeOwner("mailto"), null);
    assertEquals(await isDefaultBrowser(), true);
    assertEquals((await appCapabilities()).browserLinks, true);
    assertEquals(
      rt.calls.filter((c) => c.cap === "defaultBrowser").map((c) => [c.method, c.args]),
      [["set", {}], ["set", {}], ["owner", { scheme: "http" }], ["owner", { scheme: "mailto" }], [
        "isDefault",
        {},
      ]],
    );
  });
});
